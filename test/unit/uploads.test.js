import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { startDeckhand } from '../helpers/deckhand.js';
import { request } from '../helpers/http.js';
import { tempDir, makeDeck } from '../helpers/util.js';

const MB = 1024 * 1024;
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32)]);
const GIF = Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(32)]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0x20, 0, 0, 0]), Buffer.from('WEBPVP8 '), Buffer.alloc(24)]);
const SVG = Buffer.from('﻿<?xml version="1.0" encoding="UTF-8"?>\n<!-- drawn by hand -->\n<!DOCTYPE svg>\n<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><rect width="4" height="4"/></svg>');

function upload(port, body, { type = 'image/png', name = 'photo.png', origin, extra = {} } = {}) {
  const headers = { Origin: origin ?? `http://127.0.0.1:${port}`, ...extra };
  if (type) headers['Content-Type'] = type;
  if (name !== null) headers['X-Filename'] = name;
  return request(port, { method: 'POST', path: '/api/assets', headers, body });
}

function chunkedUpload(port, total, chunk = MB) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, method: 'POST', path: '/api/assets', setHost: false,
      headers: { Host: `127.0.0.1:${port}`, Origin: `http://127.0.0.1:${port}`, 'Content-Type': 'image/png', 'X-Filename': 'big.png', 'Transfer-Encoding': 'chunked' },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(Buffer.concat(chunks).toString() || 'null') }));
    });
    req.on('error', reject);
    let sent = 0;
    const first = Buffer.concat([PNG, Buffer.alloc(chunk - PNG.length)]);
    const pump = () => {
      while (sent < total) {
        const ok = req.write(sent === 0 ? first : Buffer.alloc(chunk));
        sent += chunk;
        if (!ok) return req.once('drain', pump);
      }
      req.end();
    };
    pump();
  });
}

