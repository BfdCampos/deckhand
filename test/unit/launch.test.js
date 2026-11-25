import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { startDeckhand } from '../helpers/deckhand.js';
import { request, postJson } from '../helpers/http.js';
import { tempDir, makeDeck, makeBin, pidAlive, waitFor } from '../helpers/util.js';
import { browserCommand } from '../../src/server/open.js';

function occupy(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(null));
    s.listen(port, '127.0.0.1', () => resolve(s));
  });
}

async function freePort() {
  const s = await occupy(0);
  const { port } = s.address();
  await new Promise((r) => s.close(r));
  return port;
}

function hangingClaude(logPath) {
  return `
if (process.argv.includes('--version')) { console.log('2.1.331 (Claude Code)'); process.exit(0); }
if (process.argv.includes('--help')) { console.log('--tools --restricted --strict-mcp-config --permission-mode --permission-prompts --no-session-persistence --disable-slash-commands --append-system-prompt'); process.exit(0); }
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const g = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: 'ignore' });
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ pid: process.pid, grandchild: g.pid }) + '\\n');
setInterval(() => {}, 1000);
`;
}

describe('launch', () => {
  test('AC-1 serves Home within 3 s and prints the launch lines', async () => {
    const t0 = Date.now();
    const srv = await startDeckhand({ agents: [] });
    try {
      const res = await request(srv.port, { path: '/' });
      assert.equal(res.status, 200);
      assert.match(res.headers['content-type'], /text\/html/);
      assert.ok(Date.now() - t0 < 3000, `took ${Date.now() - t0} ms`);
      const out = srv.stdout();
      assert.match(out, new RegExp(`^\\s*Deckhand is running at http://127\\.0\\.0\\.1:${srv.port}$`, 'm'));
      assert.match(out, /^\s*Agent: none found$/m);
      assert.match(out, /^\s*Press Ctrl\+C to stop\.$/m);
    } finally {
      await srv.stop();
    }
  });

  test('prints the agent when claude is on PATH', async () => {
    const root = await tempDir();
    const binDir = await makeBin(path.join(root, 'bin'), { claude: 'process.exit(0)' });
    const srv = await startDeckhand({ binDir });
    try {
      assert.match(srv.stdout(), /^\s*Agent: Claude Code \(Codex not found\)$/m);
    } finally {
      await srv.stop();
    }
  });

  test('finds claude in DECKHAND_EXTRA_BIN_DIRS', async () => {
    const root = await tempDir();
    const extra = await makeBin(path.join(root, 'extra'), { claude: 'process.exit(0)' });
    const srv = await startDeckhand({ agents: [], env: { DECKHAND_EXTRA_BIN_DIRS: extra } });
    try {
      assert.match(srv.stdout(), /^\s*Agent: Claude Code \(Codex not found\)$/m);
    } finally {
      await srv.stop();
    }
  });

  test('AC-2 a busy explicit port falls back to the next free one', async () => {
    const port = await freePort();
    const blocker = await occupy(port);
    const srv = await startDeckhand({ portArgs: ['--port', String(port)] });
    try {
      assert.notEqual(srv.port, port);
      assert.ok(srv.port > port && srv.port < port + 20, `got ${srv.port}`);
      assert.equal((await request(srv.port, { path: '/' })).status, 200);
    } finally {
      await srv.stop();
      blocker.close();
    }
  });

  test('AC-2 a busy default port 4321 falls back and prints the real URL', async () => {
    const blocker = await occupy(4321);
    const srv = await startDeckhand({ portArgs: [] });
    try {
      assert.notEqual(srv.port, 4321);
      assert.ok(srv.port > 4321 && srv.port <= 4340, `got ${srv.port}`);
      assert.match(srv.stdout(), new RegExp(`http://127\\.0\\.0\\.1:${srv.port}\\b`));
    } finally {
      await srv.stop();
      blocker?.close();
    }
  });

  test('--port=0 form works too', async () => {
    const srv = await startDeckhand({ portArgs: ['--port=0'] });
    try {
      assert.ok(srv.port > 0);
    } finally {
      await srv.stop();
    }
  });

  test('AC-3 a deck path argument binds that deck', async () => {
    const dir = await tempDir();
    const deck = await makeDeck(dir);
    const srv = await startDeckhand({ args: [deck] });
    try {
      const res = await request(srv.port, { path: '/api/state' });
      assert.equal(res.status, 200);
      assert.equal(res.json.deck.path, deck);
    } finally {
      await srv.stop();
    }
  });

  test('--no-open and unknown flags are not taken as the deck path', async () => {
    const srv = await startDeckhand({ args: ['--wat'] });
    try {
      const res = await request(srv.port, { path: '/api/state' });
      assert.equal(res.json.deck, null);
    } finally {
      await srv.stop();
    }
  });

  for (const signal of ['SIGINT', 'SIGTERM']) {
    test(`AC-4 ${signal} during a run kills the agent and its children within 2 s`, async () => {
      const root = await tempDir();
      const deck = await makeDeck(root);
      const logPath = path.join(root, 'agent.log');
      const binDir = await makeBin(path.join(root, 'bin'), { claude: hangingClaude(logPath) });
      const srv = await startDeckhand({ args: [deck], binDir });
      let pids;
      try {
        const { deckId } = (await request(srv.port, { path: '/api/state' })).json.deck;
        const note = await postJson(srv.port, '/api/notes', { deckId, op: 'add', note: { text: 'Make it blue', aiId: 'dh1', targetTag: 'h1' } });
        assert.equal(note.status, 200, note.text);
        const res = await postJson(srv.port, '/api/runs', { kind: 'edit', scope: 'all' });
        assert.equal(res.status, 200, res.text);
        pids = await waitFor(async () => {
          try { return JSON.parse((await fsp.readFile(logPath, 'utf8')).trim()); } catch { return null; }
        });
        assert.ok(pidAlive(pids.pid) && pidAlive(pids.grandchild));
        const t0 = Date.now();
        srv.proc.kill(signal);
        await waitFor(() => !pidAlive(pids.pid) && !pidAlive(pids.grandchild), { timeout: 2000 });
        await srv.exited;
        assert.ok(Date.now() - t0 < 2000, `took ${Date.now() - t0} ms`);
      } finally {
        if (pids) for (const p of [pids.pid, pids.grandchild]) { try { process.kill(p, 'SIGKILL'); } catch {} }
        await srv.stop();
      }
    });
  }

  test('shuts down cleanly with no run', async () => {
    const srv = await startDeckhand();
    const t0 = Date.now();
    srv.proc.kill('SIGINT');
    const { code } = await srv.exited;
    assert.equal(code, 0);
    assert.ok(Date.now() - t0 < 2000);
  });
});

