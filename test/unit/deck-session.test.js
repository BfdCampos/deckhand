import { test, describe, beforeEach, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import WebSocket from 'ws';
import { createDeckSession } from '../../src/server/deck-session.js';
import { createNotes } from '../../src/server/notes.js';
import { tempDir, removeTempDirs } from '../helpers/fakes.js';
import { startDeckhand } from '../helpers/deckhand.js';

after(removeTempDirs);

const DECK = '<!doctype html>\r\n<html><head><title>T</title></head>\r\n<body>\r\n<section class="slide">\r\n  <h1>Title</h1>\r\n  <p>Intro <b>text</b></p>\r\n  <img src="a.png">\r\n</section>\r\n<section class="slide"><h2>Two</h2></section>\r\n</body></html>\r\n';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, timeout = 2000) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeout) throw new Error('timed out');
    await sleep(20);
  }
}

async function makeSession(html = DECK, name = 'deck.html') {
  const dir = tempDir('deckhand-session-');
  const file = path.join(dir, name);
  await fsp.writeFile(file, html);
  const events = [];
  const hub = { broadcast: (e) => events.push(e) };
  const notes = createNotes({ hub });
  const session = createDeckSession({ hub, store: null, notes });
  return { dir, file, events, notes, session };
}

function idOf(source, re) {
  const m = re.exec(source);
  assert.ok(m, `no match for ${re}`);
  return m[1];
}

describe('deck-session open', () => {
  test('validates the path with error codes', async () => {
    const { dir, session } = await makeSession();
    await fsp.writeFile(path.join(dir, 'notes.txt'), 'hi');
    await fsp.writeFile(path.join(dir, 'empty.html'), '  \n');
    await fsp.writeFile(path.join(dir, 'locked.html'), '<p>x</p>');
    await fsp.chmod(path.join(dir, 'locked.html'), 0o000);
    const cases = [['missing.html', 'not_found'], ['.', 'is_dir'], ['notes.txt', 'not_html'], ['empty.html', 'empty'], ['locked.html', 'unreadable']];
    for (const [name, code] of cases) {
      await assert.rejects(session.open(path.join(dir, name)), (e) => e.status === 400 && e.code === code, name);
    }
    assert.equal(session.meta(), null);
  });

  test('opening anchors in memory only and reports meta', async () => {
    const { file, session, events } = await makeSession();
    const meta = await session.open(file);
    assert.equal(await fsp.readFile(file, 'utf8'), DECK);
    assert.match(session.servedSource(), /<h1 data-ai-id="dh\d+">Title<\/h1>/);
    assert.equal(meta.path, file);
    assert.equal(meta.name, 'deck.html');
    assert.equal(meta.url, '/deckroot/deck.html');
    assert.equal(meta.readOnly, false);
    assert.equal(meta.hasSlides, true);
    assert.match(meta.deckId, /^[a-z0-9-]{8,}$/);
    assert.equal(meta.notesPath, file.replace(/\.html$/, '.deckhand.json'));
    assert.equal(meta.workOrderPath, file.replace(/\.html$/, '.deckhand.md'));
    assert.equal(events.find((e) => e.type === 'deck').deck.deckId, meta.deckId);
    await session.close();
  });

  test('a deck with no slides says so', async () => {
    const { file, session } = await makeSession('<p>Just a page</p>');
    assert.equal((await session.open(file)).hasSlides, false);
    await session.close();
  });

  test('a non UTF-8 deck opens read-only so its bytes are never rewritten', async () => {
    const { dir, session } = await makeSession();
    const file = path.join(dir, 'latin.html');
    await fsp.writeFile(file, Buffer.from([0x3c, 0x70, 0x3e, 0x63, 0x61, 0x66, 0xe9, 0x3c, 0x2f, 0x70, 0x3e]));
    assert.equal((await session.open(file)).readOnly, true);
    await session.close();
  });

  test('a read-only file refuses ops with 403', async () => {
    const { file, session } = await makeSession();
    await fsp.chmod(file, 0o444);
    const meta = await session.open(file);
    assert.equal(meta.readOnly, true);
    const h1 = idOf(session.servedSource(), /<h1 data-ai-id="(dh\d+)">/);
    await assert.rejects(session.applyOps(meta.deckId, 't1', meta.rev, [{ type: 'setInner', aiId: h1, tag: 'h1', before: 'Title', after: 'X' }]), (e) => e.status === 403 && e.code === 'read_only');
    await session.flushAnchors();
    assert.equal(await fsp.readFile(file, 'utf8'), DECK);
    await session.close();
  });
});

