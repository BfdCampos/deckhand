import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

export const DETECT_TIMEOUT_MS = 3000;

export function findBin(bin, dirs) {
  for (const dir of dirs) {
    if (!dir) continue;
    const p = path.join(dir, bin);
    try {
      if (!fs.statSync(p).isFile()) continue;
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch { /* keep looking */ }
  }
  return null;
}

export function capture(bin, args, { timeoutMs = DETECT_TIMEOUT_MS, env = process.env } = {}) {
  return new Promise((resolve) => {
    let stdout = '';
    let done = false;
    let child;
    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ stdout, ...result });
    };
    const timer = setTimeout(() => {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ }
      finish({ code: null, timedOut: true });
    }, timeoutMs);
    try {
      child = spawn(bin, args, { env, stdio: ['ignore', 'pipe', 'ignore'], detached: true });
    } catch {
      finish({ code: null, timedOut: false });
      return;
    }
    child.stdout.on('data', (d) => { if (stdout.length < 256 * 1024) stdout += d; });
    child.on('error', () => finish({ code: null, timedOut: false }));
    child.on('close', (code) => finish({ code, timedOut: false }));
  });
}

export function searchDirs(envPath = '', extraDirs = []) {
  return [...new Set([...envPath.split(path.delimiter), ...extraDirs].filter(Boolean))];
}

export async function detectOne(adapter, { dirs, env, timeoutMs = DETECT_TIMEOUT_MS }) {
  const binPath = findBin(adapter.bin, dirs);
  if (!binPath) return { id: adapter.id, found: false, path: null, version: null, flags: null };
  const [version, probe] = await Promise.all([
    capture(binPath, ['--version'], { timeoutMs, env }),
    adapter.probe(binPath, { timeoutMs, env }),
  ]);
  return {
    id: adapter.id,
    found: true,
    path: binPath,
    version: version.code === 0 ? adapter.parseVersion(version.stdout) : null,
    flags: probe.flags,
  };
}

export function flagsIn(helpText, wanted) {
  if (!helpText) return null;
  const present = new Set(helpText.match(/--[a-z][a-z0-9-]*/g) || []);
  return new Set(wanted.filter((f) => present.has(f)));
}
