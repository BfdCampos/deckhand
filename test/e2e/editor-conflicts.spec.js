import fs from 'node:fs/promises';
import { test, expect } from './fixtures.js';
import { deckFrame, openEditor, openDeckAt, writeDeck, diskEventually, blurEditing, caretToEnd } from './editor-helpers.js';

test.use({ deckhandOptions: { deck: 'test/fixtures/decks/basic.html' } });

async function conflict(page, deckhand) {
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
  const banner = page.locator('.banner', { hasText: 'changed in another tab' });
  await expect(banner).toBeVisible();
  return { other, banner, mine };
}

test.describe('R-M1 conflicts stay resolvable', () => {
  test.use({ allowedConsoleErrors: [/status of 409/] });

  test('Keep mine saves my text over theirs and the tab syncs again', async ({ page, deckhand }) => {
    const { other, banner, mine } = await conflict(page, deckhand);
    await page.waitForTimeout(4_000);
    await expect(banner).toBeVisible();
    await expect(page.locator('.save-status')).toContainText("Couldn't save");
    await banner.getByRole('button', { name: 'Keep mine' }).click();
    await diskEventually(deckhand.deckPath, (s) => s.includes('>Basic deck from tab one</h1>'));
    await expect(banner).toHaveCount(0);
    await expect(page.locator('.save-status')).toHaveText('Saved');
    await expect(mine).toHaveText('Basic deck from tab one');

    const h2 = deckFrame(other).locator('h2', { hasText: 'Things to say' });
    await h2.scrollIntoViewIfNeeded();
    await h2.dblclick();
    await caretToEnd(h2);
    await other.keyboard.type(' later');
    await blurEditing(other);
    await expect(deckFrame(page).locator('h2', { hasText: 'Things to say later' })).toHaveCount(1);
    await other.close();
  });

  test('Retry does the same as Keep mine', async ({ page, deckhand }) => {
    const { other, banner } = await conflict(page, deckhand);
    await page.locator('.save-status').getByRole('button', { name: 'Retry' }).click();
    await diskEventually(deckhand.deckPath, (s) => s.includes('>Basic deck from tab one</h1>'));
    await expect(banner).toHaveCount(0);
    await other.close();
  });

  test('Use theirs drops my text, shows theirs and undo works again', async ({ page, deckhand }) => {
    const { other, banner, mine } = await conflict(page, deckhand);
    await banner.getByRole('button', { name: 'Use theirs' }).click();
    await expect(mine).toHaveText('Basic deck from tab two');
    await expect(page.locator('.save-status')).toHaveText('Saved');
    const p = deckFrame(page).locator('section').first().locator('p');
    await p.dblclick();
    await caretToEnd(p);
    await page.keyboard.type(' mine');
    await blurEditing(page);
    await diskEventually(deckhand.deckPath, (s) => s.includes('The first slide. mine</p>'));
    await page.keyboard.press('ControlOrMeta+z');
    await diskEventually(deckhand.deckPath, (s) => s.includes('The first slide.</p>'));
    await other.close();
  });
});

test.describe('R-M2 leaving with unsaved changes', () => {
  test.use({ allowedConsoleErrors: [/status of 500/] });

  test('Home asks first, Keep editing stays, and a close is guarded', async ({ page, deckhand }) => {
    const blocker = `${deckhand.deckPath}.deckhand-tmp`;
    await openEditor(page, deckhand);
    const p = deckFrame(page).locator('section').first().locator('p');
    await fs.mkdir(blocker);
    try {
      await p.dblclick();
      await caretToEnd(p);
      await page.keyboard.type(' unsaved');
      await blurEditing(page);
      await expect(page.locator('.save-status')).toContainText("Couldn't save");
      expect(await page.evaluate(() => {
        const e = new Event('beforeunload', { cancelable: true });
        window.dispatchEvent(e);
        return e.defaultPrevented;
      })).toBe(true);

      await page.getByRole('button', { name: '← Home' }).click();
      const dialog = page.getByRole('dialog', { name: 'Leave without saving?' });
      await expect(dialog).toContainText("You have changes that haven't saved.");
      await dialog.getByRole('button', { name: 'Keep editing' }).click();
      await expect(page.locator('.topbar-name')).toHaveText('basic.html');
      await expect(p).toHaveText('The first slide. unsaved');

      await page.getByRole('button', { name: '← Home' }).click();
      await page.getByRole('dialog', { name: 'Leave without saving?' }).getByRole('button', { name: 'Leave without saving' }).click();
      await expect(page.locator('.home')).toBeVisible();
    } finally {
      await fs.rm(blocker, { recursive: true, force: true });
    }
  });

  test('a saved deck leaves straight away and has no close guard', async ({ page, deckhand }) => {
    await openEditor(page, deckhand);
    expect(await page.evaluate(() => {
      const e = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(e);
      return e.defaultPrevented;
    })).toBe(false);
    await page.getByRole('button', { name: '← Home' }).click();
    await expect(page.locator('.home')).toBeVisible();
  });
});

test.describe('text-only edits', () => {
  test.use({ deckhandOptions: {} });
  const DECK = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Links</title></head><body>
<section class="slide">
  <h1>Plain heading</h1>
  <p id="link">Click <a href="https://example.com" class="btn">here</a> now</p>
  <p id="comment">Hello <!-- keep this comment --> world</p>
</section>
</body></html>
`;

  test('R-m3 formatting shortcuts add no markup', async ({ page, deckhand }) => {
    const file = await writeDeck(deckhand.home, 'links.html', DECK);
    await openDeckAt(page, deckhand, file);
    const h1 = deckFrame(page).locator('h1');
    await h1.dblclick();
    await page.keyboard.press('ControlOrMeta+a');
    for (const key of ['b', 'i', 'u']) await page.keyboard.press(`ControlOrMeta+${key}`);
    await page.keyboard.type('Bold attempt');
    await blurEditing(page);
    await diskEventually(file, (s) => s.includes('<h1 data-ai-id="dh2">Bold attempt</h1>'));
  });

  test('R-m1 typing over a link\'s text keeps it inside the link', async ({ page, deckhand }) => {
    const file = await writeDeck(deckhand.home, 'links.html', DECK);
    await openDeckAt(page, deckhand, file);
    const link = deckFrame(page).locator('#link a');
    const box = await link.boundingBox();
    await page.mouse.dblclick(box.x + box.width / 2, box.y + box.height / 2);
    await page.keyboard.type('there');
    await blurEditing(page);
    await diskEventually(file, (s) => s.includes('Click <a href="https://example.com" class="btn">there</a> now</p>'));
  });

  test('R-m2 Shift+Enter keeps a neighbouring comment', async ({ page, deckhand }) => {
    const file = await writeDeck(deckhand.home, 'links.html', DECK);
    await openDeckAt(page, deckhand, file);
    const p = deckFrame(page).locator('#comment');
    await p.dblclick();
    await p.evaluate((el) => {
      const d = el.ownerDocument;
      const text = el.lastChild;
      const r = d.createRange();
      r.setStart(text, text.data.indexOf('world'));
      r.setEnd(text, text.data.indexOf('world') + 5);
      d.getSelection().removeAllRanges();
      d.getSelection().addRange(r);
    });
    await page.keyboard.press('Shift+Enter');
    await page.keyboard.type('next');
    await page.keyboard.press('Enter');
    await diskEventually(file, (s) => /<p data-ai-id="dh\d+" id="comment">Hello <!-- keep this comment --> <br>next<\/p>/.test(s));
  });
});
