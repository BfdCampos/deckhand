import fs from 'node:fs/promises';
import { test, expect } from './fixtures.js';
import { BASIC, THREE, addNotes, openEditor as openWithRuns, handoff, card } from './runs-helpers.js';
import { deckFrame, readDisk, openEditor, openDeckAt, writeDeck, diskEventually, blurEditing, dragBy, addImage } from './editor-helpers.js';

test.use({ deckhandOptions: { deck: BASIC } });

async function wordCentre(page, selector, word) {
  const inFrame = await page.frameLocator('iframe#deck').locator(selector).evaluate((el, w) => {
    const walker = el.ownerDocument.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const i = n.data.lastIndexOf(w);
      if (i === -1) continue;
      const r = el.ownerDocument.createRange();
      r.setStart(n, i);
      r.setEnd(n, i + w.length);
      const b = r.getBoundingClientRect();
      return { x: b.left + b.width / 2, y: b.top + b.height / 2, right: b.right };
    }
    return null;
  }, word);
  const frame = await page.locator('iframe#deck').boundingBox();
  return { x: frame.x + inFrame.x, y: frame.y + inFrame.y, right: frame.x + inFrame.right };
}

test('F-M1 double-click selects the word under the pointer and typing replaces it', async ({ page, deckhand }) => {
  await openEditor(page, deckhand);
  const h1 = deckFrame(page).locator('h1');
  const at = await wordCentre(page, 'h1', 'deck');
  await page.mouse.dblclick(at.x, at.y);
  await expect(h1).toHaveAttribute('contenteditable', 'true');
  await page.keyboard.type('slides');
  await expect(h1).toHaveText('Basic slides');

  await blurEditing(page);
  const end = await wordCentre(page, 'h1', 'slides');
  await page.mouse.dblclick(end.right + 60, end.y);
  await page.keyboard.type(' again');
  await blurEditing(page);
  await diskEventually(deckhand.deckPath, (s) => s.includes('>Basic slides again</h1>'));
});

test.describe('F-m2 images in agent-made layouts', () => {
  test.use({ deckhandOptions: {} });
  const DECK = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Agent deck</title><style>
  html, body { margin: 0; }
  .slide { box-sizing: border-box; height: 100vh; padding: 48px; display: flex; gap: 32px; align-items: center; }
  .col { flex: 1; } .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
</style></head><body>
<section class="slide"><div class="col"><h1>Team offsite</h1><p>Agenda for the day</p></div><div class="col grid"><p>One</p><p>Two</p><p>Three</p><p>Four</p></div></section>
<section class="slide"><h2>Second</h2></section>
</body></html>
`;

  test('a new image floats over the slide without reflowing it or scrolling the stage', async ({ page, deckhand }) => {
    const file = await writeDeck(deckhand.home, 'agent.html', DECK);
    await openDeckAt(page, deckhand, file);
    const frame = deckFrame(page);
    const before = await frame.locator('h1').boundingBox();
    const grid = await frame.locator('.grid').boundingBox();
    await addImage(page, { width: 400, height: 200 });
    const img = frame.locator('img');
    await expect(img).toBeVisible();
    await diskEventually(file, (s) => /<img data-ai-id="dh\d+" src="deckhand-assets\/[^"]+" style="position: absolute;[^"]*"/.test(s));

    expect(await frame.locator('h1').boundingBox()).toEqual(before);
    expect(await frame.locator('.grid').boundingBox()).toEqual(grid);
    expect(await page.locator('iframe#deck').evaluate((f) => f.contentDocument.scrollingElement.scrollWidth <= f.contentDocument.scrollingElement.clientWidth)).toBe(true);

    const slide = await frame.locator('section').first().boundingBox();
    const box = await img.boundingBox();
    expect(box.x).toBeGreaterThanOrEqual(slide.x);
    expect(box.x + box.width).toBeLessThanOrEqual(slide.x + slide.width + 1);
    expect(Math.abs((box.x + box.width / 2) - (slide.x + slide.width / 2))).toBeLessThan(3);
    expect(box.width).toBeLessThanOrEqual(slide.width * 0.4 + 1);

    const stage = await page.locator('.stage').boundingBox();
    for (const handle of await page.locator('.handle').all()) {
      const hb = await handle.boundingBox();
      expect(hb.x + hb.width).toBeLessThanOrEqual(stage.x + stage.width);
    }

    await dragBy(page, img, 30, 0, { centre: true });
    await diskEventually(file, (s) => /<img[^>]*translate: 30px 0px/.test(s));
    expect(await frame.locator('h1').boundingBox()).toEqual(before);
  });
});

test('the selection overlay is clipped to the stage', async ({ page, deckhand }) => {
  await openEditor(page, deckhand);
  await deckFrame(page).locator('h1').click();
  await expect(page.locator('.sel-box')).toBeVisible();
  const clip = await page.locator('.overlay').evaluate((el) => getComputedStyle(el).clipPath);
  const stage = await page.locator('.stage').boundingBox();
  expect(clip).toContain('inset(');
  const nums = clip.match(/-?[\d.]+px/g).map((v) => parseFloat(v));
  expect(Math.round(nums[0])).toBe(Math.round(stage.y));
  expect(Math.round(nums[3])).toBe(Math.round(stage.x));
});

test.describe('sidebar after a run', () => {
  test.use({ deckhandOptions: { deck: BASIC, agents: ['claude'] } });

  test('F-m4 notes keep their space, cards are never cut and the tweak line sits below them; the header is honest', async ({ page, deckhand }) => {
    await addNotes(deckhand, [...THREE, { text: 'A fourth thought', targetTag: 'h1', slide: 1 }]);
    await openWithRuns(page, deckhand);
    const li = deckFrame(page).locator('li', { hasText: 'First thing' });
    await li.scrollIntoViewIfNeeded();
    await dragBy(page, li, 40, 0);
    await expect(page.locator('.notes-tweaks')).toBeVisible();
    await page.locator('.note-item').first().getByRole('button', { name: 'Run' }).click();
    await expect(card(page).locator('.activity-state')).toHaveText('Done');

    const list = await page.locator('.notes-list').boundingBox();
    expect(list.height).toBeGreaterThan(220);
    for (const item of await page.locator('.note-item').all()) {
      expect(await item.evaluate((el) => el.scrollHeight <= el.clientHeight + 1)).toBe(true);
    }
    const tweak = await page.locator('.notes-tweaks').boundingBox();
    expect(tweak.y).toBeGreaterThanOrEqual(list.y + list.height - 1);
    const activity = await page.locator('.sb-section.activity').boundingBox();
    const sidebar = await page.locator('.sidebar').boundingBox();
    expect(activity.height).toBeLessThanOrEqual(sidebar.height * 0.4 + 1);

    await expect(page.locator('.sb-notes .sb-title .pill-count')).toHaveText('3 open');
  });
});
