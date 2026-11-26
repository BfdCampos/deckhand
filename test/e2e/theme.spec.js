import { test, expect } from './fixtures.js';
import { BASIC, openEditor } from './runs-helpers.js';
import { openHome } from './home-helpers.js';

const luminance = (selector) => (sel) => {
  const el = document.querySelector(sel);
  const m = getComputedStyle(el).backgroundColor.match(/[\d.]+/g).map(Number);
  const lin = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * lin(m[0]) + 0.7152 * lin(m[1]) + 0.0722 * lin(m[2]);
};
const lum = (page, sel) => page.evaluate(luminance(sel), sel);

test.describe('in the light appearance', () => {
  test.use({ colorScheme: 'light' });

  test('Home and its cards are light', async ({ page, deckhand }) => {
    await openHome(page, deckhand);
    expect(await lum(page, 'body')).toBeGreaterThan(0.8);
    expect(await lum(page, '.home-create')).toBeGreaterThan(0.8);
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme)).toContain('light');
  });

  test.describe('with a deck', () => {
    test.use({ deckhandOptions: { deck: BASIC, agents: ['claude'] } });

    test('the editor chrome is light and the stage is a neutral backdrop', async ({ page, deckhand }) => {
      await openEditor(page, deckhand);
      expect(await lum(page, '.editor .sidebar')).toBeGreaterThan(0.8);
      expect(await lum(page, '.editor .topbar')).toBeGreaterThan(0.8);
      const stage = await lum(page, '.editor .stage');
      expect(stage).toBeGreaterThan(0.4);
      expect(stage).toBeLessThan(0.85);
    });
  });
});

test.describe('in the dark appearance', () => {
  test.use({ colorScheme: 'dark', deckhandOptions: { deck: BASIC, agents: ['claude'] } });

  test('the editor chrome is dark', async ({ page, deckhand }) => {
    await openEditor(page, deckhand);
    expect(await lum(page, '.editor .sidebar')).toBeLessThan(0.05);
  });

  test('switching the system appearance restyles live, without a reload', async ({ page, deckhand }) => {
    await openEditor(page, deckhand);
    const marker = await page.evaluate(() => { window.__stay = Math.random(); return window.__stay; });
    const dark = { body: await lum(page, 'body'), sidebar: await lum(page, '.editor .sidebar'), button: await lum(page, '.runs-handoff') };
    await page.emulateMedia({ colorScheme: 'light' });
    await expect.poll(() => lum(page, '.editor .sidebar')).toBeGreaterThan(0.8);
    expect(await lum(page, 'body')).toBeGreaterThan(dark.body);
    expect(await page.evaluate(() => window.__stay)).toBe(marker);
    await page.emulateMedia({ colorScheme: 'dark' });
    await expect.poll(() => lum(page, '.editor .sidebar')).toBeLessThan(0.05);
    await expect.poll(async () => Math.abs((await lum(page, '.runs-handoff')) - dark.button)).toBeLessThan(0.02);
  });
});
