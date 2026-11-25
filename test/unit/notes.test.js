import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createNotes } from '../../src/server/notes.js';

async function setup({ readOnly = false } = {}) {
  const dir = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'deckhand-notes-')));
  const deckPath = path.join(dir, 'deck.html');
  await fsp.writeFile(deckPath, '<h1>x</h1>');
  const events = [];
  const notes = createNotes({ hub: { broadcast: (e) => events.push(e) } });
  const meta = { deckId: 'd1', path: deckPath, dir, name: 'deck.html', readOnly };
  await notes.bind(meta);
  const json = path.join(dir, 'deck.deckhand.json');
  const md = path.join(dir, 'deck.deckhand.md');
  return { dir, deckPath, events, notes, meta, json, md };
}

const heading = { aiId: 'dh4', targetTag: 'h2', targetText: 'What you can do by hand', scope: 'element', text: 'Make this two columns', slide: 2, docX: 640, docY: 1210 };

describe('notes', () => {
  let s;
  beforeEach(async () => { s = await setup(); });

  test('binding a deck with no sidecar writes nothing', async () => {
    assert.deepEqual(s.notes.list(), []);
    assert.deepEqual(s.notes.paths(), { json: s.json, md: s.md });
    assert.equal(fs.existsSync(s.json), false);
    assert.equal(fs.existsSync(s.md), false);
  });

  test('AC-39 add writes the json and the work order', async () => {
    const res = await s.notes.apply({ op: 'add', note: heading });
    assert.equal(res.notes.length, 1);
    const [note] = res.notes;
    assert.match(note.id, /^n_[a-z0-9]+$/);
    assert.equal(note.status, 'open');
    assert.equal(note.doneAt, null);
    assert.ok(note.createdAt && note.updatedAt);
    const json = JSON.parse(await fsp.readFile(s.json, 'utf8'));
    assert.equal(json.version, 2);
    assert.equal(json.deck, 'deck.html');
    assert.deepEqual(json.notes, res.notes);
    const md = await fsp.readFile(s.md, 'utf8');
    assert.match(md, /^# Deckhand work order: deck\.html$/m);
    assert.ok(md.includes(`- [ ] ${note.id}: heading on slide 2 (data-ai-id="dh4"), currently "What you can do by hand"\n  Make this two columns\n`), md);
    assert.ok(md.includes('tick its box by changing "- [ ]" to "- [x]"'));
    const ev = s.events.at(-1);
    assert.equal(ev.type, 'notes');
    assert.equal(ev.deckId, 'd1');
    assert.equal(ev.rev, res.rev);
    assert.deepEqual(ev.notes, res.notes);
    assert.equal(fs.readdirSync(s.dir).some((f) => f.includes('deckhand-tmp')), false);
  });

  test('AC-40 global scope says all similar elements in the work order', async () => {
    await s.notes.apply({ op: 'add', note: { ...heading, scope: 'global' } });
    const md = await fsp.readFile(s.md, 'utf8');
    assert.match(md, /all similar headings/);
    assert.equal(s.notes.list()[0].scope, 'global');
  });

  test('multi-line note text is indented so it cannot fake a tick line', async () => {
    const { notes } = await s.notes.apply({ op: 'add', note: { ...heading, text: 'line one\n- [x] n_fake: spoof' } });
    const md = await fsp.readFile(s.md, 'utf8');
    assert.ok(md.includes('  line one\n  - [x] n_fake: spoof'));
    assert.deepEqual([...s.notes.parseTicks(md)], []);
    assert.equal(notes.length, 1);
  });

  test('edit and delete', async () => {
    const { notes: [n] } = await s.notes.apply({ op: 'add', note: heading });
    const edited = await s.notes.apply({ op: 'edit', id: n.id, text: 'Three columns' });
    assert.equal(edited.notes[0].text, 'Three columns');
    assert.ok(edited.rev > 1);
    const deleted = await s.notes.apply({ op: 'delete', id: n.id });
    assert.deepEqual(deleted.notes, []);
    assert.deepEqual(JSON.parse(await fsp.readFile(s.json, 'utf8')).notes, []);
  });

  test('bad input is refused', async () => {
    await assert.rejects(s.notes.apply({ op: 'edit', id: 'n_nope', text: 'x' }), (e) => e.status === 404 && e.code === 'no_note');
    await assert.rejects(s.notes.apply({ op: 'delete', id: 'n_nope' }), (e) => e.code === 'no_note');
    await assert.rejects(s.notes.apply({ op: 'add', note: { ...heading, text: '   ' } }), (e) => e.status === 400);
    await assert.rejects(s.notes.apply({ op: 'shout' }), (e) => e.status === 400);
  });

  test('locked notes refuse changes with 423 but markDone still works', async () => {
    const { notes: [n] } = await s.notes.apply({ op: 'add', note: heading });
    s.notes.lock();
    await assert.rejects(s.notes.apply({ op: 'add', note: heading }), (e) => e.status === 423 && e.code === 'run_active');
    await assert.rejects(s.notes.apply({ op: 'edit', id: n.id, text: 'x' }), (e) => e.status === 423);
    await assert.rejects(s.notes.apply({ op: 'delete', id: n.id }), (e) => e.status === 423);
    assert.deepEqual(await s.notes.markDone([n.id], 'agent'), [n.id]);
    s.notes.unlock();
    const [done] = s.notes.list();
    assert.equal(done.status, 'done');
    assert.equal(done.doneBy, 'agent');
    assert.ok(done.doneAt);
  });

  test('parseTicks reads only ticked note lines', () => {
    const md = '# x\n\n- [x] n_abc: a\n- [ ] n_def: b\n- [X] n_ghi: c\n  - [x] n_jkl: indented\n-[x] n_mno: no space\n';
    assert.deepEqual([...s.notes.parseTicks(md)].sort(), ['n_abc', 'n_ghi']);
  });

  test('done notes leave the work order and unknown ids are ignored', async () => {
    const a = (await s.notes.apply({ op: 'add', note: heading })).notes[0];
    const b = (await s.notes.apply({ op: 'add', note: { ...heading, aiId: 'dh5', text: 'Second' } })).notes[1];
    assert.deepEqual(await s.notes.markDone([a.id, 'n_unknown'], 'agent'), [a.id]);
    const md = await fsp.readFile(s.md, 'utf8');
    assert.ok(!md.includes(a.id));
    assert.ok(md.includes(b.id));
  });

  test('renderWorkOrder can scope to one note and then leaves tweaks out', async () => {
    const a = (await s.notes.apply({ op: 'add', note: heading })).notes[0];
    await s.notes.apply({ op: 'add', note: { ...heading, text: 'Other' } });
    await s.notes.setTweak('dh5', { kind: 'move', tag: 'li', dx: 100, dy: 0 });
    const one = s.notes.renderWorkOrder({ noteIds: [a.id] });
    assert.ok(one.includes(a.id));
    assert.ok(!one.includes('Other'));
    assert.ok(!one.includes('Layout tweaks'));
    assert.ok(s.notes.renderWorkOrder().includes('Layout tweaks'));
  });

  test('AC-28 layout tweaks appear in the work order', async () => {
    await s.notes.setTweak('dh5', { kind: 'move', tag: 'li', dx: 100, dy: 0 });
    await s.notes.setTweak('dh8', { kind: 'resize', tag: 'img', w: 240, h: 240 });
    const md = await fsp.readFile(s.md, 'utf8');
    assert.ok(md.includes('## Layout tweaks'));
    assert.ok(md.includes('- dh5 (li): moved by (100, 0) px'));
    assert.ok(md.includes('- dh8 (img): resized to 240×240 px'));
    assert.deepEqual(s.notes.tweaks(), { dh5: { kind: 'move', tag: 'li', dx: 100, dy: 0 }, dh8: { kind: 'resize', tag: 'img', w: 240, h: 240 } });
    await s.notes.setTweak('dh5', null);
    assert.deepEqual(Object.keys(s.notes.tweaks()), ['dh8']);
    await s.notes.clearTweaks();
    assert.deepEqual(s.notes.tweaks(), {});
    assert.ok(!(await fsp.readFile(s.md, 'utf8')).includes('## Layout tweaks'));
  });

  test('AC-43 notes survive a rebind', async () => {
    await s.notes.apply({ op: 'add', note: heading });
    const again = createNotes({ hub: { broadcast() {} } });
    await again.bind(s.meta);
    assert.equal(again.list().length, 1);
    assert.equal(again.list()[0].text, 'Make this two columns');
  });

  test('reloadFromDisk picks up restored files', async () => {
    await s.notes.apply({ op: 'add', note: heading });
    const saved = await fsp.readFile(s.json, 'utf8');
    await s.notes.apply({ op: 'add', note: { ...heading, text: 'Later' } });
    await fsp.writeFile(s.json, saved);
    await s.notes.reloadFromDisk();
    assert.equal(s.notes.list().length, 1);
    assert.equal(s.events.at(-1).type, 'notes');
  });

  test('bind(null) unbinds', async () => {
    await s.notes.bind(null);
    assert.deepEqual(s.notes.list(), []);
    assert.equal(s.notes.paths(), null);
    await assert.rejects(s.notes.apply({ op: 'add', note: heading }), (e) => e.code === 'deck_closed');
  });
});

describe('notes migration and read-only decks', () => {
  test('v1 files load as open notes with tick-safe ids and object tweaks, and are not rewritten', async () => {
    const dir = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'deckhand-notes-')));
    const v1 = {
      notes: [
        { id: '1732451234567', aiId: 'dh2', targetTag: 'p', targetText: 'Hi', scope: 'element', text: 'Old note', slide: 1 },
        { id: 'n_keep1', aiId: 'dh3', targetTag: 'li', scope: 'global', text: 'Kept id' },
      ],
      layoutTweaks: [{ aiId: 'dh5', kind: 'move', tag: 'li', dx: 10, dy: 5 }, { aiId: 'dh8', kind: 'resize', w: 100, h: 50 }],
    };
    const json = path.join(dir, 'deck.deckhand.json');
    await fsp.writeFile(json, JSON.stringify(v1));
    const before = await fsp.readFile(json, 'utf8');
    const notes = createNotes({ hub: { broadcast() {} } });
    await notes.bind({ deckId: 'd', path: path.join(dir, 'deck.html'), dir, name: 'deck.html', readOnly: false });
    const list = notes.list();
    assert.equal(list.length, 2);
    for (const n of list) {
      assert.match(n.id, /^n_[a-z0-9]+$/);
      assert.equal(n.status, 'open');
    }
    assert.equal(list[1].id, 'n_keep1');
    assert.deepEqual(notes.tweaks(), { dh5: { kind: 'move', tag: 'li', dx: 10, dy: 5 }, dh8: { kind: 'resize', tag: 'img', w: 100, h: 50 } });
    assert.equal(await fsp.readFile(json, 'utf8'), before);
  });

  test('a corrupt sidecar loads as empty rather than crashing', async () => {
    const dir = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'deckhand-notes-')));
    await fsp.writeFile(path.join(dir, 'deck.deckhand.json'), '{nope');
    const notes = createNotes({ hub: { broadcast() {} } });
    await notes.bind({ deckId: 'd', path: path.join(dir, 'deck.html'), dir, name: 'deck.html', readOnly: false });
    assert.deepEqual(notes.list(), []);
  });

  test('read-only decks refuse note changes', async () => {
    const s = await setup({ readOnly: true });
    await assert.rejects(s.notes.apply({ op: 'add', note: heading }), (e) => e.status === 403 && e.code === 'read_only');
  });
});
