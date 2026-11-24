import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { startDeckhand, tempDir, makeDeck, makeBin, request, postJson, exists } from './support/deckhand-process.js';

const EVIL = 'https://evil.example';

function assertNoLeak(res, dir) {
  assert.ok(!/\bat \S+ \(/.test(res.text), `stack leaked: ${res.text}`);
  assert.ok(!res.text.includes(dir), `path leaked: ${res.text}`);
  assert.ok(!res.text.includes(os.homedir()), `home leaked: ${res.text}`);
}

function wsConnect(port, headers = {}) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { Origin: `http://127.0.0.1:${port}`, ...headers } });
    const messages = [];
    ws.on('message', (m) => messages.push(JSON.parse(m)));
    ws.on('open', () => setTimeout(() => { ws.close(); resolve({ ok: true, messages }); }, 150));
    ws.on('unexpected-response', (_req, res) => { resolve({ ok: false, status: res.statusCode }); ws.terminate(); });
    ws.on('error', () => resolve({ ok: false, status: null }));
  });
}

describe('security', () => {
  let srv, root, deckDir, deckPath, otherDeck, secret, logPath;

  before(async () => {
    root = await tempDir();
    deckDir = path.join(root, 'decks');
    await fsp.mkdir(deckDir);
    deckPath = await makeDeck(deckDir);
    otherDeck = await makeDeck(root, 'other.html');
    secret = path.join(root, 'secret.txt');
    await fsp.writeFile(secret, 'top secret');
    await fsp.symlink(secret, path.join(deckDir, 'link.txt'));
    logPath = path.join(root, 'agent.log');
    const binDir = await makeBin(path.join(root, 'bin'), {
      claude: `require('node:fs').appendFileSync(${JSON.stringify(logPath)}, 'ran\\n');`,
    });
    srv = await startDeckhand({ args: [deckPath], binDir });
  });

  after(async () => { await srv?.stop(); });

  test('AC-5 listens on 127.0.0.1 only', async () => {
    const lan = Object.values(os.networkInterfaces()).flat()
      .find((i) => i && i.family === 'IPv4' && !i.internal);
    const res = await request(srv.port, { path: '/' });
    assert.equal(res.status, 200);
    if (!lan) return;
    const refused = await new Promise((resolve) => {
      const s = net.connect({ host: lan.address, port: srv.port });
      s.on('connect', () => { s.destroy(); resolve(false); });
      s.on('error', () => resolve(true));
    });
    assert.ok(refused, `reachable on ${lan.address}`);
  });

  test('AC-59 foreign Host header gets 403 on every surface', async () => {
    for (const p of ['/', '/api/state', '/deckroot/deck.html', '/app.js']) {
      for (const host of ['evil.example', `evil.example:${srv.port}`, `127.0.0.1:${srv.port + 1}`, `localhost.evil.example:${srv.port}`, '']) {
        const res = await request(srv.port, { path: p, host });
        assert.equal(res.status, 403, `${p} with Host "${host}"`);
      }
    }
  });

  test('AC-59 127.0.0.1 and localhost hosts are allowed', async () => {
    assert.equal((await request(srv.port, { path: '/api/state', host: `localhost:${srv.port}` })).status, 200);
    assert.equal((await request(srv.port, { path: '/api/state', host: `127.0.0.1:${srv.port}` })).status, 200);
  });

  test('AC-58 foreign Origin cannot open a deck or start a run', async () => {
    const open = await postJson(srv.port, '/api/open', { path: otherDeck }, { Origin: EVIL });
    assert.equal(open.status, 403);
    assert.equal(open.json.error.code, 'forbidden_origin');
    const run = await postJson(srv.port, '/api/implement', { run: true }, { Origin: EVIL });
    assert.equal(run.status, 403);
    const note = await postJson(srv.port, '/api/run-note', { note: { text: 'x', aiId: 'dh1' } }, { Origin: 'null' });
    assert.equal(note.status, 403);
    const state = await request(srv.port, { path: '/api/state' });
    assert.equal(state.json.deck.deckPath, deckPath);
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(exists(logPath), false, 'agent ran');
  });

  test('AC-58 cross-site fetch metadata is rejected even without Origin', async () => {
    const res = await request(srv.port, {
      method: 'POST',
      path: '/api/open',
      headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'cross-site' },
      body: JSON.stringify({ path: otherDeck }),
    });
    assert.equal(res.status, 403);
    const get = await request(srv.port, { path: '/api/state', headers: { 'Sec-Fetch-Site': 'cross-site' } });
    assert.equal(get.status, 403);
  });

  test('mutations must be JSON, so HTML forms cannot post', async () => {
    for (const type of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x', null]) {
      const res = await request(srv.port, {
        method: 'POST',
        path: '/api/open',
        headers: { Origin: `http://127.0.0.1:${srv.port}`, ...(type ? { 'Content-Type': type } : {}) },
        body: JSON.stringify({ path: otherDeck }),
      });
      assert.equal(res.status, 415, String(type));
      assert.equal(res.json.error.code, 'bad_content_type');
    }
    const state = await request(srv.port, { path: '/api/state' });
    assert.equal(state.json.deck.deckPath, deckPath);
  });

  test('same-origin JSON mutations still work', async () => {
    const res = await postJson(srv.port, '/api/implement', {}, { 'Sec-Fetch-Site': 'same-origin' });
    assert.equal(res.status, 200);
    assert.equal(typeof res.json.prompt, 'string');
  });

  test('JSON bodies over 1 MB get 413', async () => {
    const res = await postJson(srv.port, '/api/open', { path: 'x'.repeat(1024 * 1024 + 10) });
    assert.equal(res.status, 413);
    assert.equal(res.json.error.code, 'too_large');
  });

  test('bad JSON gets 400 without a stack', async () => {
    const res = await request(srv.port, {
      method: 'POST',
      path: '/api/open',
      headers: { 'Content-Type': 'application/json', Origin: `http://127.0.0.1:${srv.port}` },
      body: '{"path": ',
    });
    assert.equal(res.status, 400);
    assert.equal(res.json.error.code, 'bad_json');
    assertNoLeak(res, root);
  });

  test('opening a missing deck does not echo the path', async () => {
    const res = await postJson(srv.port, '/api/open', { path: path.join(root, 'nope.html') });
    assert.equal(res.status, 400);
    assert.ok(res.json.error.code);
    assertNoLeak(res, root);
  });

  test('AC-60 WebSocket with a foreign Origin is rejected', async () => {
    const bad = await wsConnect(srv.port, { Origin: EVIL });
    assert.equal(bad.ok, false);
    assert.equal(bad.status, 403);
    const badHost = await wsConnect(srv.port, { Host: 'evil.example' });
    assert.equal(badHost.ok, false);
    const crossSite = await wsConnect(srv.port, { 'Sec-Fetch-Site': 'cross-site' });
    assert.equal(crossSite.ok, false);
  });

  test('AC-60 same-origin WebSocket connects and gets a hello', async () => {
    const good = await wsConnect(srv.port);
    assert.equal(good.ok, true);
    const hello = good.messages.find((m) => m.type === 'hello');
    assert.ok(hello, JSON.stringify(good.messages));
    assert.ok(hello.serverId);
  });

  test('AC-61 /deckroot refuses traversal', async () => {
    const paths = [
      '/deckroot/../secret.txt',
      '/deckroot/%2e%2e/secret.txt',
      '/deckroot/%2E%2E/secret.txt',
      '/deckroot/%2e%2e%2fsecret.txt',
      '/deckroot/..%2Fsecret.txt',
      '/deckroot/sub/..%2f..%2fsecret.txt',
      '/deckroot/%2e%2e%5csecret.txt',
      '/deckroot/deck.html%00.png',
      '/deckroot/link.txt',
    ];
    for (const p of paths) {
      const res = await request(srv.port, { path: p });
      assert.equal(res.status, 403, p);
      assert.ok(!res.text.includes('top secret'), p);
      assertNoLeak(res, root);
    }
  });

  test('AC-61 malformed encoding gets 400, not 500', async () => {
    for (const p of ['/deckroot/%E0%A4%A', '/deckroot/%', '/api/state%ZZ']) {
      const res = await request(srv.port, { path: p });
      assert.equal(res.status, 400, p);
      assertNoLeak(res, root);
    }
  });

  test('static serving refuses traversal out of public/', async () => {
    for (const p of ['/../package.json', '/%2e%2e/package.json', '/js/%2e%2e/%2e%2e/server.js']) {
      const res = await request(srv.port, { path: p });
      assert.equal(res.status, 403, p);
    }
  });

  test('404s do not echo absolute paths', async () => {
    const a = await request(srv.port, { path: '/deckroot/missing.png' });
    assert.equal(a.status, 404);
    assertNoLeak(a, root);
    const b = await request(srv.port, { path: '/nope.js' });
    assert.equal(b.status, 404);
    assertNoLeak(b, path.resolve('.'));
    const c = await request(srv.port, { path: '/api/nope' });
    assert.equal(c.status, 404);
    assert.equal(c.json.error.code, 'not_found');
  });

  test('deck is served with connect-src none', async () => {
    const res = await request(srv.port, { path: '/deckroot/deck.html' });
    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'], /text\/html/);
    assert.match(res.headers['content-security-policy'], /connect-src 'none'/);
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
  });

  test('app pages carry security headers', async () => {
    for (const p of ['/', '/create', '/edit', '/app.js']) {
      const res = await request(srv.port, { path: p });
      assert.equal(res.status, 200, p);
      assert.equal(res.headers['x-frame-options'], 'SAMEORIGIN', p);
      assert.match(res.headers['content-security-policy'], /frame-ancestors 'self'/, p);
      assert.equal(res.headers['x-content-type-options'], 'nosniff', p);
      assert.equal(res.headers['referrer-policy'], 'no-referrer', p);
    }
  });

  test('static files under public/ are served generically with the right type', async () => {
    const js = await request(srv.port, { path: '/app.js' });
    assert.equal(js.status, 200);
    assert.match(js.headers['content-type'], /text\/javascript/);
    const css = await request(srv.port, { path: '/app.css' });
    assert.match(css.headers['content-type'], /text\/css/);
    const spa = await request(srv.port, { path: '/edit?deck=x' });
    assert.match(spa.headers['content-type'], /text\/html/);
  });

  test('POST to a GET route is refused', async () => {
    const res = await postJson(srv.port, '/api/state', {});
    assert.equal(res.status, 405);
  });
});
