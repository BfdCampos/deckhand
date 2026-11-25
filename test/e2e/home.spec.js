import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from './fixtures.js';
import { mockHome } from './home-mock.js';

// Recents, Browse, open validation and the create target are mocked (see
// home-mock.js) until WP4.2 and WP3.1 land; opening a valid deck is the real
// server.

const NOISE = [/\/deckroot\/[^?]*\.deckhand\.json(\?|$)|Failed to load resource: the server responded with a status of 400/];
test.use({ allowedConsoleErrors: NOISE });

const DECK = '<!DOCTYPE html><html><head><title>t</title></head><body><section class="slide"><h1>Hello</h1></section></body></html>';

function makeDeck(dir, name, body = DECK) {
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, name);
  fs.writeFileSync(p, body);
  return p;
}

async function openHome(page, deckhand, opts) {
  const mock = await mockHome(page, deckhand, opts);
  await page.goto(deckhand.url);
  await expect(page.locator('.home')).toBeVisible();
  await mock.ready();
  await page.waitForLoadState('networkidle');
  return mock;
}

const input = (page) => page.getByRole('textbox', { name: 'Describe the deck you want' });
const createBtn = (page) => page.locator('.create-submit');
const pathField = (page) => page.getByRole('textbox', { name: 'Deck path' });

test('Home lays out the headline, both cards and the agent chip', async ({ page, deckhand }) => {
  await openHome(page, deckhand);
  await expect(page.getByRole('heading', { name: 'Make a deck with your AI.' })).toBeVisible();
  await expect(page.getByText('Describe it and your agent builds it, or open one you already have. It stays a single HTML file the whole time.')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Create a new deck' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Open a deck' })).toBeVisible();
  await expect(page.locator('.home .home-top .agent-chip')).toHaveText('Claude Code');
  await expect(input(page)).toBeFocused();
});

test('AC-11 Create deck is disabled when empty or blank and Cmd/Ctrl+Enter submits', async ({ page, deckhand }) => {
  const mock = await openHome(page, deckhand);
  await expect(createBtn(page)).toBeDisabled();
  await input(page).fill('   \n  ');
  await expect(createBtn(page)).toBeDisabled();
  await page.keyboard.press('ControlOrMeta+Enter');
  expect(mock.callsTo('POST', '/api/runs')).toHaveLength(0);
  await input(page).fill('A 6-slide pitch for our new coffee subscription');
  await expect(createBtn(page)).toBeEnabled();
  await page.keyboard.press('ControlOrMeta+Enter');
  await expect.poll(() => mock.callsTo('POST', '/api/runs').map((c) => c.body))
    .toEqual([{ kind: 'create', description: 'A 6-slide pitch for our new coffee subscription' }]);
});

test('AC-12 the Saves as line follows the description and steps past an existing name', async ({ page, deckhand }) => {
  const mock = await openHome(page, deckhand);
  const line = page.locator('.create-target');
  await expect(line).toHaveText('Saves to ~/Deckhand');
  await input(page).fill('Coffee subscription pitch');
  await expect(line).toHaveText('Saves as ~/Deckhand/coffee-subscription-pitch.html');
  makeDeck(mock.decksDir, 'coffee-subscription-pitch.html');
  await input(page).fill('Coffee subscription pitch ');
  await expect(line).toHaveText('Saves as ~/Deckhand/coffee-subscription-pitch-2.html');
  await input(page).fill('');
  await expect(line).toHaveText('Saves to ~/Deckhand');
});

test('AC-20 the draft survives a refresh', async ({ page, deckhand }) => {
  await openHome(page, deckhand);
  await input(page).fill('A warm talk about sourdough');
  await page.reload();
  await expect(input(page)).toHaveValue('A warm talk about sourdough');
  await expect(createBtn(page)).toBeEnabled();
});