describe('deck-session ops', () => {
  let s;
  let meta;
  let h1;
  let p;
  let img;
  let section;

  beforeEach(async () => {
    s = await makeSession();
    meta = await s.session.open(s.file);
    const src = s.session.servedSource();
    h1 = idOf(src, /<h1 data-ai-id="(dh\d+)">/);
    p = idOf(src, /<p data-ai-id="(dh\d+)">/);
    img = idOf(src, /<img data-ai-id="(dh\d+)"/);
    section = idOf(src, /<section data-ai-id="(dh\d+)" class="slide">\r\n {2}<h1/);
  });

  afterEach(async () => { await s.session.close(); });

  const apply = (ops, tab = 't1', rev = s.session.meta().rev) => s.session.applyOps(meta.deckId, tab, rev, ops);

  test('AC-27 the first op writes anchors plus exactly that change', async () => {
    const anchored = s.session.servedSource();
    const res = await apply([{ opId: 'o1', type: 'setInner', aiId: h1, tag: 'h1', before: 'Title', after: 'Better title' }]);
    assert.deepEqual(res.results, [{ opId: 'o1', aiId: h1 }]);
    assert.ok(res.rev > meta.rev);
    const disk = await fsp.readFile(s.file, 'utf8');
    assert.equal(disk, anchored.replace('>Title<', '>Better title<'));
    assert.equal(disk.replace(/ data-ai-id="dh\d+"/g, ''), DECK.replace('Title', 'Better title'));
    const ev = s.events.filter((e) => e.type === 'deck-changed').at(-1);
    assert.deepEqual(ev, { type: 'deck-changed', deckId: meta.deckId, rev: res.rev, source: 'tab', byTab: 't1' });
  });

  test('flushAnchors writes the anchored source once', async () => {
    await s.session.flushAnchors();
    assert.equal(await fsp.readFile(s.file, 'utf8'), s.session.servedSource());
  });

  test('AC-28 a move updates the style attribute and records the layout tweak', async () => {
    const res = await apply([{ type: 'setStyle', aiId: p, tag: 'p', props: { transform: 'translate(100px, 0px)' } }]);
    assert.equal(res.results[0].style, 'transform: translate(100px, 0px);');
    const disk = await fsp.readFile(s.file, 'utf8');
    assert.ok(disk.includes(`<p data-ai-id="${p}" style="transform: translate(100px, 0px);">`));
    assert.deepEqual(s.notes.tweaks()[p], { kind: 'move', tag: 'p', dx: 100, dy: 0 });
    assert.match(await fsp.readFile(s.file.replace('.html', '.deckhand.md'), 'utf8'), new RegExp(`- ${p} \\(p\\): moved by \\(100, 0\\) px`));
  });

  test('insert returns the new anchor and the batch is atomic', async () => {
    const res = await apply([{ opId: 'a', type: 'insert', parentAiId: section, html: '<p class="dh-text">New text</p>' }]);
    const newId = res.results[0].aiId;
    assert.match(newId, /^dh\d+$/);
    assert.ok((await fsp.readFile(s.file, 'utf8')).includes(`<img data-ai-id="${img}" src="a.png">\r\n<p data-ai-id="${newId}" class="dh-text">New text</p></section>`));
    const before = await fsp.readFile(s.file, 'utf8');
    const rev = s.session.meta().rev;
    await assert.rejects(apply([
      { opId: 'b', type: 'setInner', aiId: h1, tag: 'h1', before: 'Title', after: 'Changed' },
      { opId: 'c', type: 'remove', aiId: 'dh999', tag: 'p' },
    ]), (e) => e.code === 'anchor_missing');
    assert.equal(await fsp.readFile(s.file, 'utf8'), before);
    assert.equal(s.session.meta().rev, rev);
  });

  test('script-owned text is refused and nothing is written', async () => {
    await assert.rejects(apply([{ type: 'setInner', aiId: h1, tag: 'h1', before: 'Set by script', after: 'x' }]), (e) => e.status === 409 && e.code === 'script_owned');
    assert.equal(await fsp.readFile(s.file, 'utf8'), DECK);
  });

  test('wrong deck id and bad payloads are refused', async () => {
    await assert.rejects(s.session.applyOps('other', 't1', 0, [{ type: 'remove', aiId: h1, tag: 'h1' }]), (e) => e.status === 409 && e.code === 'deck_closed');
    await assert.rejects(s.session.applyOps(meta.deckId, 't1', 'x', [{ type: 'remove', aiId: h1 }]), (e) => e.status === 400);
    await assert.rejects(s.session.applyOps(meta.deckId, 't1', 0, []), (e) => e.status === 400);
  });

  test('AC-34 undo in reverse order restores the file exactly, redo replays it', async () => {
    const anchored = s.session.servedSource();
    const steps = [
      { opId: 'add', type: 'insert', parentAiId: section, html: '<p>Added</p>' },
      { opId: 'text', type: 'setInner', aiId: h1, tag: 'h1', before: 'Title', after: 'Edited' },
      { opId: 'move', type: 'setStyle', aiId: p, tag: 'p', props: { transform: 'translate(10px, 20px)' } },
      { opId: 'resize', type: 'setStyle', aiId: img, tag: 'img', props: { width: '240px', height: '120px' } },
      { opId: 'delete', type: 'remove', aiId: p, tag: 'p' },
    ];
    const states = [anchored];
    for (const op of steps) {
      await apply([op]);
      states.push(await fsp.readFile(s.file, 'utf8'));
    }
    for (let i = steps.length - 1; i >= 0; i--) {
      await s.session.undo(meta.deckId, 't1', steps[i].opId);
      assert.equal(await fsp.readFile(s.file, 'utf8'), states[i], `after undoing ${steps[i].opId}`);
    }
    assert.deepEqual(s.notes.tweaks(), {});
    for (let i = 0; i < steps.length; i++) {
      await s.session.redo(meta.deckId, 't1', steps[i].opId);
      assert.equal(await fsp.readFile(s.file, 'utf8'), states[i + 1], `after redoing ${steps[i].opId}`);
    }
    assert.deepEqual(Object.keys(s.notes.tweaks()).sort(), [img, p].sort());
  });

  test('undo out of order shifts past later edits', async () => {
    const anchored = s.session.servedSource();
    await apply([{ opId: 'one', type: 'setInner', aiId: h1, tag: 'h1', before: 'Title', after: 'A much longer title than before' }]);
    await apply([{ opId: 'two', type: 'setInner', aiId: p, tag: 'p', before: 'Intro <b>text</b>', after: 'Short' }]);
    await s.session.undo(meta.deckId, 't1', 'one');
    assert.equal(await fsp.readFile(s.file, 'utf8'), anchored.replace('Intro <b>text</b>', 'Short'));
  });

  test('undo that overlaps a later edit is refused', async () => {
    await apply([{ opId: 'one', type: 'setInner', aiId: h1, tag: 'h1', before: 'Title', after: 'Edited' }]);
    await apply([{ opId: 'two', type: 'remove', aiId: section, tag: 'section' }]);
    await assert.rejects(s.session.undo(meta.deckId, 't1', 'one'), (e) => e.status === 409 && e.code === 'cannot_undo');
    await assert.rejects(s.session.undo(meta.deckId, 't2', 'two'), (e) => e.code === 'cannot_undo', 'other tabs cannot undo it');
    await assert.rejects(s.session.redo(meta.deckId, 't1', 'two'), (e) => e.code === 'cannot_undo', 'not undone yet');
  });

  test('lock refuses ops and undo with 423', async () => {
    await apply([{ opId: 'one', type: 'setInner', aiId: h1, tag: 'h1', before: 'Title', after: 'Edited' }]);
    s.session.lock('run1');
    assert.equal(s.session.isLocked(), true);
    await assert.rejects(apply([{ type: 'remove', aiId: p, tag: 'p' }]), (e) => e.status === 423 && e.code === 'run_active');
    await assert.rejects(s.session.undo(meta.deckId, 't1', 'one'), (e) => e.status === 423);
    s.session.unlock();
    await s.session.undo(meta.deckId, 't1', 'one');
  });

  test('our own writes are not reported as external', async () => {
    await apply([{ type: 'setInner', aiId: h1, tag: 'h1', before: 'Title', after: 'Edited' }]);
    await sleep(400);
    assert.equal(s.events.filter((e) => e.type === 'deck-changed' && e.source === 'external').length, 0);
  });

  for (const [delay, how] of [[0, 'write'], [20, 'write'], [50, 'write'], [100, 'write'], [300, 'write'], [700, 'write'], [0, 'rename'], [50, 'rename'], [400, 'rename']]) {
    test(`an external ${how} ${delay} ms after a save is still detected`, async () => {
      await apply([{ type: 'setInner', aiId: h1, tag: 'h1', before: 'Title', after: 'Saved by Deckhand' }]);
      if (delay) await sleep(delay);
      const text = DECK.replace('Title', `External ${delay}`);
      if (how === 'write') await fsp.writeFile(s.file, text);
      else { await fsp.writeFile(s.file + '.x', text); await fsp.rename(s.file + '.x', s.file); }
      await waitFor(() => s.session.servedSource().includes(`External ${delay}`), 1500);
      assert.ok(s.events.some((e) => e.type === 'deck-changed' && e.source === 'external'));
    });
  }

  test('an external write reloads, clears undo and rejects stale ops', async () => {
    await apply([{ opId: 'one', type: 'setInner', aiId: h1, tag: 'h1', before: 'Title', after: 'Edited' }]);
    const staleRev = s.session.meta().rev;
    const tmp = s.file + '.editor-tmp';
    await fsp.writeFile(tmp, DECK.replace('Title', 'From the editor'));
    await fsp.rename(tmp, s.file);
    const ev = await waitFor(() => s.events.find((e) => e.type === 'deck-changed' && e.source === 'external'));
    assert.ok(ev.rev > staleRev);
    assert.match(s.session.servedSource(), /<h1 data-ai-id="dh\d+">From the editor<\/h1>/);
    await assert.rejects(apply([{ type: 'remove', aiId: p, tag: 'p' }], 't1', staleRev), (e) => e.status === 409 && e.code === 'deck_changed');
    await assert.rejects(s.session.undo(meta.deckId, 't1', 'one'), (e) => e.code === 'cannot_undo');
    const fresh = idOf(s.session.servedSource(), /<p data-ai-id="(dh\d+)">/);
    await apply([{ type: 'remove', aiId: fresh, tag: 'p' }], 't1', ev.rev);
    await fsp.appendFile(s.file, '<!-- again -->');
    await waitFor(() => s.events.filter((e) => e.type === 'deck-changed' && e.source === 'external').length === 2);
  });

  test('AC-38 deleting the file reports deck-missing and restoring it reloads', async () => {
    await fsp.rm(s.file);
    await waitFor(() => s.events.find((e) => e.type === 'deck-missing' && e.deckId === meta.deckId));
    assert.equal(s.session.meta().missing, true);
    await assert.rejects(apply([{ type: 'remove', aiId: p, tag: 'p' }]), (e) => e.status === 409 && e.code === 'deck_missing');
    await fsp.writeFile(s.file, DECK);
    await waitFor(() => s.session.meta().missing === false);
  });

  test('writeExternal writes the agent bytes and reloads', async () => {
    const changed = DECK.replace('Two', 'Agent wrote this');
    await s.session.writeExternal(Buffer.from(changed), 'agent');
    assert.equal(await fsp.readFile(s.file, 'utf8'), changed);
    assert.ok(s.session.servedSource().includes('Agent wrote this'));
    assert.equal(s.events.filter((e) => e.type === 'deck-changed').at(-1).source, 'agent');
    assert.deepEqual(await s.session.readDisk(), Buffer.from(changed));
    await sleep(300);
    assert.equal(s.events.filter((e) => e.type === 'deck-changed' && e.source === 'external').length, 0);
  });

  test('reloadFromDisk picks up restored bytes', async () => {
    await apply([{ type: 'setInner', aiId: h1, tag: 'h1', before: 'Title', after: 'Edited' }]);
    s.session.lock('r');
    await fsp.writeFile(s.file, DECK);
    await s.session.reloadFromDisk('revert');
    assert.match(s.session.servedSource(), />Title</);
    assert.ok(s.events.some((e) => e.type === 'deck-changed' && e.source === 'revert'));
    s.session.unlock();
  });

  test('close unbinds and later ops get deck_closed', async () => {
    await s.session.close();
    assert.equal(s.session.meta(), null);
    assert.deepEqual(s.events.at(-1), { type: 'deck', deck: null });
    await assert.rejects(s.session.applyOps(meta.deckId, 't1', 0, [{ type: 'remove', aiId: p, tag: 'p' }]), (e) => e.code === 'deck_closed');
  });
});