describe('uploads', () => {
  let srv, root, deckDir, assets;

  before(async () => {
    root = await tempDir();
    deckDir = path.join(root, 'decks');
    await fsp.mkdir(deckDir);
    await makeDeck(deckDir);
    assets = path.join(deckDir, 'deckhand-assets');
    srv = await startDeckhand({ args: [path.join(deckDir, 'deck.html')] });
  });

  after(async () => { await srv?.stop(); });

  async function listAssets() {
    try { return await fsp.readdir(assets); } catch { return []; }
  }

  test('a PNG is stored under deckhand-assets and served back', async () => {
    const res = await upload(srv.port, PNG);
    assert.equal(res.status, 200, res.text);
    assert.match(res.json.url, /^deckhand-assets\/\d+-photo\.png$/);
    const name = res.json.url.split('/')[1];
    assert.deepEqual(await fsp.readFile(path.join(assets, name)), PNG);
    const served = await request(srv.port, { path: '/deckroot/' + res.json.url });
    assert.equal(served.status, 200);
    assert.match(served.headers['content-type'], /image\/png/);
    assert.deepEqual(served.buf, PNG);
  });

  test('type comes from magic bytes, so each image kind gets the right extension', async () => {
    const cases = [[JPEG, 'image/jpeg', 'jpg'], [GIF, 'image/gif', 'gif'], [WEBP, 'image/webp', 'webp'], [SVG, 'image/svg+xml', 'svg'], [JPEG, 'image/png', 'jpg']];
    for (const [buf, type, ext] of cases) {
      const res = await upload(srv.port, buf, { type, name: 'pic.png' });
      assert.equal(res.status, 200, `${type} ${res.text}`);
      assert.match(res.json.url, new RegExp(`^deckhand-assets/\\d+-pic\\.${ext}$`));
    }
  });

  test('uploaded SVGs cannot run script when opened directly', async () => {
    const res = await upload(srv.port, SVG, { type: 'image/svg+xml', name: 'logo.svg' });
    const served = await request(srv.port, { path: '/deckroot/' + res.json.url });
    assert.match(served.headers['content-security-policy'], /sandbox/);
    assert.match(served.headers['content-security-policy'], /script-src 'none'/);
  });

  test('AC-31 non-image content type gets 415', async () => {
    const before = await listAssets();
    for (const type of ['text/plain', 'application/json', 'text/html', null]) {
      const res = await upload(srv.port, PNG, { type });
      assert.equal(res.status, 415, String(type));
      assert.equal(res.json.error.code, 'not_image');
    }
    assert.deepEqual(await listAssets(), before);
  });

  test('AC-31 image type with non-image bytes gets 415', async () => {
    const before = await listAssets();
    const bodies = [
      [Buffer.from('#!/bin/sh\nrm -rf ~\n'), 'image/png'],
      [Buffer.from('<html><script>alert(1)</script></html>'), 'image/svg+xml'],
      [Buffer.from('<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"/>'), 'image/svg+xml'],
      [Buffer.alloc(0), 'image/png'],
    ];
    for (const [buf, type] of bodies) {
      const res = await upload(srv.port, buf, { type });
      assert.equal(res.status, 415, buf.toString().slice(0, 20));
    }
    assert.deepEqual(await listAssets(), before);
  });

  test('AC-31 over 20 MB with Content-Length gets 413 and writes nothing', async () => {
    const before = await listAssets();
    const body = Buffer.concat([PNG, Buffer.alloc(20 * MB + 1 - PNG.length)]);
    const res = await upload(srv.port, body, { name: 'huge.png' });
    assert.equal(res.status, 413);
    assert.equal(res.json.error.code, 'too_large');
    assert.deepEqual(await listAssets(), before);
  });

  test('AC-31 over 20 MB streamed without a length gets 413 and writes nothing', async () => {
    const before = await listAssets();
    const res = await chunkedUpload(srv.port, 21 * MB);
    assert.equal(res.status, 413);
    assert.equal(res.json.error.code, 'too_large');
    assert.deepEqual(await listAssets(), before);
  });

  test('exactly 20 MB is accepted', async () => {
    const body = Buffer.concat([PNG, Buffer.alloc(20 * MB - PNG.length)]);
    const res = await upload(srv.port, body, { name: 'edge.png' });
    assert.equal(res.status, 200, res.text);
    const name = res.json.url.split('/')[1];
    assert.equal((await fsp.stat(path.join(assets, name))).size, 20 * MB);
    await fsp.rm(path.join(assets, name));
  });

  test('AC-62 file names are sanitised and stay inside deckhand-assets', async () => {
    const names = ['../../evil.png', '..\\..\\evil.png', '/etc/passwd', '.hidden.png', 'a b<c>|d.png', encodeURIComponent('café ☕.png'), 'x'.repeat(300) + '.png', ''];
    for (const name of names) {
      const res = await upload(srv.port, PNG, { name });
      assert.equal(res.status, 200, `${name}: ${res.text}`);
      const file = res.json.url.replace(/^deckhand-assets\//, '');
      assert.match(file, /^\d+-[A-Za-z0-9_-][A-Za-z0-9._-]*\.png$/, name);
      assert.ok(file.length <= 100, file);
      assert.ok((await fsp.stat(path.join(assets, file))).isFile());
    }
    const outside = (await fsp.readdir(root)).filter((f) => f !== 'decks');
    assert.deepEqual(outside, []);
    const inDeckDir = (await fsp.readdir(deckDir)).sort();
    assert.deepEqual(inDeckDir, ['deck.html', 'deckhand-assets']);
  });

  test('a missing X-Filename still gets a safe name', async () => {
    const res = await upload(srv.port, PNG, { name: null });
    assert.equal(res.status, 200);
    assert.match(res.json.url, /^deckhand-assets\/\d+-image\.png$/);
  });

  test('foreign Origin cannot upload', async () => {
    const before = await listAssets();
    const res = await upload(srv.port, PNG, { origin: 'https://evil.example' });
    assert.equal(res.status, 403);
    assert.deepEqual(await listAssets(), before);
  });

  test('the old base64 route is gone', async () => {
    const res = await request(srv.port, {
      method: 'POST', path: '/api/asset',
      headers: { 'Content-Type': 'application/json', Origin: `http://127.0.0.1:${srv.port}` },
      body: JSON.stringify({ name: 'x.png', dataUrl: 'data:image/png;base64,' + PNG.toString('base64') }),
    });
    assert.equal(res.status, 404);
  });
});

describe('uploads edge cases', () => {
  test('no deck bound gets 409', async () => {
    const srv = await startDeckhand();
    try {
      const res = await upload(srv.port, PNG);
      assert.equal(res.status, 409);
      assert.equal(res.json.error.code, 'deck_closed');
    } finally {
      await srv.stop();
    }
  });

  test('a deckhand-assets symlink pointing outside the deck folder is refused', async () => {
    const root = await tempDir();
    const deckDir = path.join(root, 'decks');
    const elsewhere = path.join(root, 'elsewhere');
    await fsp.mkdir(deckDir);
    await fsp.mkdir(elsewhere);
    await makeDeck(deckDir);
    await fsp.symlink(elsewhere, path.join(deckDir, 'deckhand-assets'));
    const srv = await startDeckhand({ args: [path.join(deckDir, 'deck.html')] });
    try {
      const res = await upload(srv.port, PNG);
      assert.equal(res.status, 403);
      assert.deepEqual(await fsp.readdir(elsewhere), []);
    } finally {
      await srv.stop();
    }
  });
});
