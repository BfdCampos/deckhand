import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from './fixtures.js';
import { mockHome } from './home-mock.js';
import { runningRun } from './runs-mock.js';

// Create runs, their events and the create target are mocked (see
// runs-mock.js and home-mock.js) until WP3.1 lands. The created deck is a real
// file opened by the real server.

test.use({
  allowedConsoleErrors: [/\/deckroot\/[^?]*\.deckhand\.json(\?|$)|Failed to load resource: the server responded with a status of 4\d\d/],
  permissions: ['clipboard-read', 'clipboard-write'],
});

const DESCRIPTION = 'A 6-slide pitch for our new coffee subscription, warm and minimal, for the leadership team.';
const DECK = '<!DOCTYPE html><html><head><title>Coffee</title></head><body><section class="slide"><h1>Coffee club</h1></section><section class="slide"><h2>Why now</h2></section></body></html>';

async function openHome(page, deckhand, opts) {
  const mock = await mockHome(page, deckhand, opts);
  await page.goto(deckhand.url);
  await expect(page.locator('.home')).toBeVisible();
  await mock.ready();
  await page.waitForLoadState('networkidle');
  return mock;
}

async function startCreate(page, deckhand, opts) {
  const mock = await openHome(page, deckhand, opts);
  await page.getByRole('textbox', { name: 'Describe the deck you want' }).fill(DESCRIPTION);
  await page.locator('.create-submit').click();
  await expect(page.locator('.generation')).toBeVisible();
  return mock;
}

const gen = (page) => page.locator('.generation');

test('AC-13 Create deck sends the description as a create run', async ({ page, deckhand }) => {
  const mock = await startCreate(page, deckhand);
  expect(mock.callsTo('POST', '/api/runs').map((c) => c.body)).toEqual([{ kind: 'create', description: DESCRIPTION }]);
  expect(mock.run.targetPath).toBe(path.join(mock.decksDir, '6-slide-pitch-for-our-new.html'));
});

test('AC-14 the generation screen shows the description, agent, a ticking timer, activity and Stop', async ({ page, deckhand }) => {
  const mock = await startCreate(page, deckhand);
  await expect(page).toHaveURL(/\/create\?run=run_1$/);
  await expect(gen(page).getByRole('heading', { name: 'Building your deck' })).toBeVisible();
  await expect(gen(page).locator('.gen-quote')).toHaveText(DESCRIPTION);
  await expect(gen(page).locator('.gen-agent')).toContainText('Claude Code');
  await expect(gen(page).locator('.gen-target')).toHaveText('~/Deckhand/6-slide-pitch-for-our-new.html');
  const timer = gen(page).locator('.gen-timer');
  await expect(timer).toHaveText(/^0:0\d$/);
  const first = await timer.textContent();
  await expect.poll(async () => timer.textContent(), { timeout: 3000 }).not.toBe(first);
  mock.line({ kind: 'status', text: 'Thinking…' });
  mock.line({ kind: 'write', text: 'Writing 6-slide-pitch-for-our-new.html' });
  await expect(gen(page).locator('.activity-line')).toHaveText(['Thinking…', 'Writing 6-slide-pitch-for-our-new.html']);
  await expect(gen(page).getByRole('button', { name: 'Stop' })).toBeVisible();
  await expect(gen(page)).toContainText("You can close this tab. The run keeps going and the deck will be in Recent when it's done.");
});

test('AC-15 success opens the editor on the new deck, first in recents, with the toast', async ({ page, deckhand }) => {
  const mock = await startCreate(page, deckhand);
  fs.mkdirSync(mock.decksDir, { recursive: true });
  fs.writeFileSync(mock.run.targetPath, DECK);
  mock.finish('succeeded', { canRevert: true });
  await expect(page.locator('.sb-file')).toContainText(mock.run.targetPath);
  await expect(page.locator('.toast')).toContainText('Deck created. Double-click text to edit, or right-click anything to leave a note.');
  await expect(page.frameLocator('iframe#deck').locator('h1')).toHaveText('Coffee club');
  expect(await page.evaluate(() => localStorage.getItem('deckhand.draft'))).toBeNull();
  await page.goBack();
  await expect(page.locator('.home')).toBeVisible();
  await expect(page.locator('.recent-row').first().locator('.recent-name')).toHaveText('6-slide-pitch-for-our-new.html');
});