describe('deck-session file handling', () => {
  test('writes keep the file mode and write through symlinks', async () => {
    const { dir, file, session } = await makeSession();
    await fsp.chmod(file, 0o640);
    const link = path.join(dir, 'link.html');
    await fsp.symlink(file, link);
    const meta = await session.open(link);
    const h1 = idOf(session.servedSource(), /<h1 data-ai-id="(dh\d+)">/);
    await session.applyOps(meta.deckId, 't', meta.rev, [{ type: 'setInner', aiId: h1, tag: 'h1', before: 'Title', after: 'Linked' }]);
    assert.equal((await fsp.lstat(link)).isSymbolicLink(), true);
    assert.ok((await fsp.readFile(file, 'utf8')).includes('Linked'));
    assert.equal((await fsp.stat(file)).mode & 0o777, 0o640);
    assert.equal(fs.readdirSync(dir).some((f) => f.includes('deckhand-tmp')), false);
    await session.close();
  });

  test('a BOM deck keeps its BOM after an edit', async () => {
    const html = '﻿<!doctype html><body><section class="slide"><h1>Hi</h1></section></body>';
    const { file, session } = await makeSession(html);
    const meta = await session.open(file);
    const h1 = idOf(session.servedSource(), /<h1 data-ai-id="(dh\d+)">/);
    await session.applyOps(meta.deckId, 't', meta.rev, [{ type: 'setInner', aiId: h1, tag: 'h1', before: 'Hi', after: 'Hello' }]);
    const buf = await fsp.readFile(file);
    assert.deepEqual([...buf.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
    await session.close();
  });
});

describe('deck routes over HTTP', () => {
  let dh;
  let origin;

  const post = (p, body, headers = {}) => fetch(dh.url + p, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin, ...headers },
    body: JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, json: await r.json() }));

  beforeEach(async () => {
    dh = await startDeckhand({ deck: 'test/fixtures/decks/scripted.html', agents: [] });
    origin = dh.url;
  });

  afterEach(async () => { await dh.dispose(); });

  test('state, served source, ops, undo and notes work end to end', async () => {
    const state = await (await fetch(dh.url + '/api/state')).json();
    const deck = state.deck;
    assert.equal(deck.path, dh.deckPath);
    assert.equal(state.deckPath, dh.deckPath, 'legacy fields kept until PR4');
    const served = await (await fetch(dh.url + deck.url)).text();
    assert.match(served, /<h2 data-ai-id="(dh\d+)">Plain slide<\/h2>/);
    assert.equal(fs.readFileSync(dh.deckPath, 'utf8').includes('data-ai-id'), false, 'viewing does not write');
    const h2 = /<h2 data-ai-id="(dh\d+)">/.exec(served)[1];

    const ops = await post('/api/deck/ops', { deckId: deck.deckId, tabId: 'tab1', baseRev: deck.rev, ops: [{ opId: 'o1', type: 'setInner', aiId: h2, tag: 'h2', before: 'Plain slide', after: 'Edited slide' }] });
    assert.equal(ops.status, 200, JSON.stringify(ops.json));
    assert.deepEqual(ops.json.results, [{ opId: 'o1', aiId: h2 }]);
    assert.ok(fs.readFileSync(dh.deckPath, 'utf8').includes('>Edited slide<'));

    const clock = /<h1 data-ai-id="(dh\d+)" id="clock">/.exec(served)[1];
    const owned = await post('/api/deck/ops', { deckId: deck.deckId, tabId: 'tab1', baseRev: ops.json.rev, ops: [{ type: 'setInner', aiId: clock, tag: 'h1', before: 'Set by script', after: 'Mine' }] });
    assert.equal(owned.status, 409);
    assert.equal(owned.json.error.code, 'script_owned');

    const undo = await post('/api/deck/undo', { deckId: deck.deckId, tabId: 'tab1', opId: 'o1' });
    assert.equal(undo.status, 200);
    assert.ok(fs.readFileSync(dh.deckPath, 'utf8').includes('>Plain slide<'));
    const redo = await post('/api/deck/redo', { deckId: deck.deckId, tabId: 'tab1', opId: 'o1' });
    assert.equal(redo.status, 200);

    const add = await post('/api/notes', { deckId: deck.deckId, op: 'add', note: { aiId: h2, targetTag: 'h2', targetText: 'Plain slide', text: 'Make it pop', slide: 2 } });
    assert.equal(add.status, 200);
    assert.equal(add.json.notes.length, 1);
    const listed = await (await fetch(dh.url + '/api/notes')).json();
    assert.equal(listed.notes[0].text, 'Make it pop');
    assert.equal(listed.deckId, deck.deckId);
    const md = fs.readFileSync(dh.deckPath.replace('.html', '.deckhand.md'), 'utf8');
    assert.ok(md.includes('Make it pop'));

    const stale = await post('/api/notes', { deckId: 'old', op: 'add', note: { text: 'x' } });
    assert.equal(stale.status, 409);
    assert.equal(stale.json.error.code, 'deck_closed');
  });

  test('adding a note writes the anchors so the work order matches the file', async () => {
    const state = await (await fetch(dh.url + '/api/state')).json();
    const served = await (await fetch(dh.url + state.deck.url)).text();
    await fetch(dh.url + '/api/notes');
    assert.equal(fs.readFileSync(dh.deckPath, 'utf8').includes('data-ai-id'), false, 'viewing does not write');
    const h2 = /<h2 data-ai-id="(dh\d+)">/.exec(served)[1];
    const add = await post('/api/notes', { deckId: state.deck.deckId, op: 'add', note: { aiId: h2, targetTag: 'h2', text: 'Bigger' } });
    assert.equal(add.status, 200);
    assert.ok(fs.readFileSync(dh.deckPath, 'utf8').includes(`<h2 data-ai-id="${h2}">`));
  });

  test('copying the prompt writes the anchors too', async () => {
    const state = await (await fetch(dh.url + '/api/state')).json();
    const res = await post('/api/implement', {});
    assert.equal(res.status, 200);
    assert.ok(fs.readFileSync(dh.deckPath, 'utf8').includes('data-ai-id'));
    assert.ok(state.deck);
  });

  test('deck routes refuse foreign origins and non-JSON', async () => {
    const state = await (await fetch(dh.url + '/api/state')).json();
    const body = { deckId: state.deck.deckId, tabId: 't', baseRev: state.deck.rev, ops: [{ type: 'remove', aiId: 'dh1', tag: 'section' }] };
    const evil = await post('/api/deck/ops', body, { Origin: 'https://evil.example' });
    assert.equal(evil.status, 403);
    const form = await fetch(dh.url + '/api/deck/ops', { method: 'POST', headers: { 'Content-Type': 'text/plain', Origin: origin }, body: JSON.stringify(body) });
    assert.equal(form.status, 415);
    assert.equal(fs.readFileSync(dh.deckPath, 'utf8').includes('data-ai-id'), false);
  });

  test('open and close over HTTP, with events on the socket', async () => {
    const ws = new WebSocket(dh.url.replace('http', 'ws') + '/ws', { headers: { Origin: origin } });
    const events = [];
    ws.on('message', (m) => events.push(JSON.parse(m)));
    await new Promise((r) => ws.on('open', r));
    await waitFor(() => events.find((e) => e.type === 'hello'));
    const hello = events.find((e) => e.type === 'hello');
    assert.ok(hello.state.deck.deckId);
    assert.ok(events.find((e) => e.type === 'notes'), 'notes snapshot on connect');

    const other = path.join(path.dirname(dh.deckPath), 'other.html');
    fs.writeFileSync(other, '<section class="slide"><h1>Other</h1></section>');
    const opened = await post('/api/deck/open', { path: other });
    assert.equal(opened.status, 200);
    assert.equal(opened.json.name, 'other.html');
    await waitFor(() => events.find((e) => e.type === 'deck' && e.deck?.name === 'other.html'));
    ws.send(JSON.stringify({ type: 'save-html', html: '<p>pwned</p>' }));
    await sleep(200);
    assert.ok(!fs.readFileSync(other, 'utf8').includes('pwned'), 'legacy socket saves are gone');
    const bad = await post('/api/deck/open', { path: path.join(dh.home, 'nope.html') });
    assert.equal(bad.status, 400);
    assert.equal(bad.json.error.code, 'not_found');
    const closed = await post('/api/deck/close', { deckId: opened.json.deckId });
    assert.equal(closed.status, 200);
    await waitFor(() => events.find((e) => e.type === 'deck' && e.deck === null));
    ws.close();
  });
});
