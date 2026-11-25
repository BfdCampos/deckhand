import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import WebSocket from 'ws';
import { startDeckhand } from '../helpers/deckhand.js';
import { request, postJson } from '../helpers/http.js';
import { tempDir, makeDeck, waitFor } from '../helpers/util.js';

const COPY = {
  not_html: "That's not an HTML file. Deckhand opens .html decks.",
  is_dir: "That's a folder. Pick an .html file inside it.",
  empty: 'That file is empty.',
  unreadable: "Deckhand can't read that file (permission denied).",
  not_found: "Can't find that file.",
};

function socket(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { Origin: `http://127.0.0.1:${port}` } });
  const messages = [];
  ws.on('message', (m) => messages.push(JSON.parse(m)));
  return new Promise((resolve) => ws.on('open', () => resolve({ ws, messages })));
}

describe('B1 and m2: open only binds real decks, and a failed open changes nothing', () => {
  let srv;
  let root;
  let good;
  const files = {};

  before(async () => {
    root = await tempDir();
    good = await makeDeck(root, 'good.html');
    files.md = path.join(root, 'victim-notes.md');
    await fsp.writeFile(files.md, '# My private notes\n');
    files.empty = path.join(root, 'empty.html');
    await fsp.writeFile(files.empty, '   \n');
    files.locked = path.join(root, 'locked.html');
    await fsp.writeFile(files.locked, '<h1>locked</h1>');
    await fsp.chmod(files.locked, 0o000);
    files.dir = path.join(root, 'folder.html');
    await fsp.mkdir(files.dir);
    srv = await startDeckhand({ args: [good] });
  });

  after(async () => {
    await fsp.chmod(files.locked, 0o644).catch(() => {});
    await srv?.stop();
  });

  const bound = async () => (await request(srv.port, { path: '/api/state' })).json;

  test('each bad path is refused with the spec code and copy, and the deck stays bound', async () => {
    const cases = [[files.md, 'not_html'], [files.dir, 'is_dir'], [files.empty, 'empty'], [files.locked, 'unreadable'], [path.join(root, 'gone.html'), 'not_found']];
    for (const [p, code] of cases) {
      const res = await postJson(srv.port, '/api/open', { path: p });
      assert.equal(res.status, 400, p);
      assert.deepEqual(res.json.error, { code, message: COPY[code] }, p);
      const state = await bound();
      assert.equal(state.deckPath, good, `still bound to the good deck after ${code}`);
    }
    assert.equal(await fsp.readFile(files.md, 'utf8'), '# My private notes\n');
  });

  test('the socket ignores open requests, so nothing is rebound', async () => {
    const { ws, messages } = await socket(srv.port);
    await waitFor(() => messages.some((m) => m.type === 'deck'));
    ws.send(JSON.stringify({ type: 'open', path: files.md }));
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(messages.filter((m) => m.type === 'deck').length, 1, 'only the connect snapshot');
    ws.close();
    assert.equal((await bound()).deckPath, good);
  });

  test('after a failed open, saves still go to the good deck and never to the failed file', async () => {
    assert.equal((await postJson(srv.port, '/api/open', { path: files.locked })).status, 400);
    const { deck } = await bound();
    const res = await postJson(srv.port, '/api/deck/ops', {
      deckId: deck.deckId, tabId: 't', baseRev: deck.rev,
      ops: [{ type: 'insert', parentAiId: null, html: '<p>saved to good</p>' }],
    });
    assert.equal(res.status, 200);
    assert.match(await fsp.readFile(good, 'utf8'), /<p data-ai-id="dh\d+">saved to good<\/p>/);
    await fsp.chmod(files.locked, 0o644);
    assert.equal(await fsp.readFile(files.locked, 'utf8'), '<h1>locked</h1>');
    await fsp.chmod(files.locked, 0o000);
    assert.equal(await fsp.readFile(files.md, 'utf8'), '# My private notes\n');
  });
});

