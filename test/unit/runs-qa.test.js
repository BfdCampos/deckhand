import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startDeckhand } from '../helpers/deckhand.js';
import { request, postJson } from '../helpers/http.js';
import { waitFor } from '../helpers/util.js';
import claude from '../../src/server/agents/claude.js';
import codex from '../../src/server/agents/codex.js';

const state = async (srv) => (await request(srv.port, { path: '/api/state' })).json;
const current = async (srv) => (await request(srv.port, { path: '/api/runs/current' })).json;
const settled = (srv) => waitFor(async () => {
  const r = await current(srv);
  return r && r.status !== 'running' ? r : null;
}, { timeout: 8000 });

describe('QA PR3/PR4 server fixes', () => {
  let srv;
  afterEach(async () => { await srv?.dispose(); srv = null; });

  test('M1 opening or closing a deck is refused while an edit run holds it', async () => {
    srv = await startDeckhand({ deck: 'test/fixtures/decks/basic.html', scenario: 'hang' });
    const other = path.join(path.dirname(srv.deckPath), 'other.html');
    fs.writeFileSync(other, '<section class="slide"><h1>Other</h1></section>');
    const { deck } = await state(srv);
    await postJson(srv.port, '/api/notes', { deckId: deck.deckId, op: 'add', note: { text: 'Bolder', aiId: 'dh1', targetTag: 'h1' } });
    const run = await postJson(srv.port, '/api/runs', { kind: 'edit', scope: 'all' });
    assert.equal(run.status, 200, run.text);

    const open = await postJson(srv.port, '/api/deck/open', { path: other });
    assert.equal(open.status, 423);
    assert.equal(open.json.error.code, 'run_active');
    assert.match(open.json.error.message, /agent/i);
    const close = await postJson(srv.port, '/api/deck/close', { deckId: deck.deckId });
    assert.equal(close.status, 423);
    assert.equal((await state(srv)).deck.deckId, deck.deckId, 'still bound to the run deck');

    assert.equal((await postJson(srv.port, `/api/runs/${run.json.id}/stop`, {})).status, 200);
    const done = await settled(srv);
    assert.equal(done.status, 'stopped');
    assert.equal(done.canRevert, true);
    assert.equal((await postJson(srv.port, '/api/deck/open', { path: other })).status, 200);
  });

  test('M1 opening a deck during a create run is allowed', async () => {
    srv = await startDeckhand({ scenario: 'hang' });
    const deck = path.join(srv.home, 'mine.html');
    fs.writeFileSync(deck, '<section class="slide"><h1>Mine</h1></section>');
    const run = await postJson(srv.port, '/api/runs', { kind: 'create', description: 'A deck about tea' });
    assert.equal(run.status, 200, run.text);
    assert.equal((await postJson(srv.port, '/api/deck/open', { path: deck })).status, 200);
    await postJson(srv.port, `/api/runs/${run.json.id}/stop`, {});
    await settled(srv);
  });

  test('m2 an unwritable ~/Deckhand gives human copy with no staging paths', async () => {
    srv = await startDeckhand();
    const dir = path.join(srv.home, 'Deckhand');
    fs.mkdirSync(dir);
    fs.chmodSync(dir, 0o555);
    try {
      const run = await postJson(srv.port, '/api/runs', { kind: 'create', description: 'A deck about tea' });
      const error = run.status === 200 ? (await settled(srv)).error : run.json.error.message;
      assert.equal(error, "Deckhand can't write to ~/Deckhand. Check its permissions.");
    } finally {
      fs.chmodSync(dir, 0o755);
    }
  });

  test('m3 ~/Deckhand existing as a file gives a 400 with human copy', async () => {
    srv = await startDeckhand();
    fs.writeFileSync(path.join(srv.home, 'Deckhand'), 'not a folder');
    const run = await postJson(srv.port, '/api/runs', { kind: 'create', description: 'A deck about tea' });
    assert.equal(run.status, 400);
    assert.equal(run.json.error.code, 'decks_dir_not_folder');
    assert.equal(run.json.error.message, "~/Deckhand isn't a folder. Rename or move that file, then try again.");
    assert.ok(!srv.output().includes('EEXIST'));
  });

  test('m5 the create target accepts a long description by POST', async () => {
    srv = await startDeckhand();
    const description = 'A deck about tea ' + 'and more words '.repeat(2000);
    const res = await postJson(srv.port, '/api/create/target', { description });
    assert.equal(res.status, 200, res.text);
    assert.equal(res.json.display, '~/Deckhand/tea-more-words-more-words-more.html');
    const get = await request(srv.port, { path: '/api/create/target?description=' + encodeURIComponent('A deck about tea') });
    assert.equal(get.json.display, '~/Deckhand/tea.html');
  });

  test('nit /api/runs/current is null when idle', async () => {
    srv = await startDeckhand();
    const res = await request(srv.port, { path: '/api/runs/current' });
    assert.equal(res.status, 200);
    assert.equal(res.text, 'null');
  });
});

describe('nit the final activity line is not doubled', () => {
  test('claude: a result equal to the last text adds no line', () => {
    const p = claude.createParser({ cwd: '/tmp' });
    const events = [
      ...p.line(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'I made a two-slide deck.' }] } })),
      ...p.line(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'I made a two-slide deck.' })),
    ];
    assert.deepEqual(events.map((e) => [e.kind, e.text]), [['text', 'I made a two-slide deck.']]);
    assert.deepEqual(p.finish(), { ok: true, text: 'I made a two-slide deck.' });
  });

  test('claude: a different result still shows', () => {
    const p = claude.createParser({ cwd: '/tmp' });
    p.line(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Working on it.' }] } }));
    assert.deepEqual(p.line(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'All done.' })).map((e) => e.text), ['All done.']);
  });

  test('codex: turn.completed after the final message adds no line', () => {
    const p = codex.createParser({ cwd: '/tmp' });
    const events = [
      ...p.line(JSON.stringify({ type: 'item.completed', item: { id: 'm1', type: 'agent_message', text: 'Deck written.' } })),
      ...p.line(JSON.stringify({ type: 'turn.completed', usage: {} })),
    ];
    assert.deepEqual(events.map((e) => [e.kind, e.text]), [['text', 'Deck written.']]);
    assert.deepEqual(p.finish(), { ok: true, text: 'Deck written.' });
  });
});
