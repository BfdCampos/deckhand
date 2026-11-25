import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from './fixtures.js';
import { slugify } from '../../src/shared/slug.js';
import { decksDir, getApi, postApi, openHome, trackRequests, input, topName } from './home-helpers.js';

test.use({ deckhandOptions: { agents: ['claude'] }, permissions: ['clipboard-read', 'clipboard-write'] });

const DESCRIPTION = 'A 6-slide pitch for our new coffee subscription, warm and minimal';
const withScenario = (name) => `${DESCRIPTION} [[fake:${name}]]`;
const gen = (page) => page.locator('.generation');
const target = (deckhand, description) => path.join(decksDir(deckhand), `${slugify(description)}.html`);

async function startCreate(page, deckhand, description) {
  await openHome(page, deckhand);
  await input(page).fill(description);
  await page.locator('.create-submit').click();
  await expect(gen(page)).toBeVisible();
}

test('AC-13 Create deck sends the build contract and description to the agent, staged', async ({ page, deckhand }) => {
  await startCreate(page, deckhand, DESCRIPTION);
  await expect(topName(page)).toBeVisible({ timeout: 10_000 });
  const [entry] = deckhand.agentLog({ mode: 'run' });
  expect(entry.stdin).toContain("You're creating a new slide deck for Deckhand");
  expect(entry.stdin).toContain(DESCRIPTION);
  expect(entry.stdin.indexOf("You're creating")).toBeLessThan(entry.stdin.indexOf(DESCRIPTION));
  expect(entry.cwd).toMatch(/deckhand-run-/);
  expect(fs.existsSync(target(deckhand, DESCRIPTION))).toBe(true);
});

test.describe('a long create', () => {
  test.use({ deckhandOptions: { agents: ['claude'], scenario: 'long-run' } });

  test('AC-14 the generation screen shows the description, agent, a ticking timer, activity and Stop', async ({ page, deckhand }) => {
    await startCreate(page, deckhand, DESCRIPTION);
    await expect(page).toHaveURL(/\/create\?run=/);
    await expect(gen(page).getByRole('heading', { name: 'Building your deck' })).toBeVisible();
    await expect(gen(page).locator('.gen-quote')).toHaveText(DESCRIPTION);
    await expect(gen(page).locator('.gen-agent')).toContainText('Claude Code');
    await expect(gen(page).locator('.gen-target')).toHaveText(`~/Deckhand/${slugify(DESCRIPTION)}.html`);
    const timer = gen(page).locator('.gen-timer');
    await expect(timer).toHaveText(/^0:0\d$/);
    await expect(timer).toHaveText('0:01', { timeout: 2500 });
    await expect(gen(page).locator('.activity-line', { hasText: 'Still working' }).first()).toBeVisible();
    await expect(gen(page).getByRole('button', { name: 'Stop' })).toBeVisible();
    await expect(gen(page)).toContainText("You can close this tab. The run keeps going and the deck will be in Recent when it's done.");
    await expect(topName(page)).toBeVisible({ timeout: 10_000 });
  });
});

test('AC-15 success opens the editor on the new deck, first in recents, with the toast', async ({ page, deckhand }) => {
  await startCreate(page, deckhand, DESCRIPTION);
  const file = fs.realpathSync(decksDir(deckhand));
  await expect(topName(page)).toHaveText(`${slugify(DESCRIPTION)}.html`, { timeout: 10_000 });
  await expect(topName(page)).toHaveAttribute('title', path.join(file, `${slugify(DESCRIPTION)}.html`));
  await expect(page.locator('.toast')).toContainText('Deck created. Double-click text to edit, or right-click anything to leave a note.');
  expect(await page.evaluate(() => localStorage.getItem('deckhand.draft'))).toBeNull();
  await page.goBack();
  await expect(page.locator('.home')).toBeVisible();
  await expect(page.locator('.recent-row').first().locator('.recent-name')).toHaveText(`${slugify(DESCRIPTION)}.html`);
});

