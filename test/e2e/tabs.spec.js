import { test, expect, SERVER_RESTART_NOISE } from './fixtures.js';
import { deckFrame, readDisk, openEditor, blurEditing, diskEventually } from './editor-helpers.js';

test.use({ deckhandOptions: { deck: 'test/fixtures/decks/basic.html' } });

async function secondTab(page, deckhand) {
  const other = await page.context().newPage();
  await openEditor(other, deckhand);
  return other;
}

test('NN-8 two tabs on one deck see each other\'s edits and notes', async ({ page, deckhand }) => {
  await openEditor(page, deckhand);
  const other = await secondTab(page, deckhand);

  const h1 = deckFrame(page).locator('h1');
  await h1.dblclick();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type('Edited in tab one');
  await blurEditing(page);
  await expect(deckFrame(other).locator('h1')).toHaveText('Edited in tab one');

  await deckFrame(other).locator('h2', { hasText: 'Things to say' }).scrollIntoViewIfNeeded();
  await deckFrame(other).locator('h2', { hasText: 'Things to say' }).click({ button: 'right' });
  await other.locator('.note-pop textarea').fill('Note from tab two');
  await other.locator('.note-pop textarea').press('ControlOrMeta+Enter');
  await expect(page.locator('.note-item')).toContainText('Note from tab two');

  await page.locator('.note-item').getByRole('button', { name: 'Delete' }).click();
  await expect(other.locator('.note-item')).toHaveCount(0);
  await expect(other.locator('.notes-empty')).toBeVisible();
  await other.close();
});

test('undo history is per tab', async ({ page, deckhand }) => {
  await openEditor(page, deckhand);
  const other = await secondTab(page, deckhand);
  await deckFrame(page).locator('h1').dblclick();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type('Only tab one can undo this');
  await blurEditing(page);
  await diskEventually(deckhand.deckPath, (s) => s.includes('Only tab one can undo this'));
  await expect(deckFrame(other).locator('h1')).toHaveText('Only tab one can undo this');

  await other.locator('.sidebar .sb-head').click();
  await other.keyboard.press('ControlOrMeta+z');
  await other.waitForTimeout(500);
  expect(await readDisk(deckhand.deckPath)).toContain('Only tab one can undo this');

  await page.keyboard.press('ControlOrMeta+z');
  await diskEventually(deckhand.deckPath, (s) => s.includes('>Basic deck</h1>'));
  await expect(deckFrame(other).locator('h1')).toHaveText('Basic deck');
  await other.close();
});

test.describe('connection', () => {
  test.use({ allowedConsoleErrors: [SERVER_RESTART_NOISE] });

  test('a stopped server shows a calm banner, pauses edits and recovers on restart', async ({ page, deckhand }) => {
    await openEditor(page, deckhand);
    await deckhand.stop();
    const banner = page.locator('.banner', { hasText: 'Lost connection to Deckhand. Trying again…' });
    await expect(banner).toBeVisible();
    await expect(page.getByRole('button', { name: 'Text', exact: true })).toBeDisabled();
    await deckFrame(page).locator('h1').dblclick();
    await expect(deckFrame(page).locator('h1')).not.toHaveAttribute('contenteditable', 'true');

    await deckhand.restart();
    await expect(banner).toBeHidden({ timeout: 10_000 });
    await expect(page.locator('.topbar-name')).toHaveText('basic.html');
    await expect(page.getByRole('button', { name: 'Text', exact: true })).toBeEnabled();
    const h1 = deckFrame(page).locator('h1');
    await h1.dblclick();
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.type('Back online');
    await blurEditing(page);
    await diskEventually(deckhand.deckPath, (s) => s.includes('>Back online</h1>'));
  });
});

test('a deck closed in another tab offers Reopen and Home', async ({ page, deckhand }) => {
  await openEditor(page, deckhand);
  const state = await (await page.request.get(`${deckhand.url}/api/state`)).json();
  const res = await page.request.post(`${deckhand.url}/api/deck/close`, { headers: { Origin: deckhand.url }, data: { deckId: state.deck.deckId } });
  expect(res.status()).toBe(200);

  const banner = page.locator('.banner', { hasText: 'This deck was closed in another tab.' });
  await expect(banner).toBeVisible();
  await expect(page.getByRole('button', { name: 'Text', exact: true })).toBeDisabled();
  await banner.getByRole('button', { name: 'Reopen' }).click();
  await expect(banner).toBeHidden();
  await expect(page.getByRole('button', { name: 'Text', exact: true })).toBeEnabled();

  await page.request.post(`${deckhand.url}/api/deck/close`, { headers: { Origin: deckhand.url }, data: { deckId: (await (await page.request.get(`${deckhand.url}/api/state`)).json()).deck.deckId } });
  await expect(banner).toBeVisible();
  await banner.getByRole('button', { name: 'Home' }).click();
  await expect(page.locator('.home')).toBeVisible();
});
