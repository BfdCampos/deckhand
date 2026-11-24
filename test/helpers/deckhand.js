import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { REPO, agentBinDir, nodeBinDir, readAgentLog, tempDir } from './fakes.js';

const SERVER = path.join(REPO, 'server.js');
const READY = /Deckhand (?:is )?running at (http:\/\/127\.0\.0\.1:(\d+))/;
const START_TIMEOUT = 15000;

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function pointAgents(link, agents) {
  const tmp = `${link}.${process.pid}.${Date.now()}`;
  fs.symlinkSync(agentBinDir(agents), tmp);
  fs.renameSync(tmp, link);
}

export async function startDeckhand({ deck, copyDeck = true, agents = ['claude', 'codex'], env = {}, args = [], scenario } = {}) {
  const root = tempDir('deckhand-e2e-');
  const home = path.join(root, 'home');
  const tmp = path.join(root, 'tmp');
  fs.mkdirSync(home);
  fs.mkdirSync(tmp);
  const agentsLink = path.join(root, 'agents');
  pointAgents(agentsLink, agents);
  const logPath = path.join(root, 'agent.log');

  let deckPath = null;
  if (deck) {
    const src = path.resolve(REPO, deck);
    if (copyDeck) {
      fs.mkdirSync(path.join(home, 'Decks'));
      deckPath = path.join(home, 'Decks', path.basename(src));
      fs.copyFileSync(src, deckPath);
    } else {
      deckPath = src;
    }
  }

  const childEnv = {
    HOME: home,
    PATH: `${agentsLink}:${nodeBinDir()}`,
    TMPDIR: tmp,
    LANG: 'en_GB.UTF-8',
    NO_COLOR: '1',
    DECKHAND_TEST: '1',
    DECKHAND_EXTRA_BIN_DIRS: '',
    FAKE_AGENT_LOG: logPath,
    ...(scenario ? { FAKE_AGENT_SCENARIO: scenario } : {}),
    ...env,
  };

  let child = null;
  let output = '';
  let exited = Promise.resolve();
  const dh = { root, home, logPath, deckPath, url: null, port: null };

  function launch(argv) {
    return new Promise((resolve, reject) => {
      const proc = spawn(process.execPath, [SERVER, ...argv], { cwd: REPO, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
      let pending = '';
      let settled = false;
      const timer = setTimeout(() => finish(new Error(`Deckhand did not print its URL within ${START_TIMEOUT} ms\n${output}`)), START_TIMEOUT);
      function finish(err, value) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) { try { process.kill(-proc.pid, 'SIGKILL'); } catch { /* gone */ } reject(err); } else resolve(value);
      }
      const onData = (d) => {
        output += d;
        pending += d;
        const m = READY.exec(pending);
        if (m) finish(null, { proc, url: m[1], port: Number(m[2]) });
      };
      proc.stdout.on('data', onData);
      proc.stderr.on('data', (d) => { output += d; });
      proc.on('error', (e) => finish(e));
      proc.on('exit', (code, signal) => finish(new Error(`Deckhand exited (${code ?? signal}) before printing its URL\n${output}`)));
      exited = new Promise((r) => proc.on('exit', r));
    });
  }

  let legacy = false;
  async function start(port) {
    const deckArg = deckPath ? [deckPath] : [];
    let started = legacy ? null : await launch(['--port', String(port), '--no-open', ...args, ...deckArg]);
    if (!started || started.port === 0) {
      // Pre-WP1.1 server: it echoes the requested port and has no --no-open flag. Remove once WP1.1 lands.
      if (started) { child = started.proc; await stop(); }
      legacy = true;
      started = await launch(['--port', String(port || await freePort()), ...args, ...deckArg]);
    }
    child = started.proc;
    dh.url = started.url;
    dh.port = started.port;
  }

  async function stop() {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const proc = child;
    const done = exited;
    proc.kill('SIGTERM');
    const timeout = new Promise((r) => setTimeout(() => r('timeout'), 3000));
    if (await Promise.race([done, timeout]) === 'timeout') {
      try { process.kill(-proc.pid, 'SIGKILL'); } catch { /* gone */ }
      await done;
    }
  }

  Object.assign(dh, {
    output: () => output,
    agentLog: (query) => readAgentLog(logPath, query),
    async restart() {
      await stop();
      await start(dh.port);
      return dh;
    },
    stop,
    setAgents(list) {
      pointAgents(agentsLink, list);
    },
    async dispose() {
      await stop();
      if (!process.env.DECKHAND_KEEP_TEST_HOME) fs.rmSync(root, { recursive: true, force: true });
    },
  });

  Object.defineProperty(dh, 'pid', { get: () => child?.pid, enumerable: true });

  await start(0);
  return dh;
}
