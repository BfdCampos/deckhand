import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from './fixtures.js';
import { BASIC, THREE, addNotes, handoff, card } from './runs-helpers.js';
import { editUrl } from './editor-helpers.js';
import { decksDir, input, openHome, topName } from './home-helpers.js';

const visibleErrorLines = (scope, text) => scope.locator('.activity-line.kind-error:visible', { hasText: text });

test.describe('an edit run that fails', () => {
  test.use({ deckhandOptions: { deck: BASIC, agents: ['claude'], scenario: 'edit-then-fail' } });

  test('shows its error once, in the error box', async ({ page, deckhand }) => {
    await addNotes(deckhand, THREE);
    await page.goto(await editUrl(deckhand));
    await handoff(page).click();
    await expect(card(page).locator('.activity-error')).toContainText('Something went wrong after editing.');
    await expect(visibleErrorLines(card(page), 'Something went wrong after editing.')).toHaveCount(0);
  });
});

test.describe('create runs', () => {
  test.use({ deckhandOptions: { agents: ['claude'] } });

  test('a failed create shows its error once, in the error box', async ({ page, deckhand }) => {
    await openHome(page, deckhand);
    await input(page).fill('A deck that will not work [[fake:fail-mid-run]]');
    await page.locator('.create-submit').click();
    const gen = page.locator('.generation');
    await expect(gen.locator('.gen-error')).toContainText('The agent hit an error halfway through.', { timeout: 10_000 });
    await expect(visibleErrorLines(gen, 'The agent hit an error halfway through.')).toHaveCount(0);
  });

  test('the editor activity card hides an empty log after a create', async ({ page, deckhand }) => {
    await openHome(page, deckhand);
    await input(page).fill('A short deck about tidy desks');
    await page.locator('.create-submit').click();
    await expect(topName(page)).toBeVisible({ timeout: 10_000 });
    const log = card(page).locator('.activity-lines');
    await expect(card(page).locator('.activity-summary')).toHaveText('Deck created.');
    const count = await log.locator('.activity-line').count();
    if (count === 0) await expect(log).toBeHidden();
    else await expect(log).toBeVisible();
  });

  test('Saves as middle-truncates a long name and keeps the full path in its tooltip', async ({ page, deckhand }) => {
    await openHome(page, deckhand);
    await input(page).fill('Quarterly finance planning review budgets hiring roadmap');
    const line = page.locator('.create-target');
    await expect(line).toHaveAttribute('title', /^~\/Deckhand\/.{30,}\.html$/);
    const full = await line.getAttribute('title');
    const shown = await line.locator('.create-target-path').textContent();
    expect(shown).toContain('…');
    expect(shown.length).toBeLessThan(full.length);
    expect(shown.endsWith('.html')).toBe(true);
    expect(shown.startsWith('~/Deckhand/')).toBe(true);
  });

  test('Browse shows "No folders or decks here." inside the list box', async ({ page, deckhand }) => {
    fs.mkdirSync(decksDir(deckhand), { recursive: true });
    await openHome(page, deckhand);
    await page.getByRole('button', { name: 'Browse…' }).click();
    const list = page.getByRole('dialog', { name: 'Choose a deck' }).locator('.browse-list');
    await expect(list).toContainText('No folders or decks here.');
    await expect(list.locator('.browse-row')).toHaveCount(0);
  });
});
