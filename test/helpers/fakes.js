import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const FIXTURES = path.join(REPO, 'test/fixtures');
export const STREAMS = path.join(FIXTURES, 'streams');
export const DECKS = path.join(FIXTURES, 'decks');

const AGENT_DIRS = { 'claude,codex': 'bin-both', claude: 'bin-claude', '': 'bin-none' };

export function agentBinDir(agents = ['claude', 'codex']) {
  const key = [...agents].sort().join(',');
  const dir = AGENT_DIRS[key];
  if (!dir) throw new Error(`No fake bin dir for agents [${key}]; use ['claude', 'codex'], ['claude'] or []`);
  return path.join(FIXTURES, dir);
}

export function nodeBinDir() {
  const dir = path.join(os.tmpdir(), `deckhand-test-node-${process.version}`);
  const link = path.join(dir, 'node');
  fs.mkdirSync(dir, { recursive: true });
  try {
    fs.symlinkSync(process.execPath, link);
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
  }
  return dir;
}

const created = [];
export function tempDir(prefix = 'deckhand-test-') {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  created.push(dir);
  return dir;
}

export function removeTempDirs() {
  while (created.length) fs.rmSync(created.pop(), { recursive: true, force: true });
}

export function readStream(name) {
  return fs.readFileSync(path.join(STREAMS, name), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

export function readAgentLog(logPath, { mode } = {}) {
  if (!fs.existsSync(logPath)) return [];
  const entries = fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  return mode ? entries.filter((e) => e.mode === mode) : entries;
}

export function workOrder(deckName, notes) {
  const lines = notes.map((n) => `- [ ] ${n.id}: ${n.target || 'heading on slide 1'}\n  ${n.text}`);
  return `# Deckhand work order: ${deckName}\n\nApply each note, then tick its box.\n\n## Notes\n\n${lines.join('\n\n')}\n`;
}

export function makeStaging({ deck = 'basic.html', name = 'deck.html', notes = [{ id: 'n_one', text: 'Make it bolder' }] } = {}) {
  const dir = tempDir('deckhand-run-');
  fs.copyFileSync(path.join(DECKS, deck), path.join(dir, name));
  if (notes) fs.writeFileSync(path.join(dir, name.replace(/\.html?$/, '.deckhand.md')), workOrder(name, notes));
  return dir;
}

export function runFake(tool, args, { stdin = '', cwd = process.cwd(), env = {}, agents, timeout = 10000 } = {}) {
  const bin = path.join(agentBinDir(agents), tool);
  const childEnv = {
    PATH: `${agentBinDir(agents)}:${nodeBinDir()}`,
    HOME: env.HOME || os.tmpdir(),
    ...env,
  };
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd, env: childEnv, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`fake ${tool} timed out\n${stderr}`)); }, timeout);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      const lines = stdout.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return l; } });
      resolve({ code, signal, stdout, stderr, lines });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(stdin);
  });
}

export function spawnFake(tool, args, { stdin = '', cwd = process.cwd(), env = {}, agents } = {}) {
  const child = spawn(path.join(agentBinDir(agents), tool), args, {
    cwd,
    env: { PATH: `${agentBinDir(agents)}:${nodeBinDir()}`, HOME: os.tmpdir(), ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: true,
  });
  child.stdin.on('error', () => {});
  child.stdin.end(stdin);
  return child;
}
