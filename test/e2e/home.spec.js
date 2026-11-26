import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from './fixtures.js';
import { slugify } from '../../src/shared/slug.js';
import {
  makeDeck, realHome, decksDir, postApi, openAsRecent, openHome, trackRequests,
  input, createBtn, pathField, topName, homeChip,
} from './home-helpers.js';

test.use({
  deckhandOptions: { agents: ['claude'] },
  expectedApiErrors: [{ path: '/api/deck/open', status: 400 }],
});

test('Home lays out the headline, both cards and the agent chip', async ({ page, deckhand }) => {
  await openHome(page, deckhand);
  await expect(page.getByRole('heading', { name: 'Make a deck with your AI.' })).toBeVisible();
  await expect(page.getByText('Describe it and your agent builds it, or open one you already have. It stays a single HTML file the whole time.')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Create a new deck' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Open a deck' })).toBeVisible();
  await expect(homeChip(page)).toHaveText('Claude Code');
  await expect(input(page)).toBeFocused();
});

test('AC-11 Create deck is disabled when empty or blank and Cmd/Ctrl+Enter submits', async ({ page, deckhand }) => {
  await openHome(page, deckhand);
  const runs = trackRequests(page, '/api/runs');
  await expect(createBtn(page)).toBeDisabled();
  await input(page).fill('   \n  ');
  await expect(createBtn(page)).toBeDisabled();
  await page.keyboard.press('ControlOrMeta+Enter');
  await page.waitForTimeout(200);
  expect(runs).toEqual([]);
  await input(page).fill('A short deck about tidy desks');
  await expect(createBtn(page)).toBeEnabled();
  await page.keyboard.press('ControlOrMeta+Enter');
  await expect.poll(() => runs).toEqual([{ kind: 'create', description: 'A short deck about tidy desks' }]);
  await expect(page.locator('.generation')).toBeVisible();
});

test('AC-12 the Saves as line follows the naming rules and steps past an existing name', async ({ page, deckhand }) => {
  await openHome(page, deckhand);
  const line = page.locator('.create-target');
  await expect(line).toHaveText('Saves to ~/Deckhand');
  const description = 'Make me a 6-slide pitch for our new coffee subscription';
  const slug = slugify(description);
  await input(page).fill(description);
  await expect(line).toHaveText(`Saves as ~/Deckhand/${slug}.html`);
  makeDeck(decksDir(deckhand), `${slug}.html`);
  await input(page).fill(`${description} `);
  await expect(line).toHaveText(`Saves as ~/Deckhand/${slug}-2.html`);
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
  const deck = makeDeck(path.join(realHome(deckhand), 'talks'), 'roadmap.html');
  await openHome(page, deckhand);
  await pathField(page).fill(deck);
  await page.keyboard.press('Enter');
  await expect(topName(page)).toHaveText('roadmap.html');
  await expect(topName(page)).toHaveAttribute('title', deck);
  await expect(page).toHaveURL(/\/edit\?deck=/);
});

test('AC-21 opening from recents lands in the editor', async ({ page, deckhand }) => {
  const deck = makeDeck(path.join(realHome(deckhand), 'talks'), 'q3-roadmap.html');
  await openAsRecent(deckhand, deck);
  await openHome(page, deckhand);
  const row = page.locator('.recent-row').first();
  await expect(row.locator('.recent-name')).toHaveText('q3-roadmap.html');
  await expect(row.locator('.recent-dir')).toHaveText('~/talks');
  await expect(row.locator('.recent-time')).toHaveText('Just now');
  await row.click();
  await expect(topName(page)).toHaveAttribute('title', deck);
});

test('AC-21 and AC-25 Browse lists folders then decks, walks the breadcrumb and opens a deck', async ({ page, deckhand }) => {
  const dir = decksDir(deckhand);
  makeDeck(dir, 'b-deck.html');
  makeDeck(dir, 'a-deck.htm');
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'not a deck');
  fs.mkdirSync(path.join(dir, 'drafts'));
  const inner = makeDeck(path.join(dir, 'drafts'), 'inner.html');
  await openHome(page, deckhand);

  await page.getByRole('button', { name: 'Browse…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Choose a deck' });
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
  await expect(topName(page)).toHaveAttribute('title', inner);
});