test('AC-21 opening from the path field lands in the editor', async ({ page, deckhand }) => {
  const deck = makeDeck(path.join(deckhand.home, 'talks'), 'roadmap.html');
  await openHome(page, deckhand);
  await pathField(page).fill(deck);
  await page.keyboard.press('Enter');
  await expect(page.locator('.sb-file')).toContainText(deck);
  await expect(page).toHaveURL(/\/edit\?deck=/);
});

test('AC-21 opening from recents lands in the editor', async ({ page, deckhand }) => {
  const deck = makeDeck(path.join(deckhand.home, 'talks'), 'q3-roadmap.html');
  await openHome(page, deckhand, { recents: [{ path: deck }] });
  const row = page.locator('.recent-row').first();
  await expect(row.locator('.recent-name')).toHaveText('q3-roadmap.html');
  await expect(row.locator('.recent-dir')).toHaveText('~/talks');
  await expect(row.locator('.recent-time')).toHaveText('Just now');
  await row.click();
  await expect(page.locator('.sb-file')).toContainText(deck);
});

test('AC-21 and AC-25 Browse lists folders then decks, walks the breadcrumb and opens a deck', async ({ page, deckhand }) => {
  const mock = await openHome(page, deckhand);
  makeDeck(mock.decksDir, 'b-deck.html');
  makeDeck(mock.decksDir, 'a-deck.htm');
  fs.writeFileSync(path.join(mock.decksDir, 'notes.txt'), 'not a deck');
  fs.mkdirSync(path.join(mock.decksDir, 'drafts'));
  const inner = makeDeck(path.join(mock.decksDir, 'drafts'), 'inner.html');

  await page.getByRole('button', { name: 'Browse…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Choose a deck' });
  await expect(dialog).toBeVisible();
  const rows = dialog.locator('.browse-row');
  await expect(rows).toHaveText(['drafts', 'a-deck.htm', 'b-deck.html']);
  await expect(dialog.locator('.browse-crumbs')).toContainText('Deckhand');

  await rows.filter({ hasText: 'drafts' }).click();
  await expect(rows).toHaveText(['inner.html']);
  await dialog.locator('.browse-crumbs').getByRole('button', { name: 'Deckhand' }).click();
  await expect(rows).toHaveText(['drafts', 'a-deck.htm', 'b-deck.html']);

  await rows.first().focus();
  await page.keyboard.press('Enter');
  await expect(rows).toHaveText(['inner.html']);
  await page.keyboard.press('Backspace');
  await expect(rows).toHaveText(['drafts', 'a-deck.htm', 'b-deck.html']);
  await expect(rows.first()).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(rows.nth(1)).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();

  await page.getByRole('button', { name: 'Browse…' }).click();
  await dialog.locator('.browse-row', { hasText: 'drafts' }).click();
  await dialog.locator('.browse-row', { hasText: 'inner.html' }).click();
  await expect(page.locator('.sb-file')).toContainText(inner);
});

test('AC-22 every open error shows its own copy inline', async ({ page, deckhand }) => {
  const dir = path.join(deckhand.home, 'bad');
  const txt = makeDeck(dir, 'notes.txt', 'hello');
  const empty = makeDeck(dir, 'empty.html', '   ');
  const locked = makeDeck(dir, 'locked.html');
  fs.chmodSync(locked, 0o000);
  await openHome(page, deckhand);
  const error = page.locator('.open-error');
  const cases = [
    [path.join(dir, 'nope.html'), "Can't find that file."],
    [txt, "That's not an HTML file. Deckhand opens .html decks."],
    [dir, "That's a folder. Pick an .html file inside it."],
    [empty, 'That file is empty.'],
    [locked, "Deckhand can't read that file (permission denied)."],
  ];
  for (const [p, copy] of cases) {
    await pathField(page).fill(p);
    await page.getByRole('button', { name: 'Open', exact: true }).click();
    await expect(error).toHaveText(copy);
    await expect(pathField(page)).toHaveAttribute('aria-invalid', 'true');
  }
  await pathField(page).fill('x');
  await expect(error).toBeHidden();
  fs.chmodSync(locked, 0o644);
});

