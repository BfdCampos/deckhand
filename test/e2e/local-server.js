import { test as base, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

export async function startDeckhand({ deck } = {}) {
  const tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'deckhand-e2e-')));
  const home = path.join(tmp, 'home');
  await fs.mkdir(home);
  let deckPath = null;
  if (deck) {
    const dir = path.join(tmp, 'decks');
    await fs.mkdir(dir);
    deckPath = path.join(dir, path.basename(deck));
    await fs.copyFile(path.resolve(ROOT, deck), deckPath);
  }
  const port = await freePort();
  const args = [path.join(ROOT, 'server.js'), '--port', String(port)];
  if (deckPath) args.push(deckPath);
  const child = spawn(process.execPath, args, {
    cwd: ROOT,
    env: { ...process.env, HOME: home, DECKHAND_TEST: '1', DECKHAND_EXTRA_BIN_DIRS: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Deckhand did not start:\n' + output)), 10000);
    const onData = (chunk) => {
      output += chunk;
      const m = /http:\/\/127\.0\.0\.1:(\d+)/.exec(output);
      if (m) { clearTimeout(timer); resolve(`http://127.0.0.1:${m[1]}`); }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', (chunk) => { output += chunk; });
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`Deckhand exited (${code}):\n${output}`)); });
  });
  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise((r) => child.once('exit', r));
      child.kill('SIGTERM');
      await exited;
    }
    await fs.rm(tmp, { recursive: true, force: true });
  };
  return { url, home, tmp, deckPath, stop };
}

export const test = base.extend({
  deck: ['samples/sample-deck.html', { option: true }],

  deckhand: async ({ deck }, use) => {
    const app = await startDeckhand({ deck });
    await use(app);
    await app.stop();
  },

  guard: [async ({ page }, use) => {
    const problems = [];
    page.on('dialog', (d) => { problems.push(`dialog: ${d.type()} ${d.message()}`); d.dismiss().catch(() => {}); });
    page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
    page.on('console', (m) => {
      if (m.type() !== 'error') return;
      if (/\.deckhand\.json/.test(m.location().url || '')) return;
      problems.push(`console.error: ${m.text()}`);
    });
    await use(problems);
    expect(problems).toEqual([]);
  }, { auto: true }],
});

export { expect };
