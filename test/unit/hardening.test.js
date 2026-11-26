import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import WebSocket from 'ws';
import { startDeckhand } from '../helpers/deckhand.js';
import { request, postJson } from '../helpers/http.js';
import { tempDir, makeDeck } from '../helpers/util.js';
import { createStore } from '../../src/server/store.js';

describe('hardening', () => {
  let srv;
  let deckDir;

  before(async () => {
    const root = await tempDir();
    deckDir = path.join(root, 'decks');
    await fsp.mkdir(path.join(deckDir, '.git'), { recursive: true });
    await fsp.mkdir(path.join(deckDir, 'deckhand-assets'));
    await makeDeck(deckDir);
    const files = {
      '.env': 'SECRET=1',
      '.git/config': '[core]',
      'credentials.json': '{"token":"x"}',
      'id_rsa': 'KEY',
      'notes.md': '# private',
      'deck.deckhand.json': '{"version":2,"notes":[]}',
      'style.css': 'h1{}',
      'app.js': 'x()',
      'deckhand-assets/1-a.png': 'png',
      'font.woff2': 'f',
    };
    for (const [name, body] of Object.entries(files)) await fsp.writeFile(path.join(deckDir, name), body);
    srv = await startDeckhand({ args: [path.join(deckDir, 'deck.html')] });
  });

  after(async () => { await srv?.stop(); });

  test('/deckroot refuses hidden files and files a deck has no use for', async () => {
    for (const p of ['.env', '.git/config', 'credentials.json', 'id_rsa', 'notes.md']) {
      const res = await request(srv.port, { path: '/deckroot/' + p });
      assert.equal(res.status, 403, p);
      assert.ok(!res.text.includes('SECRET') && !res.text.includes('KEY') && !res.text.includes('token'), p);
    }
  });

  test('/deckroot still serves the deck, its sidecar and web assets', async () => {
    for (const p of ['deck.html', 'deck.deckhand.json', 'style.css', 'app.js', 'deckhand-assets/1-a.png', 'font.woff2']) {
      assert.equal((await request(srv.port, { path: '/deckroot/' + p })).status, 200, p);
    }
  });

  test('app pages forbid plugins, base rewriting and foreign form posts', async () => {
    const csp = (await request(srv.port, { path: '/' })).headers['content-security-policy'];
    for (const d of ["frame-ancestors 'self'", "object-src 'none'", "base-uri 'self'", "form-action 'self'"]) assert.ok(csp.includes(d), d);
  });

  test('deck ops accept bodies over the 1 MB general cap', async () => {
    const state = (await request(srv.port, { path: '/api/state' })).json;
    const big = 'x'.repeat(2 * 1024 * 1024);
    const res = await postJson(srv.port, '/api/deck/ops', { deckId: state.deck.deckId, tabId: 't', baseRev: state.deck.rev, ops: [{ type: 'remove', aiId: 'dh404', tag: 'p', pad: big }] });
    assert.equal(res.status, 409, res.text);
    assert.equal(res.json.error.code, 'anchor_missing');
    const other = await postJson(srv.port, '/api/notes', { deckId: state.deck.deckId, op: 'add', note: { text: big } });
    assert.equal(other.status, 413);
  });

  test('the socket refuses large inbound frames', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/ws`, { headers: { Origin: `http://127.0.0.1:${srv.port}` } });
    await new Promise((r) => ws.on('open', r));
    const closed = new Promise((r) => ws.on('close', (code) => r(code)));
    ws.send('x'.repeat(256 * 1024));
    const result = await Promise.race([closed, new Promise((r) => setTimeout(() => r('still open'), 2000))]);
    ws.terminate();
    assert.equal(result, 1009);
  });
});

describe('store compatibility', () => {
  test('update(patch) persists fields for the agent registry', async () => {
    const home = await tempDir();
    const store = createStore({ stateDir: path.join(home, '.deckhand') });
    await store.load();
    await store.update({ agent: 'codex' });
    assert.equal(store.get().agent, 'codex');
    assert.equal(store.getAgent(), 'codex');
    const again = createStore({ stateDir: path.join(home, '.deckhand') });
    await again.load();
    assert.equal(again.get().agent, 'codex');
  });
});

describe('read-only decks', () => {
  test('uploads are refused with 403 and nothing is written', async () => {
    const root = await tempDir();
    const deck = await makeDeck(root);
    await fsp.chmod(deck, 0o444);
    const srv = await startDeckhand({ args: [deck] });
    try {
      const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
      const res = await request(srv.port, { method: 'POST', path: '/api/assets', headers: { Origin: `http://127.0.0.1:${srv.port}`, 'Content-Type': 'image/png', 'X-Filename': 'a.png' }, body: png });
      assert.equal(res.status, 403);
      assert.equal(res.json.error.code, 'read_only');
      assert.deepEqual(await fsp.readdir(root), ['deck.html']);
    } finally {
      await srv.stop();
    }
  });
});
