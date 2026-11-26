import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from './fixtures.js';
import { card } from './runs-helpers.js';
import { makeDeck, realHome, openAsRecent, openHome, input, topName, postApi, getApi } from './home-helpers.js';

test.use({ deckhandOptions: { agents: ['claude'] } });

test('the generation screen says what is happening while the agent writes', async ({ page, deckhand }) => {
  await page.clock.install();
  await openHome(page, deckhand);
  await input(page).fill('A deck about patience [[fake:runs-ui-write-hang]]');
  await page.locator('.create-submit').click();
  const gen = page.locator('.generation');
  const wait = gen.locator('.gen-wait');
  await expect(wait).toHaveText('Your agent is reading the brief and planning the slides.');
  await expect(gen.locator('.activity-line.is-live')).toHaveText(/^Writing .+\.html…$/);
  await page.clock.runFor(11_000);
  await expect(wait).toHaveText('Writing your deck. Bigger decks take a minute or two.');
  await page.clock.runFor(60_000);
  await expect(wait).toHaveText('Still writing. Detailed decks can take a few minutes.');
  const { run } = await getApi(deckhand, '/api/state');
  await postApi(deckhand, `/api/runs/${run.id}/stop`);
});

test('Try the sample deck stays available once there are recents', async ({ page, deckhand }) => {
  const deck = makeDeck(path.join(realHome(deckhand), 'talks'), 'mine.html');
  await openAsRecent(deckhand, deck);
  await openHome(page, deckhand);
  await expect(page.locator('.recent-row')).toHaveCount(1);
  await page.getByRole('button', { name: 'Try the sample deck' }).click();
  await expect(topName(page)).toHaveText(/^sample-deck-\d{4}-\d{2}-\d{2}-\d{4}(-\d+)?\.html$/);
});

test('the create card goes quiet after the first note, and after leaving and coming back', async ({ page, deckhand }) => {
  await openHome(page, deckhand);
  await input(page).fill('A short deck about tidy desks');
  await page.locator('.create-submit').click();
  await expect(topName(page)).toBeVisible({ timeout: 10_000 });
  await expect(card(page).getByRole('button', { name: 'Delete this deck' })).toBeVisible();

  await page.frameLocator('iframe#deck').locator('h1').click({ button: 'right' });
  const pop = page.locator('.note-pop');
  await pop.locator('textarea').fill('Bigger title');
  await pop.locator('textarea').press('ControlOrMeta+Enter');
  await expect(page.locator('.note-item')).toHaveCount(1);
  await expect(card(page).getByRole('button', { name: 'Delete this deck' })).toHaveCount(0);
  await expect(card(page).locator('.activity-summary')).toHaveText('Deck created.');

  await page.reload();
  await expect(topName(page)).toBeVisible();
  await expect(card(page).getByRole('button', { name: 'Delete this deck' })).toHaveCount(0);
});

test('leaving the new deck and coming back also quietens the create card', async ({ page, deckhand }) => {
  await openHome(page, deckhand);
  await input(page).fill('Another short deck about tidy desks');
  await page.locator('.create-submit').click();
  await expect(topName(page)).toBeVisible({ timeout: 10_000 });
  await expect(card(page).getByRole('button', { name: 'Delete this deck' })).toBeVisible();
  await page.getByRole('button', { name: '← Home' }).click();
  await page.getByRole('button', { name: /^Continue editing/ }).click();
  await expect(topName(page)).toBeVisible();
  await expect(card(page).getByRole('button', { name: 'Delete this deck' })).toHaveCount(0);
});
