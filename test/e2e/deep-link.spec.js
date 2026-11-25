import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from './fixtures.js';

test.use({
  deckhandOptions: { deck: 'test/fixtures/decks/basic.html' },
  allowedConsoleErrors: [/\/deckroot\/[^?]*\.deckhand\.json(\?|$)/],
});

const OTHER = '<!DOCTYPE html><html><head><title>Other</title></head><body><section class="slide"><h1>Other deck</h1></section></body></html>';

function makeOther(deckhand, name = 'other.html') {
  const p = path.join(deckhand.home, name);
  fs.writeFileSync(p, OTHER);
  return p;
}

function trackOpens(page) {
  const opens = [];
  page.on('request', (req) => { if (new URL(req.url()).pathname === '/api/open') opens.push(req.postDataJSON()); });
  return opens;
}

async function boundPath(page, deckhand) {
  const res = await page.request.get(`${deckhand.url}/api/state`);
  const s = await res.json();
  return s.deckPath || s.deck?.path || null;
}

test('a deep link to a different file asks first and opens nothing by itself', async ({ page, deckhand }) => {
  const other = makeOther(deckhand);
  const opens = trackOpens(page);
  await page.goto(`${deckhand.url}/edit?deck=${encodeURIComponent(other)}`);
  const confirm = page.getByRole('dialog', { name: 'Open this deck?' });
  await expect(confirm).toBeVisible();
  await expect(confirm.locator('.mono')).toHaveText(other);
  await page.waitForTimeout(300);
  expect(opens).toEqual([]);
  expect(await boundPath(page, deckhand)).toBe(deckhand.deckPath);
  expect(fs.readFileSync(other, 'utf8')).toBe(OTHER);

  await confirm.getByRole('button', { name: 'Open' }).click();
  await expect(page.locator('.sb-file')).toContainText(other);
  expect(opens).toEqual([{ path: other }]);
  await expect(page.frameLocator('iframe#deck').locator('h1')).toHaveText('Other deck');
});

test('Cancel on the deep link confirmation goes Home and opens nothing', async ({ page, deckhand }) => {
  const other = makeOther(deckhand);
  const opens = trackOpens(page);
  await page.goto(`${deckhand.url}/edit?deck=${encodeURIComponent(other)}`);
  await page.getByRole('dialog', { name: 'Open this deck?' }).getByRole('button', { name: 'Cancel' }).click();
  await expect(page).toHaveURL(`${deckhand.url}/`);
  await expect(page.locator('.landing')).toBeVisible();
  expect(opens).toEqual([]);
  expect(await boundPath(page, deckhand)).toBe(deckhand.deckPath);
});

test('a deep link to the deck the server already has open goes straight in', async ({ page, deckhand }) => {
  const opens = trackOpens(page);
  await page.goto(`${deckhand.url}/edit?deck=${encodeURIComponent(deckhand.deckPath)}`);
  await expect(page.locator('.sb-file')).toContainText(deckhand.deckPath);
  await expect(page.getByRole('dialog', { name: 'Open this deck?' })).toHaveCount(0);
  expect(opens).toEqual([]);
});

test('a tab editing one deck does not silently switch when another tab opens a different deck', async ({ page, context, deckhand }) => {
  const other = makeOther(deckhand);
  await page.goto(deckhand.url);
  await expect(page.locator('.sb-file')).toContainText(deckhand.deckPath);
  const sent = [];
  page.on('websocket', (ws) => ws.on('framesent', (f) => sent.push(String(f.payload))));
  await expect(page.frameLocator('iframe#deck').locator('h1')).toHaveText('Basic deck');

  const second = await context.newPage();
  await second.goto(`${deckhand.url}/edit?deck=${encodeURIComponent(other)}`);
  await second.getByRole('dialog', { name: 'Open this deck?' }).getByRole('button', { name: 'Open' }).click();
  await expect(second.locator('.sb-file')).toContainText(other);

  const notice = page.locator('.editor-elsewhere');
  await expect(notice).toContainText('Another tab opened other.html.');
  await expect(page.locator('.sb-file')).toContainText(deckhand.deckPath);
  await expect(page.frameLocator('iframe#deck').locator('h1')).toHaveText('Basic deck');
  expect(await page.locator('.editor .stage').evaluate((el) => el.inert)).toBe(true);
  expect(await page.locator('.editor .sidebar').evaluate((el) => el.inert)).toBe(true);

  await page.evaluate(() => document.querySelector('iframe#deck').contentDocument.dispatchEvent(new Event('paste')));
  await page.waitForTimeout(600);
  expect(sent.filter((m) => m.includes('save-html') || m.includes('save-notes'))).toEqual([]);
  expect(fs.readFileSync(other, 'utf8')).toBe(OTHER);

  await notice.getByRole('button', { name: 'Switch to it' }).click();
  await expect(page.locator('.sb-file')).toContainText(other);
  await expect(page.frameLocator('iframe#deck').locator('h1')).toHaveText('Other deck');
  await expect(notice).toBeHidden();
  expect(await page.locator('.editor .stage').evaluate((el) => el.inert)).toBe(false);
});

test('Go Home from the other-tab notice leaves the editor', async ({ page, context, deckhand }) => {
  const other = makeOther(deckhand);
  await page.goto(deckhand.url);
  await expect(page.locator('.sb-file')).toContainText(deckhand.deckPath);
  const second = await context.newPage();
  await second.goto(`${deckhand.url}/edit?deck=${encodeURIComponent(other)}`);
  await second.getByRole('dialog', { name: 'Open this deck?' }).getByRole('button', { name: 'Open' }).click();
  await expect(second.locator('.sb-file')).toContainText(other);

  await page.locator('.editor-elsewhere').getByRole('button', { name: 'Go Home' }).click();
  await expect(page.locator('.landing')).toBeVisible();
  await expect(page).toHaveURL(`${deckhand.url}/`);
});
