import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const SERVER = path.join(ROOT, 'server.js');
const NODE_DIR = path.dirname(process.execPath);
const live = new Set();
process.on('exit', () => { for (const p of live) { try { p.kill('SIGKILL'); } catch {} } });

export async function tempDir(prefix = 'deckhand-test-') {
  return fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), prefix)));
}

export async function makeDeck(dir, name = 'deck.html', html = '<!doctype html><html><head><title>T</title></head><body><section class="slide"><h1>Hello</h1></section></body></html>') {
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

export async function startDeckhand({ args = [], env = {}, binDir = null, portArgs = ['--port', '0'] } = {}) {
  const home = env.HOME || await tempDir('deckhand-home-');
  const emptyBin = binDir || await tempDir('deckhand-bin-');
  const proc = spawn(process.execPath, [SERVER, ...portArgs, '--no-open', ...args], {
    cwd: ROOT,
    env: {
      HOME: home,
      PATH: `${emptyBin}:${NODE_DIR}:/usr/bin:/bin`,
      DECKHAND_EXTRA_BIN_DIRS: '',
      DECKHAND_TEST: '1',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  let err = '';
  proc.stdout.on('data', (d) => { out += d; });
  proc.stderr.on('data', (d) => { err += d; });
  live.add(proc);
  const exited = new Promise((resolve) => proc.on('exit', (code, signal) => { live.delete(proc); resolve({ code, signal }); }));

  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not start\nstdout:\n${out}\nstderr:\n${err}`)), 5000);
    const check = () => {
      const m = /Deckhand is running at http:\/\/127\.0\.0\.1:(\d+)/.exec(out);
      if (m) { clearTimeout(timer); resolve(Number(m[1])); }
    };
    proc.stdout.on('data', check);
    exited.then(() => { clearTimeout(timer); reject(new Error(`server exited early\nstdout:\n${out}\nstderr:\n${err}`)); });
  });

  const url = `http://127.0.0.1:${port}`;
  return {
    port,
    url,
    home,
    proc,
    exited,
    stdout: () => out,
    stderr: () => err,
    async stop() {
      if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGTERM');
      await exited;
    },
  };
}

export function request(port, { method = 'GET', path: reqPath = '/', headers = {}, body = null, host } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      method,
      path: reqPath,
      setHost: false,
      headers: { Host: host ?? `127.0.0.1:${port}`, Connection: 'close', ...headers },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        const text = buf.toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, headers: res.headers, text, json, buf });
      });
    });
    req.on('error', reject);
    if (body !== null) req.write(body);
    req.end();
  });
}

export function postJson(port, reqPath, obj, headers = {}) {
  return request(port, {
    method: 'POST',
    path: reqPath,
    headers: { 'Content-Type': 'application/json', Origin: `http://127.0.0.1:${port}`, ...headers },
    body: JSON.stringify(obj),
  });
}

export function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

export async function waitFor(fn, { timeout = 3000, interval = 25 } = {}) {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeout) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, interval));
  }
}

export function exists(p) { return fs.existsSync(p); }
