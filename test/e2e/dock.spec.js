import fs from 'node:fs';
import { test, expect } from './fixtures.js';
import { editUrl } from './editor-helpers.js';

test.use({
  deckhandOptions: { deck: 'test/fixtures/decks/basic.html' },
  allowedConsoleErrors: [/deckhand\.json|Content Security Policy|Failed to load resource|Failed to fetch/],
});

test('slide scripts never run in dock thumbnails, so they cannot reach the API', async ({ page, deckhand }) => {
  const src = fs.readFileSync(deckhand.deckPath, 'utf8')
    .replace('<p>The first slide.</p>', '<p>The first slide.</p><img src="missing.png" onerror="fetch(\'/api/fs?dir=/\')">');
  fs.writeFileSync(deckhand.deckPath, src);
  const hits = [];
  page.on('request', (req) => { if (new URL(req.url()).pathname.startsWith('/api/fs')) hits.push(req.frame()?.url() || '?'); });

  await page.goto(await editUrl(deckhand));
  await expect(page.locator('.dock-thumb')).toHaveCount(3);
  for (const thumb of await page.locator('.dock-thumb').all()) {
    await expect(thumb).toHaveAttribute('sandbox', 'allow-same-origin');
  }
  await page.waitForTimeout(800);
  expect(hits).toEqual([]);
});