test('AC-22 every open error shows its own copy inline', async ({ page, deckhand }) => {
  const dir = path.join(realHome(deckhand), 'bad');
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
  const gone = makeDeck(path.join(realHome(deckhand), 'old'), 'gone.html');
  const kept = makeDeck(path.join(realHome(deckhand), 'talks'), 'kept.html');
  await openAsRecent(deckhand, gone, kept);
  fs.rmSync(gone);
  await openHome(page, deckhand);
  const opens = trackRequests(page, '/api/deck/open');
  const missing = page.locator('.recent-row', { hasText: 'gone.html' });
  await expect(missing).toHaveClass(/is-missing/);
  await expect(missing).toContainText('Missing');
  await missing.locator('.recent-open').click({ force: true });
  await expect(page.locator('.home')).toBeVisible();
  expect(opens).toEqual([]);
  await missing.getByRole('button', { name: 'Remove from recents' }).click();
  await expect(page.locator('.recent-row')).toHaveCount(1);
  await page.reload();
  await expect(page.locator('.recent-row')).toHaveText(/kept\.html/);

  const row = page.locator('.recent-row', { hasText: 'kept.html' });
  await row.hover();
  await expect(row.getByRole('button', { name: 'Remove from recents' })).toBeVisible();
});

test('AC-24 file names in recents render as literal text', async ({ page, deckhand }) => {
  const evil = '<img src=x onerror=alert(1)>';
  const deck = makeDeck(path.join(realHome(deckhand), evil), `${evil}.html`);
  await openAsRecent(deckhand, deck);
  await openHome(page, deckhand);
  await expect(page.locator('.recent-name')).toHaveText(`${evil}.html`);
  await expect(page.locator('#app img')).toHaveCount(0);
});

test('empty recents offer the sample deck', async ({ page, deckhand }) => {
  await openHome(page, deckhand);
  await expect(page.locator('.recents-empty')).toContainText('Decks you open or create will show up here.');
  await page.getByRole('button', { name: 'Try the sample deck' }).click();
  await expect(topName(page)).toHaveText('sample-deck.html');
});

test.describe('with no agent', () => {
  test.use({ deckhandOptions: { agents: [] } });

  test('AC-8 Home shows the No agent state, no Create deck, and Open still works', async ({ page, deckhand }) => {
    const deck = makeDeck(path.join(realHome(deckhand), 'talks'), 'still-opens.html');
    await openHome(page, deckhand);
    await expect(homeChip(page)).toContainText('No agent');
    const empty = page.locator('.create-empty');
    await expect(empty).toContainText('Deckhand needs Claude Code or Codex to create and edit decks for you.');
    await expect(empty).toContainText('Install one, then click Check again.');
    await expect(empty.getByRole('link', { name: 'Claude Code' })).toHaveAttribute('target', '_blank');
    await expect(empty.getByRole('link', { name: 'Codex' })).toHaveAttribute('target', '_blank');
    await expect(createBtn(page)).toHaveCount(0);

    deckhand.setAgents(['claude']);
    await empty.getByRole('button', { name: 'Check again' }).click();
    await expect(input(page)).toBeVisible();
    await expect(homeChip(page)).toHaveText('Claude Code');

    await pathField(page).fill(deck);
    await page.keyboard.press('Enter');
    await expect(topName(page)).toHaveAttribute('title', deck);
  });
});

test('back from the editor returns Home with the deck first in recents', async ({ page, deckhand }) => {
  const first = makeDeck(path.join(realHome(deckhand), 'talks'), 'first.html');
  const older = makeDeck(path.join(realHome(deckhand), 'talks'), 'older.html');
  await postApi(deckhand, '/api/deck/open', { path: older });
  await page.goto(deckhand.url);
  await expect(topName(page)).toHaveAttribute('title', older);
  await page.getByRole('button', { name: '← Home' }).click();
  await expect(page.locator('.home')).toBeVisible();
  await pathField(page).fill(first);
  await page.keyboard.press('Enter');
  await expect(topName(page)).toHaveAttribute('title', first);
  await page.goBack();
  await expect(page.locator('.home')).toBeVisible();
  await expect(page.locator('.recent-row .recent-name')).toHaveText(['first.html', 'older.html']);
});
