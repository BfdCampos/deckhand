import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

export { tempDir } from './fakes.js';

const MINIMAL_DECK = '<!doctype html><html><head><title>T</title></head><body><section class="slide"><h1>Hello</h1></section></body></html>';

export async function makeDeck(dir, name = 'deck.html', html = MINIMAL_DECK) {
  const p = path.join(dir, name);
  await fsp.writeFile(p, html);
  return p;
}

export async function makeBin(dir, files) {
  await fsp.mkdir(dir, { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    const p = path.join(dir, name);
    await fsp.writeFile(p, `#!/usr/bin/env node\n${body}\n`);
    await fsp.chmod(p, 0o755);
  }
  return dir;
}

export function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

export async function waitFor(fn, { timeout = 10000, interval = 25 } = {}) {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeout) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, interval));
  }
}

export const exists = (p) => fs.existsSync(p);
