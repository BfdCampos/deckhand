import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from './fixtures.js';

test.use({ deckhandOptions: { deck: 'test/fixtures/decks/basic.html' } });

test('deck reloads never add history entries, so Back returns to the app and not a stale deck', async ({ page, deckhand }) => {
  const other = path.join(deckhand.home, 'other.html');
  const src = '<!DOCTYPE html><html><head><title>Other</title></head><body><section class="slide"><h1>Other v0</h1></section></body></html>';
  fs.writeFileSync(other, src);

  await page.goto(deckhand.url);
  await expect(page.locator('.topbar-name')).toHaveText('basic.html');
  await page.getByRole('button', { name: '← Home' }).click();
  await page.getByRole('textbox', { name: 'Path to a deck' }).fill(other);
  await page.keyboard.press('Enter');
  const heading = page.frameLocator('iframe#deck').locator('h1');
  await expect(heading).toHaveText('Other v0');
  const before = await page.evaluate(() => history.length);

  for (let i = 1; i <= 3; i++) {
    fs.writeFileSync(other, src.replace('Other v0', `Other v${i}`));
    await expect(heading).toHaveText(`Other v${i}`, { timeout: 5000 });
  }
  expect(await page.evaluate(() => history.length)).toBe(before);

  await page.goBack();
  await expect(page).toHaveURL(`${deckhand.url}/`);
  await expect(page.locator('.landing')).toBeVisible();
  expect(fs.readFileSync(other, 'utf8')).toContain('Other v3');
  expect(fs.readFileSync(deckhand.deckPath, 'utf8')).toContain('Basic deck');
});