test('AC-16 a failed create shows the error with Try again, Edit description and Copy prompt', async ({ page, deckhand }) => {
  const mock = await startCreate(page, deckhand);
  mock.line({ kind: 'status', text: 'Starting Claude Code' });
  mock.finish('failed', { error: 'API Error: 401 Invalid API key. Please run /login', canRevert: false });
  await expect(gen(page).getByRole('heading', { name: "That didn't work" })).toBeVisible();
  await expect(gen(page).locator('.gen-error')).toHaveText('API Error: 401 Invalid API key. Please run /login');
  await expect(gen(page).getByRole('button', { name: 'Stop' })).toHaveCount(0);
  await expect(gen(page).getByRole('button', { name: 'Open what it made' })).toHaveCount(0);

  await gen(page).getByRole('button', { name: 'Copy prompt' }).click();
  await expect(page.locator('.toast')).toContainText('Prompt copied');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain(DESCRIPTION);

  await gen(page).getByRole('button', { name: 'Try again' }).click();
  await expect.poll(() => mock.callsTo('POST', '/api/runs').length).toBe(2);
  expect(mock.callsTo('POST', '/api/runs')[1].body).toEqual({ kind: 'create', description: DESCRIPTION });
  await expect(page).toHaveURL(/run=run_2$/);
  await expect(gen(page).getByRole('heading', { name: 'Building your deck' })).toBeVisible();
  await expect(gen(page).locator('.activity-line')).toHaveCount(0);

  mock.finish('failed', { error: 'Still broken' });
  await gen(page).getByRole('button', { name: 'Edit description' }).click();
  await expect(page.locator('.home')).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Describe the deck you want' })).toHaveValue(DESCRIPTION);
});

test('AC-17 finishing without a file says so', async ({ page, deckhand }) => {
  const mock = await startCreate(page, deckhand);
  mock.finish('failed', { error: null, outputUsable: false });
  await expect(gen(page).locator('.gen-error')).toHaveText('The agent finished without writing the deck.');
});

test('a failed create that left a usable file offers Open what it made', async ({ page, deckhand }) => {
  const mock = await startCreate(page, deckhand);
  fs.mkdirSync(mock.decksDir, { recursive: true });
  fs.writeFileSync(mock.run.targetPath, DECK);
  mock.finish('failed', { error: 'Exited with code 1', outputUsable: true });
  await gen(page).getByRole('button', { name: 'Open what it made' }).click();
  await expect(page.locator('.sb-file')).toContainText(mock.run.targetPath);
});

test('AC-18 Stop ends the run and returns Home with the description intact', async ({ page, deckhand }) => {
  const mock = await startCreate(page, deckhand);
  await gen(page).getByRole('button', { name: 'Stop' }).click();
  await expect.poll(() => mock.callsTo('POST', '/api/runs/run_1/stop').length).toBe(1);
  await expect(page.locator('.home')).toBeVisible();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole('textbox', { name: 'Describe the deck you want' })).toHaveValue(DESCRIPTION);
  await expect(page.locator('.toast')).toContainText('Stopped. Nothing was saved.');
});

test('AC-19 reloading mid-create returns to the generation screen and completion opens the editor', async ({ page, deckhand }) => {
  const mock = await startCreate(page, deckhand);
  mock.line({ kind: 'status', text: 'Thinking…' });
  mock.line({ kind: 'write', text: 'Writing 6-slide-pitch-for-our-new.html' });
  await expect(gen(page).locator('.activity-line')).toHaveCount(2);
  await page.reload();
  await expect(gen(page).getByRole('heading', { name: 'Building your deck' })).toBeVisible();
  await expect(gen(page).locator('.gen-quote')).toHaveText(DESCRIPTION);
  await expect(gen(page).locator('.activity-line')).toHaveText(['Thinking…', 'Writing 6-slide-pitch-for-our-new.html']);
  await mock.ready();
  fs.mkdirSync(mock.decksDir, { recursive: true });
  fs.writeFileSync(mock.run.targetPath, DECK);
  mock.finish('succeeded');
  await expect(page.locator('.sb-file')).toContainText(mock.run.targetPath);
});

test('opening Home while a create is running offers a way back to it', async ({ page, deckhand }) => {
  const mock = await mockHome(page, deckhand, {
    run: runningRun(null, { kind: 'create', label: 'New deck', description: DESCRIPTION, targetPath: '/tmp/x.html' }),
  });
  await page.goto(deckhand.url);
  const banner = page.locator('.home-running');
  await expect(banner).toContainText('Claude Code is building a deck');
  await banner.getByRole('button', { name: 'Watch it' }).click();
  await expect(gen(page).getByRole('heading', { name: 'Building your deck' })).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`run=${mock.run.id}$`));
});
