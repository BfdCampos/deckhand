import fs from 'node:fs/promises';
import path from 'node:path';
import { test, expect } from './fixtures.js';
import { deckFrame, openEditor, diskEventually, addImage, png } from './editor-helpers.js';

test.use({ deckhandOptions: { deck: 'test/fixtures/decks/basic.html' } });

const assetsDir = (deckhand) => path.join(path.dirname(deckhand.deckPath), 'deckhand-assets');

async function pasteInDeck(page, { name, type, bytes }) {
  await page.locator('iframe#deck').evaluate((frame, { name, type, bytes }) => {
    const doc = frame.contentDocument;
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array(bytes)], name, { type }));
    doc.body.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }, { name, type, bytes: [...bytes] });
}

test('AC-30 "+ Image" uploads, inserts on the current slide, selects and saves', async ({ page, deckhand }) => {
  await openEditor(page, deckhand);
  await addImage(page, { name: 'logo.png' });
  const img = deckFrame(page).locator('section').first().locator('img');
  await expect(img).toBeVisible();
  await expect(page.locator('.handle').first()).toBeVisible();
  await diskEventually(deckhand.deckPath, (s) => /<img data-ai-id="dh\d+" src="deckhand-assets\/[^"]*logo[^"]*\.png" style="position: absolute; left: [\d.]+%; top: [\d.]+%; width: [\d.]+%; z-index: \d+;">/.test(s));
  const files = await fs.readdir(assetsDir(deckhand));
  expect(files.some((f) => /logo.*\.png$/.test(f))).toBe(true);
});

test('AC-30 pasting an image with the real shortcut inserts it too', async ({ page, deckhand }) => {
  await openEditor(page, deckhand);
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: deckhand.url });
  await page.evaluate(async (b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': new Blob([bytes], { type: 'image/png' }) })]);
  }, png(20, 10).toString('base64'));
  await page.locator('iframe#deck').click({ position: { x: 600, y: 300 } });
  await page.keyboard.press('ControlOrMeta+v');
  await expect(deckFrame(page).locator('img')).toBeVisible();
  await diskEventually(deckhand.deckPath, (s) => /<img data-ai-id="dh\d+" src="deckhand-assets\/[^"]*\.png"/.test(s));
});

test.describe('rejected uploads', () => {
  test.use({ allowedConsoleErrors: [/status of 41[35]/] });

  test('AC-31 a non-image is refused with a toast', async ({ page, deckhand }) => {
    await openEditor(page, deckhand);
    await pasteInDeck(page, { name: 'notes.png', type: 'image/png', bytes: Buffer.from('definitely not a picture') });
    await expect(page.locator('.toast')).toBeVisible();
    await expect(page.locator('.toast-error')).toHaveCount(1);
    await expect(deckFrame(page).locator('img')).toHaveCount(0);
  });

  test('AC-31 an image over 20 MB is refused with the size toast', async ({ page, deckhand }) => {
    await openEditor(page, deckhand);
    const big = Buffer.concat([png(4, 4), Buffer.alloc(21 * 1024 * 1024)]);
    await addImage(page, { name: 'huge.png', buffer: big });
    await expect(page.locator('.toast')).toContainText('That image is over 20 MB. Try a smaller one.');
    await expect(deckFrame(page).locator('img')).toHaveCount(0);
  });
});
