import fs from 'node:fs/promises';
import { test, expect } from './fixtures.js';
import { BASIC, THREE, addNotes, openEditor, handoff, card, sidecar } from './runs-helpers.js';
import { deckFrame, blurEditing, caretToEnd, diskEventually } from './editor-helpers.js';

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
    await handoff(page).click();
    const pill = page.locator('.editor-pill');
    await expect(pill).toBeVisible();
    await fs.appendFile(deckhand.deckPath, '\n<!-- external -->\n');
    const toast = page.locator('.toast', { hasText: 'Updated from disk' });
    await expect(toast).toBeVisible();
    const a = await pill.boundingBox();
    const b = await toast.boundingBox();
    const overlap = !(b.y >= a.y + a.height || b.y + b.height <= a.y || b.x >= a.x + a.width || b.x + b.width <= a.x);
    expect(overlap).toBe(false);
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