describe('m3: bad input gets 4xx, not 500, and the log stays quiet', () => {
  let srv;
  let root;
  let deckDir;

  before(async () => {
    root = await tempDir();
    deckDir = path.join(root, 'decks');
    await fsp.mkdir(deckDir);
    await makeDeck(deckDir);
    srv = await startDeckhand({ args: [path.join(deckDir, 'deck.html')] });
  });

  after(async () => { await srv?.stop(); });

  test('null, array and scalar JSON bodies get 400 bad_json', async () => {
    for (const route of ['/api/open', '/api/run-note', '/api/implement']) {
      for (const body of ['null', '[]', '42', '"x"']) {
        const res = await request(srv.port, {
          method: 'POST', path: route, body,
          headers: { 'Content-Type': 'application/json', Origin: `http://127.0.0.1:${srv.port}` },
        });
        assert.equal(res.status, 400, `${route} ${body}`);
        assert.equal(res.json.error.code, 'bad_json');
      }
    }
  });

  test('/shared/* without a shared folder gets 404', async () => {
    for (const p of ['/shared/anything', '/shared/slug.js']) {
      const res = await request(srv.port, { path: p });
      assert.equal(res.status, 404, p);
    }
  });

  test('a deleted deck folder gets 404 from /deckroot, not 500', async () => {
    await fsp.rm(deckDir, { recursive: true, force: true });
    const res = await request(srv.port, { path: '/deckroot/deck.html' });
    assert.equal(res.status, 404);
  });

  test('none of that wrote a stack trace to the log', () => {
    const log = srv.output();
    assert.ok(!/^\s+at /m.test(log), log);
    assert.ok(!/request failed/.test(log), log);
  });
});

describe('m4: /deckroot serves only web assets and the notes sidecar', () => {
  let srv;
  let dir;

  before(async () => {
    dir = await tempDir();
    await fsp.mkdir(path.join(dir, '.git'));
    await fsp.mkdir(path.join(dir, 'deckhand-assets'));
    await makeDeck(dir);
    const files = {
      '.env': 'SECRET=1', '.git/config': '[core]', 'credentials.json': '{"token":"x"}', 'id_rsa': 'KEY', 'notes.md': '# private',
      'deck.deckhand.json': '{"notes":[]}', 'style.css': 'h1{}', 'app.js': 'x()', 'deckhand-assets/1-a.png': 'png', 'font.woff2': 'f',
    };
    for (const [name, body] of Object.entries(files)) await fsp.writeFile(path.join(dir, name), body);
    srv = await startDeckhand({ args: [path.join(dir, 'deck.html')] });
  });

  after(async () => { await srv?.stop(); });

  test('hidden files and non-web files are refused', async () => {
    for (const p of ['.env', '.git/config', 'credentials.json', 'id_rsa', 'notes.md']) {
      const res = await request(srv.port, { path: '/deckroot/' + p });
      assert.equal(res.status, 403, p);
      assert.ok(!/SECRET|KEY|token|private/.test(res.text), p);
    }
  });

  test('the deck, its sidecar and web assets are still served', async () => {
    for (const p of ['deck.html', 'deck.deckhand.json', 'style.css', 'app.js', 'deckhand-assets/1-a.png', 'font.woff2']) {
      assert.equal((await request(srv.port, { path: '/deckroot/' + p })).status, 200, p);
    }
  });
});

describe('n7: npm start -- ./deck.html resolves against the shell folder', () => {
  test('a relative deck path uses INIT_CWD', async () => {
    const dir = await tempDir();
    const deck = await makeDeck(dir, 'relative.html');
    const srv = await startDeckhand({ args: ['relative.html'], env: { INIT_CWD: dir } });
    try {
      assert.equal((await request(srv.port, { path: '/api/state' })).json.deckPath, deck);
    } finally {
      await srv.stop();
    }
  });
});
