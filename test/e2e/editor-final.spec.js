import fs from 'node:fs/promises';
import { test, expect } from './fixtures.js';
import { BASIC, THREE, addNotes, openEditor, handoff, card, sidecar } from './runs-helpers.js';
import { deckFrame, blurEditing, caretToEnd, diskEventually, frameGen } from './editor-helpers.js';

async function recordToasts(page) {
  await page.evaluate(() => {
    window.__toasts = [];
    new MutationObserver((records) => {
      for (const r of records) for (const n of r.addedNodes) if (n.nodeType === 1 && n.matches('.toast')) window.__toasts.push(n.textContent);
    }).observe(document.body, { childList: true, subtree: true });
  });
  return () => page.evaluate(() => window.__toasts);
}

async function editHeading(page, deckhand) {
  const h1 = deckFrame(page).locator('h1');
  await h1.dblclick();
  await caretToEnd(h1);
  await page.keyboard.type('!');
  await blurEditing(page);
  await diskEventually(deckhand.deckPath, (s) => s.includes('Basic deck!</h1>'));
}

test.describe('a run that edits the deck', () => {
  test.use({ deckhandOptions: { deck: BASIC, agents: ['claude'], scenario: 'long-run' } });

  test('never shows "Undo history cleared" when the run reloads the deck', async ({ page, deckhand }) => {
    await addNotes(deckhand, THREE);
    await openEditor(page, deckhand);
    await editHeading(page, deckhand);
    const toasts = await recordToasts(page);
    await handoff(page).click();
    await expect(page.locator('.editor-pill')).toBeVisible();
    await expect(deckFrame(page).locator('h1')).toHaveText(/^Edited: /);
    await expect(card(page).locator('.activity-state')).toHaveText('Done', { timeout: 15_000 });
    await page.waitForTimeout(400);
    expect((await toasts()).filter((t) => t.includes('Undo history cleared'))).toEqual([]);
  });
});

test.describe('while locked', () => {
  test.use({ deckhandOptions: { deck: BASIC, agents: ['claude'], scenario: 'runs-ui-edit-hang' } });

  test('a toast sits below the lock pill, never on top of it', async ({ page, deckhand }) => {
    await addNotes(deckhand, THREE);
    await openEditor(page, deckhand);
    const before = await frameGen(page);
    await handoff(page).click();
    const pill = page.locator('.editor-pill');
    await expect(pill).toBeVisible();
    await expect(deckFrame(page).locator('h1')).toHaveText(/^Edited: /);
    await expect.poll(() => frameGen(page)).toBeGreaterThan(before);
    const settled = await frameGen(page);
    await fs.appendFile(deckhand.deckPath, '\n<!-- external -->\n');
    await expect.poll(() => frameGen(page), { timeout: 10_000 }).toBeGreaterThan(settled);
    const toast = page.locator('.toast.is-in', { hasText: 'Updated from disk' });
    await expect(toast).toBeVisible();
    const boxes = await page.evaluate(() => {
      const t = [...document.querySelectorAll('.toast')].find((n) => n.textContent.includes('Updated from disk'));
      const p = document.querySelector('.editor-pill');
      const box = (n) => { const r = n.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right }; };
      return t && p ? { toast: box(t), pill: box(p) } : null;
    });
    expect(boxes).not.toBeNull();
    const { toast: b, pill: a } = boxes;
    expect(b.top >= a.bottom || b.bottom <= a.top || b.left >= a.right || b.right <= a.left).toBe(true);
    expect(b.top).toBeGreaterThanOrEqual(a.bottom);
  });

});

test.describe('done notes', () => {
  test.use({ deckhandOptions: { deck: BASIC, agents: ['claude'] } });

  test('have no Edit button and can be cleared together', async ({ page, deckhand }) => {
    await addNotes(deckhand, THREE);
    await openEditor(page, deckhand);
    await handoff(page).click();
    await expect(card(page).locator('.activity-state')).toHaveText('Done');
    await expect(page.locator('.note-item.is-done')).toHaveCount(3);
    await expect(page.locator('.note-item.is-done').getByRole('button', { name: 'Edit' })).toHaveCount(0);

    const clear = page.getByRole('button', { name: 'Clear done (3)' });
    await expect(clear).toBeVisible();
    await clear.click();
    await expect(page.locator('.note-item')).toHaveCount(0);
    await expect(clear).toHaveCount(0);
    await expect.poll(async () => JSON.parse(await fs.readFile(sidecar(deckhand, 'json'), 'utf8')).notes.length).toBe(0);
  });
});
