import path from 'node:path';
import { test, expect } from './fixtures.js';
import { makeDeck, realHome, postApi, getApi, openAsRecent, openHome } from './home-helpers.js';
import { addNotes } from './runs-helpers.js';

const LONG = 'DS DA(ML) Training for the New Data Architecture 2fb69fe426d2805db7abc4af54308d96.html';

const inside = (inner, outer) => inner.x >= outer.x - 0.5 && inner.x + inner.width <= outer.x + outer.width + 0.5
  && inner.y >= outer.y - 0.5 && inner.y + inner.height <= outer.y + outer.height + 0.5;

async function box(locator) {
  const b = await locator.boundingBox();
  expect(b, 'element should be rendered').not.toBeNull();
  return b;
}

async function shownName(locator) {
  return locator.evaluate((el) => {
    const head = el.querySelector('.fname-head');
    const tail = el.querySelector('.fname-tail');
    return { head: head.textContent, tail: tail.textContent, clipped: head.scrollWidth > head.clientWidth + 1 };
  });
}

test.use({ deckhandOptions: { agents: ['claude'] } });

for (const colorScheme of ['light', 'dark']) {
  test(`a long deck name stays inside the Continue editing pill (${colorScheme})`, async ({ page, deckhand }) => {
    await page.emulateMedia({ colorScheme });
    const deck = makeDeck(path.join(realHome(deckhand), 'Downloads'), LONG);
    await postApi(deckhand, '/api/deck/open', { path: deck });
    for (const width of [800, 1280, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await openHome(page, deckhand);
      const pill = page.locator('.home-continue');
      await expect(pill).toBeVisible();
      const p = await box(pill);
      expect(inside(p, await box(page.locator('.home-hero')))).toBe(true);
      expect(inside(await box(pill.locator('.icon-deck')), p)).toBe(true);
      expect(inside(await box(pill.locator('.icon-arrow-right')), p)).toBe(true);
      const name = await shownName(pill);
      expect(name.head.startsWith('DS DA(ML) Training')).toBe(true);
      expect(name.tail.endsWith('.html')).toBe(true);
      expect((name.head + name.tail)).toBe(LONG);
      if (width <= 1280) expect(name.clipped).toBe(true);
      expect(await pill.getAttribute('title')).toBe(deck);
      expect(await page.evaluate(() => document.scrollingElement.scrollWidth <= window.innerWidth)).toBe(true);
    }
  });
}

test('a long name in recents keeps its start and .html end inside the row', async ({ page, deckhand }) => {
  const deck = makeDeck(path.join(realHome(deckhand), 'Downloads'), LONG);
  await openAsRecent(deckhand, deck);
  for (const width of [800, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await openHome(page, deckhand);
    const row = page.locator('.recent-open').first();
    const r = await box(row);
    expect(inside(r, await box(page.locator('.home-open')))).toBe(true);
    const name = await shownName(row.locator('.recent-name'));
    expect(name.tail.endsWith('.html')).toBe(true);
    expect(name.head + name.tail).toBe(LONG);
    expect(inside(await box(row.locator('.recent-time')), r)).toBe(true);
  }
});

test.describe('while an agent edits a long-named deck', () => {
  test.use({ deckhandOptions: { agents: ['claude'], scenario: 'runs-ui-edit-hang' } });

  test('the editing banner keeps the name and Watch it inside the banner', async ({ page, deckhand }) => {
    const deck = makeDeck(path.join(realHome(deckhand), 'Downloads'), LONG);
    await postApi(deckhand, '/api/deck/open', { path: deck });
    await addNotes(deckhand, [{ text: 'Shorter title', targetTag: 'h1', slide: 1 }]);
    await postApi(deckhand, '/api/runs', { kind: 'edit', scope: 'all' });
    await expect.poll(async () => (await getApi(deckhand, '/api/state')).run?.status).toBe('running');
    for (const width of [800, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await openHome(page, deckhand);
      const banner = page.locator('.home-running');
      await expect(banner).toBeVisible();
      const b = await box(banner);
      expect(inside(b, await box(page.locator('.home-inner')))).toBe(true);
      expect(inside(await box(banner.getByRole('button', { name: 'Watch it' })), b)).toBe(true);
      const name = await shownName(banner);
      expect(name.tail.endsWith('.html')).toBe(true);
    }
  });
});
