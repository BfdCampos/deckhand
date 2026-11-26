import { test, expect } from './fixtures.js';
import {
  deckFrame, readDisk, stripAnchors, openEditor, openDeckAt, writeDeck, diskEventually, blurEditing, caretToEnd, addImage,
} from './editor-helpers.js';

const STATIC = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Static</title><style>
  html, body { margin: 0; }
  .slide { box-sizing: border-box; height: 100vh; padding: 5vw; }
  .slide h2 { font-size: 5vw; margin: 0; }
</style></head><body>
<section class="slide"><h2>One</h2></section>
<section class="slide"><h2>Two</h2><p>Second slide text</p></section>
<section class="slide"><h2>Three</h2></section>
</body></html>
`;

const LAYERED = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Layered</title><style>
  html, body { margin: 0; }
  .slide { position: relative; height: 100vh; }
  .cover { position: absolute; inset: 0; z-index: 3; background: rgba(0, 0, 0, 0.05); }
</style></head><body>
<section class="slide"><div class="cover"><h2>Covered</h2></div></section>
<section class="slide"><h2>Two</h2></section>
</body></html>
`;

async function relativeBox(page, imgSel, slideIndex) {
  return page.locator('iframe#deck').evaluate((f, { imgSel, slideIndex }) => {
    const d = f.contentDocument;
    const s = d.querySelectorAll('section')[slideIndex].getBoundingClientRect();
    const i = d.querySelector(imgSel).getBoundingClientRect();
    return { x: (i.left - s.left) / s.width, y: (i.top - s.top) / s.height, w: i.width / s.width, inside: i.left >= s.left - 1 && i.right <= s.right + 1 && i.top >= s.top - 1 && i.bottom <= s.bottom + 1 };
  }, { imgSel, slideIndex });
}

test.describe('R2-M1 images on static slides', () => {
  test.use({ deckhandOptions: {} });

  test('stay in their slide at the same relative place across viewports, and one undo restores the file', async ({ page, deckhand }) => {
    const file = await writeDeck(deckhand.home, 'static.html', STATIC);
    await openDeckAt(page, deckhand, file);
    await page.locator('.dock-tile').nth(1).click();
    await expect.poll(() => deckFrame(page).locator('section').nth(1).evaluate((s) => Math.round(s.getBoundingClientRect().top))).toBe(0);
    await addImage(page, { width: 400, height: 200 });
    await diskEventually(file, (s) => /<section data-ai-id="dh\d+" style="position: relative;" class="slide"><h2[^>]*>Two/.test(s)
      && /<img data-ai-id="dh\d+" src="deckhand-assets\/[^"]+" style="position: absolute; left: [\d.]+%; top: [\d.]+%; width: [\d.]+%; z-index: \d+;">/.test(s));
    const disk = await readDisk(file);
    expect(disk.indexOf('<img')).toBeGreaterThan(disk.indexOf('>Two</h2>'));
    expect(disk.indexOf('<img')).toBeLessThan(disk.indexOf('>Three</h2>'));

    const at1440 = await relativeBox(page, 'img', 1);
    expect(at1440.inside).toBe(true);
    for (const size of [{ width: 1024, height: 600 }, { width: 1920, height: 1080 }]) {
      await page.setViewportSize(size);
      await page.waitForTimeout(300);
      const box = await relativeBox(page, 'img', 1);
      expect(box.inside).toBe(true);
      expect(Math.abs(box.x - at1440.x)).toBeLessThan(0.02);
      expect(Math.abs(box.y - at1440.y)).toBeLessThan(0.02);
      expect(Math.abs(box.w - at1440.w)).toBeLessThan(0.02);
    }

    await page.locator('.sidebar .sb-head').click();
    await page.keyboard.press('ControlOrMeta+z');
    await diskEventually(file, (s) => stripAnchors(s) === STATIC);
    await expect(deckFrame(page).locator('img')).toHaveCount(0);
  });
});

test.describe('QA1 nits', () => {
  test.use({ deckhandOptions: {} });

  test('a new image sits above the slide\'s positioned content', async ({ page, deckhand }) => {
    const file = await writeDeck(deckhand.home, 'layered.html', LAYERED);
    await openDeckAt(page, deckhand, file);
    await addImage(page, { width: 200, height: 100 });
    const img = deckFrame(page).locator('img');
    await expect(img).toBeVisible();
    const top = await img.evaluate((el) => {
      const r = el.getBoundingClientRect();
      return el.ownerDocument.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) === el;
    });
    expect(top).toBe(true);
  });

  test('dock numbers sit in the bottom-right corner, clear of slide titles', async ({ page, deckhand }) => {
    const file = await writeDeck(deckhand.home, 'static.html', STATIC);
    await openDeckAt(page, deckhand, file);
    for (const tile of await page.locator('.dock-tile').all()) {
      const t = await tile.boundingBox();
      const n = await tile.locator('.dock-num').boundingBox();
      expect(n.x).toBeGreaterThan(t.x + t.width / 2);
      expect(n.y).toBeGreaterThan(t.y + t.height / 2);
    }
  });
});

test.describe('conflict undo', () => {
  test.use({ deckhandOptions: { deck: 'test/fixtures/decks/basic.html' }, allowedConsoleErrors: [/status of 409/] });

  test('Cmd+Z right after Keep mine undoes the kept text', async ({ page, deckhand }) => {
    await openEditor(page, deckhand);
    const other = await page.context().newPage();
    await openEditor(other, deckhand);
    const mine = deckFrame(page).locator('h1');
    await mine.dblclick();
    await caretToEnd(mine);
    await page.keyboard.type(' from tab one');
    const theirs = deckFrame(other).locator('h1');
    await theirs.dblclick();
    await caretToEnd(theirs);
    await other.keyboard.type(' from tab two');
    await blurEditing(other);
    await diskEventually(deckhand.deckPath, (s) => s.includes('>Basic deck from tab two</h1>'));
    await blurEditing(page);
    await page.locator('.banner', { hasText: 'changed in another tab' }).getByRole('button', { name: 'Keep mine' }).click();
    await diskEventually(deckhand.deckPath, (s) => s.includes('>Basic deck from tab one</h1>'));
    await expect(page.locator('.save-status')).toHaveText('Saved');
    await page.keyboard.press('ControlOrMeta+z');
    await diskEventually(deckhand.deckPath, (s) => s.includes('>Basic deck from tab two</h1>'));
    await expect(mine).toHaveText('Basic deck from tab two');
    await other.close();
  });
});
