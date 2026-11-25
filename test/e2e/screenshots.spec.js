import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from './fixtures.js';
import { SCREENS, screen, settle } from './screens.js';

const OUT = path.join(path.dirname(new URL(import.meta.url).pathname), '../../test-results/screenshots');

const SIZES = {
  home: [{ width: 1440, height: 900 }, { width: 1280, height: 800 }, { width: 800, height: 1000 }],
  editor: [{ width: 1440, height: 900 }, { width: 1280, height: 800 }],
};

for (const s of SCREENS) {
  for (const size of SIZES[s.name] || [{ width: 1440, height: 900 }]) {
    test.describe(`${s.name} ${size.width}x${size.height}`, () => {
      test.use({ deckhandOptions: s.options, viewport: size, contextOptions: { reducedMotion: 'reduce' } });

      test(`AC-70 screenshot of ${s.name} at ${size.width}x${size.height}`, async ({ page, deckhand }) => {
        await s.go(page, deckhand);
        await settle(page);
        fs.mkdirSync(OUT, { recursive: true });
        const file = path.join(OUT, `${s.name}-${size.width}x${size.height}.png`);
        await page.screenshot({ path: file, animations: 'disabled' });
        expect(fs.statSync(file).size).toBeGreaterThan(1000);
      });
    });
  }
}

test.describe('browse at 800 wide', () => {
  test.use({ deckhandOptions: screen('browse').options, viewport: { width: 800, height: 1000 } });

  test('AC-70 screenshot of the Browse modal on a narrow window', async ({ page, deckhand }) => {
    await screen('browse').go(page, deckhand);
    await settle(page);
    fs.mkdirSync(OUT, { recursive: true });
    await page.screenshot({ path: path.join(OUT, 'browse-800x1000.png'), animations: 'disabled' });
  });
});
