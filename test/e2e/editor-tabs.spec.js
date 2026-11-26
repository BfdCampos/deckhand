import { test, expect } from './fixtures.js';
import { deckFrame, readDisk, openEditor, openDeckAt, writeDeck, sidecar } from './editor-helpers.js';

test.use({ deckhandOptions: { deck: 'test/fixtures/decks/basic.html' } });

const deckHtml = (title) => `<!DOCTYPE html><html><head><title>${title}</title></head><body><section class="slide"><h1>${title}</h1><ul><li>Point</li></ul></section><section class="slide"><h2>Two</h2></section></body></html>`;

function trackWrites(page) {
  const writes = [];
  page.on('request', (req) => {
    const p = new URL(req.url()).pathname;
    if (req.method() === 'POST' && (p.startsWith('/api/deck/ops') || p === '/api/notes')) writes.push(p);
  });
  return writes;
}

async function openInSecondTab(page, deckhand, file) {
  const second = await page.context().newPage();
  await openDeckAt(second, deckhand, file);
  return second;
}

test('R1 an open whose answer arrives after another tab opened a deck pauses instead of editing', async ({ page, deckhand }) => {
  const first = await writeDeck(deckhand.home, 'first.html', deckHtml('First'));
  const second = await writeDeck(deckhand.home, 'second.html', deckHtml('Second'));
  await openEditor(page, deckhand);
  await page.getByRole('button', { name: '← Home' }).click();

  let release;
  const held = new Promise((r) => { release = r; });
  await page.route('**/api/deck/open', async (route) => {
    const response = await route.fetch();
    await held;
    await route.fulfill({ response });
  });
  await page.locator('.open-path').fill(first);
  await page.locator('.open-path').press('Enter');
  await expect.poll(async () => (await (await page.request.get(`${deckhand.url}/api/state`)).json()).deck?.name).toBe('first.html');
  const firstDeck = (await (await page.request.get(`${deckhand.url}/api/state`)).json()).deck;

  const tab = await openInSecondTab(page, deckhand, second);
  release();

  const notice = page.locator('.editor-elsewhere');
  await expect(notice).toContainText('Another tab opened second.html.');
  const writes = trackWrites(page);
  await page.keyboard.type('typed while paused');
  await page.waitForTimeout(300);
  expect(writes).toEqual([]);
  expect(await readDisk(second)).toBe(deckHtml('Second'));

  const stale = await page.request.post(`${deckhand.url}/api/deck/ops`, {
    headers: { Origin: deckhand.url },
    data: { deckId: firstDeck.deckId, tabId: 'stale', baseRev: firstDeck.rev, ops: [{ type: 'insert', parentAiId: null, html: '<p>stale</p>' }] },
  });
  expect(stale.status()).toBe(409);
  expect((await stale.json()).error.code).toBe('deck_closed');
  expect(await readDisk(second)).toBe(deckHtml('Second'));
  await tab.close();
});

test('R4 keys pressed while the other-tab notice appears never switch decks', async ({ page, deckhand }) => {
  await openEditor(page, deckhand);
  const other = await writeDeck(deckhand.home, 'other.html', deckHtml('Other'));
  await deckFrame(page).locator('h1').dblclick();
  const tab = await openInSecondTab(page, deckhand, other);
  await expect(page.locator('.editor-elsewhere')).toBeVisible();
  await page.keyboard.press(' ');
  await page.keyboard.press('Enter');
  await page.keyboard.type(' more words');
  await page.waitForTimeout(300);
  await expect(page.locator('.editor-elsewhere')).toBeVisible();
  await expect(page.locator('.topbar-name')).toHaveText('basic.html');
  expect(await page.evaluate(() => document.activeElement?.closest('.editor-elsewhere')?.className)).toBe('editor-elsewhere');
  expect(await page.evaluate(() => document.activeElement?.tagName)).not.toBe('BUTTON');
  await tab.close();
});

test('R5 going Back to a deck from this tab asks with history copy, not link copy', async ({ page, deckhand }) => {
  await openEditor(page, deckhand);
  const other = await writeDeck(deckhand.home, 'other.html', deckHtml('Other'));
  await page.getByRole('button', { name: '← Home' }).click();
  await page.locator('.open-path').fill(other);
  await page.locator('.open-path').press('Enter');
  await expect(page.locator('.topbar-name')).toHaveText('other.html');
  await page.goBack();
  await page.goBack();
  const dialog = page.getByRole('dialog', { name: 'Open this deck?' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('You had basic.html open earlier in this tab.');
  await expect(dialog).not.toContainText('A link asked Deckhand');
  await dialog.getByRole('button', { name: 'Open' }).click();
  await expect(page.locator('.topbar-name')).toHaveText('basic.html');
});

test('R6 a drag that is still held when the notice appears saves nothing and snaps back', async ({ page, deckhand }) => {
  await openEditor(page, deckhand);
  const other = await writeDeck(deckhand.home, 'other.html', deckHtml('Other'));
  const li = deckFrame(page).locator('li', { hasText: 'First thing' });
  await li.scrollIntoViewIfNeeded();
  const box = await li.boundingBox();
  await page.mouse.move(box.x + 20, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + 60, box.y + box.height / 2, { steps: 4 });
  const tab = await openInSecondTab(page, deckhand, other);
  await expect(page.locator('.editor-elsewhere')).toBeVisible();
  const writes = trackWrites(page);
  await page.mouse.move(box.x + 120, box.y + box.height / 2, { steps: 4 });
  await page.mouse.up();
  await page.waitForTimeout(400);
  expect(writes).toEqual([]);
  expect(await li.getAttribute('style')).toBeNull();
  expect(await readDisk(other)).toBe(deckHtml('Other'));
  await tab.close();
});

test('a note popover left open closes when another tab opens a deck, so it cannot save there', async ({ page, deckhand }) => {
  await openEditor(page, deckhand);
  const other = await writeDeck(deckhand.home, 'other.html', deckHtml('Other'));
  await deckFrame(page).locator('h1').click({ button: 'right' });
  await page.locator('.note-pop textarea').fill('Meant for basic.html');
  const tab = await openInSecondTab(page, deckhand, other);
  await expect(page.locator('.editor-elsewhere')).toBeVisible();
  await expect(page.locator('.note-pop')).toHaveCount(0);
  await page.waitForTimeout(300);
  const notes = await (await page.request.get(`${deckhand.url}/api/notes`)).json();
  expect(notes.notes).toEqual([]);
  await expect.poll(() => readDisk(sidecar(other, 'json')).catch(() => '')).not.toContain('Meant for basic.html');
  await tab.close();
});
