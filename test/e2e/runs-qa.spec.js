import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from './fixtures.js';
import { BASIC, THREE, addNotes, getState, postApi, handoff, card } from './runs-helpers.js';
import { editUrl } from './editor-helpers.js';
import { decksDir, input, openHome, topName } from './home-helpers.js';

test.use({ deckhandOptions: { deck: BASIC, agents: ['claude'] } });

test('m1 a finished run keeps its activity lines after a reload', async ({ page, deckhand }) => {
  await addNotes(deckhand, THREE);
  await page.goto(await editUrl(deckhand));
  await handoff(page).click();
  await expect(card(page).locator('.activity-state')).toHaveText('Done');
  const shown = await card(page).locator('.activity-line').count();
  expect(shown).toBeGreaterThan(2);
  await page.reload();
  await expect(card(page).locator('.activity-state')).toHaveText('Done');
  await expect(card(page).locator('.activity-line')).toHaveCount(shown);
});

test('m4 / always shows Home, with a way back into the open deck', async ({ page, deckhand }) => {
  await page.goto(deckhand.url);
  await expect(page.locator('.home')).toBeVisible();
  await expect(page.locator('.editor')).toBeHidden();
  const resume = page.getByRole('button', { name: 'Continue editing basic.html' });
  await resume.click();
  await expect(topName(page)).toHaveText('basic.html');
  await expect(page).toHaveURL(/\/edit\?deck=/);
});

test.describe('agent text', () => {
  test.use({ deckhandOptions: { deck: BASIC, agents: ['claude'], scenario: 'runs-ui-markdown' } });

  test('agent messages render light Markdown as real elements, never as HTML', async ({ page, deckhand }) => {
    await addNotes(deckhand, THREE);
    await page.goto(await editUrl(deckhand));
    await handoff(page).click();
    await expect(card(page).locator('.activity-state')).toHaveText('Done');
    const text = card(page).locator('.activity-line.kind-text').first();
    await expect(text.locator('strong')).toHaveText('Made the title bigger');
    await expect(text.locator('em')).toHaveText('warmer');
    await expect(text.locator('code')).toHaveText(['dh3', 'h1']);
    await expect(text.locator('li')).toHaveText(['First change', 'Second change']);
    await expect(text).not.toContainText('**');
    await expect(text.locator('img')).toHaveCount(0);
    await expect(text).toContainText('<img src=x onerror=alert(1)>');
  });
});

test.describe('during an edit run', () => {
  test.use({ deckhandOptions: { deck: BASIC, agents: ['claude'], scenario: 'hang' } });

  test('m6 Home shows the run and keeps the Open card from switching decks', async ({ page, deckhand }) => {
    await addNotes(deckhand, THREE);
    const other = path.join(fs.realpathSync(deckhand.home), 'other.html');
    fs.writeFileSync(other, '<!DOCTYPE html><html><body><section><h1>Other</h1></section></body></html>');
    const { deck } = await getState(deckhand);
    const run = await postApi(deckhand, '/api/runs', { kind: 'edit', scope: 'all' });
    await openHome(page, deckhand);
    await expect(page.locator('.home-running')).toContainText('Claude Code is editing basic.html');
    const openCard = page.locator('.home-open');
    await expect(openCard.locator('.open-busy')).toContainText("Opening another deck waits until Claude Code finishes.");
    await expect(page.getByRole('textbox', { name: 'Deck path' })).toBeDisabled();
    await expect(openCard.getByRole('button', { name: 'Browse…' })).toBeDisabled();
    await page.locator('.home-running').getByRole('button', { name: 'Watch it' }).click();
    await expect(topName(page)).toHaveText(deck.name);
    await postApi(deckhand, `/api/runs/${run.id}/stop`);
    await page.getByRole('button', { name: '← Home' }).click();
    await expect(page.getByRole('textbox', { name: 'Deck path' })).toBeEnabled();
  });
});

test.describe('create runs', () => {
  test.use({ deckhandOptions: { agents: ['claude'] }, permissions: ['clipboard-read', 'clipboard-write'] });

  test('n6 after a create, the card offers Delete this deck rather than Revert', async ({ page, deckhand }) => {
    await openHome(page, deckhand);
    await input(page).fill('A short deck about tidy desks');
    await page.locator('.create-submit').click();
    await expect(topName(page)).toBeVisible({ timeout: 10_000 });
    await expect(card(page).getByRole('button', { name: 'Delete this deck' })).toBeVisible();
    await expect(card(page).getByRole('button', { name: 'Revert changes' })).toHaveCount(0);
    await card(page).getByRole('button', { name: 'Delete this deck' }).click();
    const dialog = page.getByRole('dialog', { name: 'Revert this run?' });
    await expect(dialog.getByRole('button', { name: 'Delete this deck' })).toBeVisible();
  });

  test('m5 a very long description never breaks Saves as or logs an error', async ({ page, deckhand }) => {
    await openHome(page, deckhand);
    const long = `A deck about tidy desks ${'and more detail '.repeat(1400)}`;
    expect(long.length).toBeGreaterThan(20_000);
    await input(page).fill(long);
    await expect(page.locator('.create-target')).toHaveText(/^Saves as ~\/Deckhand\/.+\.html$/);
    await input(page).press('End');
    await page.keyboard.type(' yes');
    await page.waitForTimeout(400);
    await expect(page.locator('.create-target')).toHaveText(/^Saves as ~\/Deckhand\/.+\.html$/);
  });

  test('Copy prompt after a failed create names the same file as Saves as', async ({ page, deckhand }) => {
    const description = 'A deck about failing well [[fake:edit-then-fail]]';
    await openHome(page, deckhand);
    await input(page).fill(description);
    await page.locator('.create-submit').click();
    await expect(page.getByRole('button', { name: 'Open what it made' })).toBeVisible({ timeout: 10_000 });
    await page.getByRole('button', { name: 'Copy prompt' }).click();
    await expect(page.locator('.toast')).toContainText('Prompt copied');
    const clip = await page.evaluate(() => navigator.clipboard.readText());
    await page.getByRole('button', { name: 'Edit description' }).click();
    const saves = (await page.locator('.create-target-path').textContent()).split('/').pop();
    expect(clip).toContain(saves);
    expect(fs.existsSync(path.join(decksDir(deckhand), saves))).toBe(false);
  });
});
