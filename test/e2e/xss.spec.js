import fs from 'node:fs/promises';
import path from 'node:path';
import { test, expect } from './fixtures.js';

const EVIL = '<img src=x onerror=alert(1)>';

test.use({ allowedConsoleErrors: [/\/deckroot\/[^?]*\.deckhand\.json(\?|$)/] });

test.beforeEach(async ({ deckhand }) => {
  await fs.mkdir(path.join(deckhand.home, EVIL));
  await fs.writeFile(
    path.join(deckhand.home, `${EVIL}.html`),
    '<!DOCTYPE html><html><head><title>x</title></head><body><section class="slide"><h1>Hello</h1></section></body></html>',
  );
});

test('file and folder names render as literal text in Browse', async ({ page, deckhand }) => {
  await page.goto(deckhand.url);
  await page.getByRole('button', { name: 'Browse…' }).click();
  const browse = page.locator('.browse-list');
  await expect(browse.getByText(`${EVIL}.html`, { exact: true })).toBeVisible();
  await expect(browse.getByText(EVIL, { exact: true })).toBeVisible();
  await expect(page.locator('#app img')).toHaveCount(0);
});

test('deck name renders as literal text in the top bar', async ({ page, deckhand }) => {
  await page.goto(deckhand.url);
  await page.getByRole('button', { name: 'Browse…' }).click();
  await page.locator('.browse-list').getByText(`${EVIL}.html`, { exact: true }).click();
  await expect(page.locator('.sb-file')).toContainText(path.join(deckhand.home, `${EVIL}.html`));
  await expect(page.frameLocator('iframe#deck').locator('h1')).toHaveText('Hello');
  await expect(page.locator('#app img')).toHaveCount(0);
});
