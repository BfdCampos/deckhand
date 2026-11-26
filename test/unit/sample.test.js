import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startDeckhand } from '../helpers/deckhand.js';
import { REPO } from '../helpers/fakes.js';
import { request, postJson } from '../helpers/http.js';

const TRACKED = path.join(REPO, 'samples', 'sample-deck.html');
const original = fs.readFileSync(TRACKED);
const NOW = { DECKHAND_TEST_NOW: '2026-11-26T18:02:30' };
const STAMPED = /^sample-deck-\d{4}-\d{2}-\d{2}-\d{4}(-\d+)?\.html$/;

async function editHeading(srv) {
  const { deck } = (await request(srv.port, { path: '/api/state' })).json;
  const served = (await request(srv.port, { path: deck.url })).text;
  const [, tag, aiId, text] = /<(h[12]) data-ai-id="(dh\d+)"[^>]*>([^<]+)</.exec(served);
  const res = await postJson(srv.port, '/api/deck/ops', { deckId: deck.deckId, tabId: 't', baseRev: deck.rev, ops: [{ type: 'setInner', aiId, tag, before: text, after: 'Edited in a test' }] });
  assert.equal(res.status, 200, res.text);
  return deck;
}

const openSample = (srv) => postJson(srv.port, '/api/deck/open', { path: TRACKED });

describe('"Try the sample deck" always gives a fresh copy', () => {
  let srv;
  afterEach(async () => {
    await srv?.dispose();
    srv = null;
    assert.deepEqual(fs.readFileSync(TRACKED), original, 'the tracked sample is byte-identical');
  });

  test('each open makes a new timestamped copy, and editing one never touches the next', async () => {
    srv = await startDeckhand({ agents: [] });
    const first = await openSample(srv);
    assert.equal(first.status, 200, first.text);
    assert.equal(path.dirname(first.json.path), path.join(srv.home, 'Deckhand'));
    assert.match(path.basename(first.json.path), STAMPED);
    assert.deepEqual(fs.readFileSync(first.json.path), original);
    await editHeading(srv);
    assert.match(fs.readFileSync(first.json.path, 'utf8'), /Edited in a test/);

    const second = await openSample(srv);
    assert.notEqual(second.json.path, first.json.path);
    assert.match(path.basename(second.json.path), STAMPED);
    assert.deepEqual(fs.readFileSync(second.json.path), original, 'the new copy is clean');
    assert.match(fs.readFileSync(first.json.path, 'utf8'), /Edited in a test/, 'the earlier copy keeps its edits');

    const recents = (await request(srv.port, { path: '/api/recents' })).json.items.map((i) => i.path);
    assert.deepEqual(recents.slice(0, 2), [second.json.path, first.json.path], 'earlier copies stay in recents');
  });

  test('copies made in the same minute get -2 and -3', async () => {
    srv = await startDeckhand({ agents: [], env: NOW });
    const names = [];
    for (let i = 0; i < 3; i++) names.push(path.basename((await openSample(srv)).json.path));
    assert.deepEqual(names, ['sample-deck-2026-11-26-1802.html', 'sample-deck-2026-11-26-1802-2.html', 'sample-deck-2026-11-26-1802-3.html']);
  });

  test('a copy remembered by an older version is never reused', async () => {
    srv = await startDeckhand({ agents: [], env: NOW });
    const dir = path.join(srv.home, 'Deckhand');
    fs.mkdirSync(dir, { recursive: true });
    const old = path.join(dir, 'sample-deck.html');
    fs.writeFileSync(old, '<h1>My edited sample</h1>');
    fs.mkdirSync(path.join(srv.home, '.deckhand'), { recursive: true });
    fs.writeFileSync(path.join(srv.home, '.deckhand', 'state.json'), JSON.stringify({ version: 1, agent: null, recents: [], sampleCopy: old }));
    await srv.restart();
    const res = await openSample(srv);
    assert.equal(path.basename(res.json.path), 'sample-deck-2026-11-26-1802.html');
    assert.equal(fs.readFileSync(old, 'utf8'), '<h1>My edited sample</h1>');
    assert.ok(!('sampleCopy' in JSON.parse(fs.readFileSync(path.join(srv.home, '.deckhand', 'state.json'), 'utf8'))));
  });

  test('npm run demo opens a fresh copy too', async () => {
    srv = await startDeckhand({ agents: [], args: ['samples/sample-deck.html'], env: { INIT_CWD: REPO, ...NOW } });
    const { deck } = (await request(srv.port, { path: '/api/state' })).json;
    assert.equal(deck.path, path.join(srv.home, 'Deckhand', 'sample-deck-2026-11-26-1802.html'));
    await editHeading(srv);
  });
});