test.describe('failures', () => {
  test.use({ expectedApiErrors: [] });

  test('AC-16 a failed create shows the error with Try again, Edit description and Copy prompt, and leaves no file', async ({ page, deckhand }) => {
    const description = withScenario('fail-mid-run');
    await startCreate(page, deckhand, description);
    await expect(gen(page).getByRole('heading', { name: "That didn't work" })).toBeVisible({ timeout: 10_000 });
    await expect(gen(page).locator('.gen-error')).toContainText('The agent hit an error halfway through.');
    await expect(gen(page).getByRole('button', { name: 'Stop' })).toHaveCount(0);
    await expect(gen(page).getByRole('button', { name: 'Open what it made' })).toHaveCount(0);
    expect(fs.existsSync(target(deckhand, description))).toBe(false);

    await gen(page).getByRole('button', { name: 'Copy prompt' }).click();
    await expect(page.locator('.toast')).toContainText('Prompt copied');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toContain(DESCRIPTION);

    const runs = trackRequests(page, '/api/runs');
    const firstUrl = page.url();
    await gen(page).getByRole('button', { name: 'Try again' }).click();
    await expect.poll(() => runs).toEqual([{ kind: 'create', description }]);
    await expect(page).not.toHaveURL(firstUrl);
    await expect(gen(page).getByRole('heading', { name: "That didn't work" })).toBeVisible({ timeout: 10_000 });
    expect(deckhand.agentLog({ mode: 'run' })).toHaveLength(2);

    await gen(page).getByRole('button', { name: 'Edit description' }).click();
    await expect(page.locator('.home')).toBeVisible();
    await expect(input(page)).toHaveValue(description);
  });

  test('an instant failure stays on the generation screen', async ({ page, deckhand }) => {
    const description = withScenario('fail');
    await startCreate(page, deckhand, description);
    await expect(gen(page).getByRole('heading', { name: "That didn't work" })).toBeVisible({ timeout: 10_000 });
    await page.waitForTimeout(300);
    await expect(gen(page)).toBeVisible();
    await expect(page.locator('.home')).toBeHidden();
    await expect(page).toHaveURL(/\/create\?run=/);
  });

  test('AC-17 finishing without a file says so', async ({ page, deckhand }) => {
    await startCreate(page, deckhand, withScenario('create-nothing'));
    await expect(gen(page).locator('.gen-error')).toHaveText('The agent finished without writing the deck.', { timeout: 10_000 });
  });

  test('a file with no content is not a usable deck', async ({ page, deckhand }) => {
    const description = withScenario('create-empty-body');
    await startCreate(page, deckhand, description);
    await expect(gen(page).getByRole('heading', { name: "That didn't work" })).toBeVisible({ timeout: 10_000 });
    await expect(gen(page).getByRole('button', { name: 'Open what it made' })).toHaveCount(0);
    expect(fs.existsSync(target(deckhand, description))).toBe(false);
  });

  test('a failed create that left a usable deck offers Open what it made', async ({ page, deckhand }) => {
    const description = withScenario('edit-then-fail');
    await startCreate(page, deckhand, description);
    await gen(page).getByRole('button', { name: 'Open what it made' }).click({ timeout: 10_000 });
    await expect(topName(page)).toHaveText(`${slugify(description)}.html`);
  });
});

test('AC-18 Stop ends the run, leaves no file and returns Home with the description intact', async ({ page, deckhand }) => {
  const description = withScenario('hang');
  await startCreate(page, deckhand, description);
  await expect(gen(page).locator('.activity-line').first()).toBeVisible();
  const [entry] = deckhand.agentLog({ mode: 'run' });
  await gen(page).getByRole('button', { name: 'Stop' }).click();
  await expect(page.locator('.home')).toBeVisible();
  await expect(page).toHaveURL(`${deckhand.url}/`);
  await expect(input(page)).toHaveValue(description);
  await expect(page.locator('.toast')).toContainText('Stopped. Nothing was saved.');
  expect(fs.existsSync(target(deckhand, description))).toBe(false);
  await expect.poll(() => { try { process.kill(entry.pid, 0); return true; } catch { return false; } }, { timeout: 3000 }).toBe(false);
});

test('AC-19 reloading mid-create returns to the generation screen and completion opens the editor', async ({ page, deckhand }) => {
  const description = withScenario('long-run');
  await startCreate(page, deckhand, description);
  await expect(gen(page).locator('.activity-line', { hasText: 'Still working' }).first()).toBeVisible();
  const before = await gen(page).locator('.activity-line').count();
  await page.reload();
  await expect(gen(page).getByRole('heading', { name: 'Building your deck' })).toBeVisible();
  await expect(gen(page).locator('.gen-quote')).toHaveText(description);
  expect(await gen(page).locator('.activity-line').count()).toBeGreaterThanOrEqual(before);
  await expect(topName(page)).toHaveText(`${slugify(description)}.html`, { timeout: 10_000 });
});

test('opening Home while a create is running offers a way back to it', async ({ page, deckhand }) => {
  const run = await postApi(deckhand, '/api/runs', { kind: 'create', description: withScenario('hang') });
  await openHome(page, deckhand);
  const banner = page.locator('.home-running');
  await expect(banner).toContainText('Claude Code is building a deck');
  await banner.getByRole('button', { name: 'Watch it' }).click();
  await expect(gen(page).getByRole('heading', { name: 'Building your deck' })).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`run=${run.id}$`));
  await gen(page).getByRole('button', { name: 'Stop' }).click();
  await expect(page.locator('.home')).toBeVisible();
  expect((await getApi(deckhand, '/api/state')).run.status).toBe('stopped');
});