test('AC-23 a missing recent is greyed, does nothing on click and can be removed', async ({ page, deckhand }) => {
  const gone = path.join(deckhand.home, 'old', 'gone.html');
  const deck = makeDeck(path.join(deckhand.home, 'talks'), 'kept.html');
  const mock = await openHome(page, deckhand, { recents: [{ path: gone }, { path: deck }] });
  const missing = page.locator('.recent-row', { hasText: 'gone.html' });
  await expect(missing).toHaveClass(/is-missing/);
  await expect(missing).toContainText('Missing');
  await missing.locator('.recent-open').click({ force: true });
  await expect(page.locator('.home')).toBeVisible();
  expect(mock.callsTo('POST', '/api/open')).toHaveLength(0);
  await missing.getByRole('button', { name: 'Remove from recents' }).click();
  await expect(page.locator('.recent-row')).toHaveCount(1);
  expect(mock.homeState.removed).toEqual([gone]);

  const kept = page.locator('.recent-row', { hasText: 'kept.html' });
  await kept.hover();
  await expect(kept.getByRole('button', { name: 'Remove from recents' })).toBeVisible();
});

test('AC-24 file names in recents render as literal text', async ({ page, deckhand }) => {
  const evil = '<img src=x onerror=alert(1)>';
  const deck = makeDeck(path.join(deckhand.home, evil), `${evil}.html`);
  await openHome(page, deckhand, { recents: [{ path: deck }] });
  await expect(page.locator('.recent-name')).toHaveText(`${evil}.html`);
  await expect(page.locator('#app img')).toHaveCount(0);
});

test('empty recents offer the sample deck', async ({ page, deckhand }) => {
  const mock = await openHome(page, deckhand);
  await expect(page.locator('.recents-empty')).toContainText('Decks you open or create will show up here.');
  await page.getByRole('button', { name: 'Try the sample deck' }).click();
  await expect(page.locator('.sb-file')).toContainText(mock.sampleDeck);
});

test.describe('with no agent', () => {
  test.use({ deckhandOptions: { agents: [] } });

  test('AC-8 Home shows the No agent state, no Create deck, and Open still works', async ({ page, deckhand }) => {
    const deck = makeDeck(path.join(deckhand.home, 'talks'), 'still-opens.html');
    const mock = await openHome(page, deckhand, { agents: [] });
    await expect(page.locator('.home .home-top .agent-chip')).toContainText('No agent');
    const empty = page.locator('.create-empty');
    await expect(empty).toContainText('Deckhand needs Claude Code or Codex to create and edit decks for you.');
    await expect(empty).toContainText('Install one, then click Check again.');
    await expect(empty.getByRole('link', { name: 'Claude Code' })).toHaveAttribute('target', '_blank');
    await expect(empty.getByRole('link', { name: 'Codex' })).toHaveAttribute('target', '_blank');
    await expect(createBtn(page)).toHaveCount(0);

    mock.setFound(['claude']);
    await empty.getByRole('button', { name: 'Check again' }).click();
    await expect(input(page)).toBeVisible();
    await expect(page.locator('.home .home-top .agent-chip')).toHaveText('Claude Code');

    await pathField(page).fill(deck);
    await page.keyboard.press('Enter');
    await expect(page.locator('.sb-file')).toContainText(deck);
  });
});

test('back from the editor returns Home with the deck first in recents', async ({ page, deckhand }) => {
  const deck = makeDeck(path.join(deckhand.home, 'talks'), 'first.html');
  await openHome(page, deckhand);
  await pathField(page).fill(deck);
  await page.keyboard.press('Enter');
  await expect(page.locator('.sb-file')).toContainText(deck);
  await page.goBack();
  await expect(page.locator('.home')).toBeVisible();
  await expect(page.locator('.recent-row').first().locator('.recent-name')).toHaveText('first.html');
});