describe('AC-71 auto-open', () => {
  async function opener() {
    const root = await tempDir();
    const log = path.join(root, 'opened.log');
    const bin = await makeBin(path.join(root, 'bin'), {
      'fake-open': `require('node:fs').appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + '\\n');`,
    });
    const read = async () => {
      try { return (await fsp.readFile(log, 'utf8')).trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; }
    };
    return { root, cmd: path.join(bin, 'fake-open'), read };
  }

  const live = (cmd, extra = {}) => ({ DECKHAND_TEST: '0', DECKHAND_OPEN_CMD: cmd, ...extra });

  test('opens Home in the browser on launch', async () => {
    const o = await opener();
    const srv = await startDeckhand({ noOpen: false, env: live(o.cmd) });
    try {
      const calls = await waitFor(async () => { const c = await o.read(); return c.length ? c : null; });
      assert.deepEqual(calls, [[`http://127.0.0.1:${srv.port}/`]]);
    } finally {
      await srv.stop();
    }
  });

  test('opens straight to the editor when a deck is given', async () => {
    const o = await opener();
    const deck = await makeDeck(o.root, 'my deck.html');
    const srv = await startDeckhand({ noOpen: false, args: [deck], env: live(o.cmd) });
    try {
      const [[url]] = await waitFor(async () => { const c = await o.read(); return c.length ? c : null; });
      assert.equal(url, `http://127.0.0.1:${srv.port}/edit?deck=${encodeURIComponent(deck)}`);
    } finally {
      await srv.stop();
    }
  });

  for (const [label, opts] of [
    ['--no-open', { noOpen: true, env: {} }],
    ['CI', { noOpen: false, env: { CI: 'true' } }],
    ['DECKHAND_TEST', { noOpen: false, env: { DECKHAND_TEST: '1' } }],
  ]) {
    test(`${label} suppresses it`, async () => {
      const o = await opener();
      const srv = await startDeckhand({ noOpen: opts.noOpen, env: { ...live(o.cmd), ...opts.env } });
      try {
        await new Promise((r) => setTimeout(r, 400));
        assert.deepEqual(await o.read(), []);
      } finally {
        await srv.stop();
      }
    });
  }

  test('a missing opener never crashes the server', async () => {
    const srv = await startDeckhand({ noOpen: false, env: live('/nonexistent/deckhand-opener') });
    try {
      await new Promise((r) => setTimeout(r, 300));
      assert.equal((await request(srv.port, { path: '/' })).status, 200);
      assert.equal(srv.proc.exitCode, null);
    } finally {
      await srv.stop();
    }
  });

  test('picks the platform opener', () => {
    assert.deepEqual(browserCommand({ platform: 'darwin', env: {} }), 'open');
    assert.deepEqual(browserCommand({ platform: 'linux', env: {} }), 'xdg-open');
    assert.equal(browserCommand({ platform: 'win32', env: {} }), null);
    assert.equal(browserCommand({ platform: 'darwin', env: { DECKHAND_OPEN_CMD: '/x/y' } }), '/x/y');
  });
});
