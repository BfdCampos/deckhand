import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { test, expect } from './fixtures.js';
import { tempDir } from '../helpers/fakes.js';
import { editUrl } from './editor-helpers.js';

const SLIDES = 100;

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(body));
  return Buffer.concat([len, body, crc]);
}

function noisePng(width, height, seed) {
  let x = seed * 2654435761 >>> 0;
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let i = 0; i < raw.length; i++) {
    x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0;
    raw[i] = i % (width * 3 + 1) === 0 ? 0 : x & 0xff;
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(raw, { level: 0 })), chunk('IEND', Buffer.alloc(0)),
  ]);
}

function bigDeck() {
  const slides = Array.from({ length: SLIDES }, (_, i) => {
    const img = noisePng(256, 216, i + 1).toString('base64');
    return `<section class="slide"><h2>Slide ${i + 1}</h2><p>Some words for slide ${i + 1}.</p><img alt="" src="data:image/png;base64,${img}"></section>`;
  }).join('\n');
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Big deck</title><style>
    html, body { margin: 0; } .slide { box-sizing: border-box; height: 100vh; padding: 5vw; font-family: system-ui, sans-serif; }
    .slide img { width: 30vw; height: auto; display: block; }
  </style></head><body>
${slides}
</body></html>`;
}

// The 3 s budget is for a modern laptop. Machines that are slower at the same browser work (CI
// runners) get it scaled by how much longer they take over a fixed parse workload, so the check
// follows the editor, not the hardware. CALIBRATION_REF_MS is that workload on the reference laptop.
const READY_BUDGET_MS = 3000;
const CALIBRATION_REF_MS = 52;

function calibrate(page) {
  return page.evaluate(() => {
    const slide = `<section class="slide"><h2>Slide</h2><p>${'word '.repeat(2000)}</p><img alt="" src="data:image/png;base64,${'A'.repeat(200000)}"></section>`;
    const html = `<!DOCTYPE html><html><body>${slide.repeat(100)}</body></html>`;
    const times = [];
    for (let i = 0; i < 3; i++) {
      const t = performance.now();
      const doc = new DOMParser().parseFromString(html, 'text/html');
      if (!doc.querySelectorAll('section, h2, p, img').length) throw new Error('calibration parse failed');
      times.push(performance.now() - t);
    }
    return Math.min(...times);
  });
}

const dir = tempDir('deckhand-perf-');
const deckPath = path.join(dir, 'big-deck.html');
fs.writeFileSync(deckPath, bigDeck());

test.use({ deckhandOptions: { deck: deckPath, agents: ['claude'] } });

test('the 100-slide, 20 MB deck really is that big', () => {
  expect(fs.statSync(deckPath).size).toBeGreaterThan(20 * 1024 * 1024);
});

test('the editor is ready within 3 s on a 100-slide, 20 MB deck', async ({ page, deckhand }, testInfo) => {
  const calibration = await calibrate(page);
  const budget = READY_BUDGET_MS * Math.max(1, calibration / CALIBRATION_REF_MS);
  await page.addInitScript(() => {
    if (window.top !== window) return;
    new MutationObserver((_, observer) => {
      if (!document.body?.hasAttribute('data-ready')) return;
      window.__readyAt = performance.now();
      observer.disconnect();
    }).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-ready'] });
  });
  await page.goto(await editUrl(deckhand));
  await expect(page.locator('body[data-ready]')).toBeAttached({ timeout: 30_000 });
  const ms = Math.round(await page.evaluate(() => window.__readyAt));
  testInfo.annotations.push({ type: 'editor ready', description: `${ms} ms (budget ${Math.round(budget)} ms, calibration ${Math.round(calibration)} ms)` });
  expect(ms).toBeLessThan(budget);
});

test('typing in a heading has no visible lag on the big deck', async ({ page, deckhand }, testInfo) => {
  await page.goto(await editUrl(deckhand));
  await expect(page.locator('body[data-ready]')).toBeAttached({ timeout: 15_000 });
  const heading = page.frameLocator('iframe#deck').locator('h2').first();
  await heading.dblclick();
  await expect(heading).toHaveAttribute('contenteditable', 'true');
  const frame = page.frames().find((f) => f.url().includes('/deckroot/'));
  await frame.evaluate(() => {
    window.__latencies = [];
    let t0 = 0;
    document.addEventListener('keydown', () => { t0 = performance.now(); }, true);
    document.addEventListener('input', () => {
      requestAnimationFrame(() => setTimeout(() => window.__latencies.push(performance.now() - t0), 0));
    }, true);
  });
  await page.keyboard.press('End');
  await page.keyboard.type(' and some more words', { delay: 40 });
  await page.waitForTimeout(200);
  const lat = (await frame.evaluate(() => window.__latencies)).sort((a, b) => a - b);
  expect(lat.length).toBeGreaterThanOrEqual(15);
  const p95 = lat[Math.floor(lat.length * 0.95)];
  testInfo.annotations.push({ type: 'typing latency', description: `median ${lat[Math.floor(lat.length / 2)].toFixed(1)} ms, p95 ${p95.toFixed(1)} ms` });
  expect(p95).toBeLessThan(100);
});
