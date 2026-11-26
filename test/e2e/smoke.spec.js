import fs from 'node:fs/promises';
import { test, expect } from './fixtures.js';

test.use({ deckhandOptions: { deck: 'samples/sample-deck.html' } });

test('opens the sample deck, edits a heading, and the file on disk changes', async ({ page, deckhand }) => {
  await page.goto(deckhand.url);
  await expect(page.locator('.topbar-name')).toHaveText('sample-deck.html');

  const heading = page.frameLocator('iframe#deck').locator('h2[data-ai-id="dh4"]');
  await heading.scrollIntoViewIfNeeded();
  await heading.dblclick();
  await expect(heading).toHaveAttribute('contenteditable', 'true');
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type('Edited by hand');
  await page.locator('.sidebar .sb-head').click();
  await expect(heading).not.toHaveAttribute('contenteditable', 'true');

  await expect.poll(() => fs.readFile(deckhand.deckPath, 'utf8'), { timeout: 5000 })
    .toContain('<h2 data-ai-id="dh4">Edited by hand</h2>');
  const saved = await fs.readFile(deckhand.deckPath, 'utf8');
  expect(saved).not.toContain('contenteditable');
  expect(saved).not.toContain('dh-style');
});
