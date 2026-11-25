import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { REPO, agentBinDir, nodeBinDir, readAgentLog, tempDir } from './fakes.js';

const SERVER = path.join(REPO, 'server.js');
const READY = /Deckhand is running at (http:\/\/127\.0\.0\.1:(\d+))/;
const START_TIMEOUT = 15000;

const live = new Set();
process.on('exit', () => {
  for (const proc of live) { try { process.kill(-proc.pid, 'SIGKILL'); } catch { /* gone */ } }
});

function pointAt(link, dir) {
  const tmp = `${link}.${process.pid}.${Date.now()}`;
  fs.symlinkSync(dir, tmp);
  fs.renameSync(tmp, link);
}

export async function startDeckhand({
  deck, copyDeck = true, agents = ['claude', 'codex'], binDir, env = {}, args = [], portArgs = ['--port', '0'], scenario,
} = {}) {
  const root = tempDir('deckhand-e2e-');
  const tmp = path.join(root, 'tmp');
  fs.mkdirSync(path.join(root, 'home'));
  fs.mkdirSync(tmp);
  const agentsLink = path.join(root, 'agents');
  pointAt(agentsLink, binDir || agentBinDir(agents));
  const logPath = path.join(root, 'agent.log');

  const childEnv = {
    HOME: path.join(root, 'home'),
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
  const home = childEnv.HOME;

  let deckPath = null;
  if (deck) {
    const src = path.resolve(REPO, deck);
    if (copyDeck) {
      fs.mkdirSync(path.join(home, 'Decks'), { recursive: true });
      deckPath = path.join(home, 'Decks', path.basename(src));
      fs.copyFileSync(src, deckPath);
    } else {
      deckPath = src;
    }
  }

  let child = null;
  let exited = Promise.resolve({ code: null, signal: null });
  let stdout = '';
  let stderr = '';
  let output = '';
  const dh = { root, home, logPath, deckPath, url: null, port: null };

  function launch(argv) {
    return new Promise((resolve, reject) => {
      const proc = spawn(process.execPath, [SERVER, ...argv], { cwd: REPO, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
      live.add(proc);
      exited = new Promise((r) => proc.on('exit', (code, signal) => { live.delete(proc); r({ code, signal }); }));
      let fresh = '';
      let settled = false;
      const timer = setTimeout(() => finish(new Error(`Deckhand did not print its URL within ${START_TIMEOUT} ms\n${output}`)), START_TIMEOUT);
      function finish(err, value) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) { try { process.kill(-proc.pid, 'SIGKILL'); } catch { /* gone */ } reject(err); } else resolve(value);
      }
      proc.stdout.on('data', (d) => {
        stdout += d;
        output += d;
        fresh += d;
        const m = READY.exec(fresh);
        if (m) finish(null, { proc, url: m[1], port: Number(m[2]) });
      });
      proc.stderr.on('data', (d) => { stderr += d; output += d; });
      proc.on('error', (e) => finish(e));
      proc.on('exit', (code, signal) => finish(new Error(`Deckhand exited (${code ?? signal}) before printing its URL\n${output}`)));
    });
  }

  async function start(ports) {
    const started = await launch([...ports, '--no-open', ...args, ...(deckPath ? [deckPath] : [])]);
    child = started.proc;
    dh.url = started.url;
    dh.port = started.port;
  }

  async function stop() {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const done = exited;
    child.kill('SIGTERM');
    const timeout = new Promise((r) => setTimeout(() => r('timeout'), 3000));
    if (await Promise.race([done, timeout]) === 'timeout') {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ }
      await done;
    }
  }

  Object.assign(dh, {
    output: () => output,
    stdout: () => stdout,
    stderr: () => stderr,
    agentLog: (query) => readAgentLog(logPath, query),
    async restart() {
      const port = dh.port;
      for (let attempt = 1; ; attempt++) {
        await stop();
        await start(['--port', String(port)]);
        if (dh.port === port) return dh;
        if (attempt === 3) throw new Error(`Deckhand came back on port ${dh.port}, not ${port}`);
        await new Promise((r) => setTimeout(r, 200));
      }
    },
    stop,
    setAgents(list) {
      pointAt(agentsLink, agentBinDir(list));
    },
    async dispose() {
      await stop();
      if (!process.env.DECKHAND_KEEP_TEST_HOME) fs.rmSync(root, { recursive: true, force: true });
    },
  });
  Object.defineProperties(dh, {
    pid: { get: () => child?.pid, enumerable: true },
    proc: { get: () => child, enumerable: true },
    exited: { get: () => exited, enumerable: true },
  });

  await start(portArgs);
  return dh;
}
