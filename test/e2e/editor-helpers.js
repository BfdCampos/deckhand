import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { expect } from './fixtures.js';

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export const deckFrame = (page) => page.frameLocator('iframe#deck');

export const readDisk = (file) => fs.readFile(file, 'utf8');

export const stripAnchors = (html) => html.replace(/ data-ai-id="dh\d+"/g, '');

export const sidecar = (deckPath, ext) => deckPath.replace(/\.html?$/i, `.deckhand.${ext}`);

export async function frameGen(page) {
  return Number(await page.locator('body').getAttribute('data-ready')) || 0;
}

export async function openEditor(page, deckhand, query = '') {
  await page.goto(deckhand.url + query);
  await expect(page.locator('body[data-ready]')).toBeAttached({ timeout: 10_000 });
  return frameGen(page);
}

export async function openDeckAt(page, deckhand, deckPath) {
  await page.goto(deckhand.url);
  const home = page.locator('.landing');
  await expect(page.locator('.landing:not([hidden]), .editor:not([hidden])').first()).toBeVisible();
  if (!(await home.isVisible())) await page.getByRole('button', { name: '← Home' }).click();
  const field = page.locator('.picker-manual input');
  await field.fill(deckPath);
  await field.press('Enter');
  await expect(page.locator('body[data-ready]')).toBeAttached({ timeout: 10_000 });
  return frameGen(page);
}

export async function waitForReload(page, sinceGen) {
  await expect.poll(() => frameGen(page), { timeout: 5_000 }).toBeGreaterThan(sinceGen);
}

export async function expectSaved(page) {
  await expect(page.locator('.save-status')).toHaveText('Saved');
}

export async function diskEventually(file, check, timeout = 3_000) {
  await expect.poll(async () => {
    try {
      return check(await readDisk(file));
    } catch (e) {
      if (e.code === 'ENOENT') return false;
      throw e;
    }
  }, { timeout }).toBe(true);
}

export async function blurEditing(page) {
  await page.locator('.sidebar .sb-head').click();
}

export async function dragBy(page, locator, dx, dy) {
  const box = await locator.boundingBox();
  const x = box.x + Math.min(20, box.width / 2);
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx / 2, y + dy / 2, { steps: 4 });
  await page.mouse.move(x + dx, y + dy, { steps: 4 });
  await page.mouse.up();
}

export async function writeDeck(dir, name, html) {
  const file = path.join(dir, name);
  await fs.writeFile(file, html);
  return file;
}

function crc32(buf) {
  let c;
  let crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

export function png(width, height, rgb = [255, 79, 64]) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: width }, () => rgb).flat())]);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

export async function addImage(page, { name = 'wide.png', width = 200, height = 100, buffer } = {}) {
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Image', exact: true }).click();
  await (await chooser).setFiles({ name, mimeType: 'image/png', buffer: buffer ?? png(width, height) });
}

export async function caretToEnd(locator) {
  await locator.evaluate((el) => {
    const range = el.ownerDocument.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    const sel = el.ownerDocument.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  });
}
