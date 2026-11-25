import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startDeckhand } from '../helpers/deckhand.js';
import { REPO } from '../helpers/fakes.js';
import { request, postJson } from '../helpers/http.js';

const TRACKED = path.join(REPO, 'samples', 'sample-deck.html');
const original = fs.readFileSync(TRACKED);

async function editHeading(srv) {
  const { deck } = (await request(srv.port, { path: '/api/state' })).json;
  const served = (await request(srv.port, { path: deck.url })).text;
  const [, tag, aiId, text] = /<(h[12]) data-ai-id="(dh\d+)"[^>]*>([^<]+)</.exec(served);
  const res = await postJson(srv.port, '/api/deck/ops', { deckId: deck.deckId, tabId: 't', baseRev: deck.rev, ops: [{ type: 'setInner', aiId, tag, before: text, after: 'Edited in a test' }] });
  assert.equal(res.status, 200, res.text);
  return deck;
}

describe('the sample deck is never edited in the checkout', () => {
  let srv;
  afterEach(async () => {
    await srv?.dispose();
    srv = null;
    assert.deepEqual(fs.readFileSync(TRACKED), original, 'the tracked sample is byte-identical');
  });

  test('opening the tracked sample opens a copy in ~/Deckhand, and edits land there', async () => {
    srv = await startDeckhand({ agents: [] });
    const res = await postJson(srv.port, '/api/deck/open', { path: TRACKED });
    assert.equal(res.status, 200, res.text);
    const copy = path.join(srv.home, 'Deckhand', 'sample-deck.html');
    assert.equal(res.json.path, copy);
    await editHeading(srv);
    assert.match(fs.readFileSync(copy, 'utf8'), /Edited in a test/);

    const again = await postJson(srv.port, '/api/deck/open', { path: TRACKED });
    assert.equal(again.json.path, copy, 'our copy is reused');
    assert.match(fs.readFileSync(copy, 'utf8'), /Edited in a test/, 'and keeps its edits');
  });

  test('a different file already called sample-deck.html is left alone', async () => {
    srv = await startDeckhand({ agents: [] });
    const dir = path.join(srv.home, 'Deckhand');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'sample-deck.html'), '<h1>Mine</h1>');
    const res = await postJson(srv.port, '/api/deck/open', { path: TRACKED });
    assert.equal(res.json.path, path.join(dir, 'sample-deck-2.html'));
    assert.equal(fs.readFileSync(path.join(dir, 'sample-deck.html'), 'utf8'), '<h1>Mine</h1>');
    const again = await postJson(srv.port, '/api/deck/open', { path: TRACKED });
    assert.equal(again.json.path, path.join(dir, 'sample-deck-2.html'));
  });

  test('npm run demo opens the copy too', async () => {
    srv = await startDeckhand({ agents: [], args: ['samples/sample-deck.html'], env: { INIT_CWD: REPO } });
    const { deck } = (await request(srv.port, { path: '/api/state' })).json;
    assert.equal(deck.path, path.join(srv.home, 'Deckhand', 'sample-deck.html'));
    await editHeading(srv);
  });
});
