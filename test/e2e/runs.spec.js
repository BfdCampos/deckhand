import fs from 'node:fs';
import { test, expect } from './fixtures.js';
import {
  BASIC, THREE, addNotes, openEditor, getState, postApi, sidecar, readMaybe, runs, alive,
  handoff, stopButton, card, chip,
} from './runs-helpers.js';

test.use({ deckhandOptions: { deck: BASIC, agents: ['claude'] } });

const heading = (page) => page.frameLocator('iframe#deck').locator('h1');

test('AC-44 hand-off is disabled with no notes and no tweaks', async ({ page, deckhand }) => {
  await openEditor(page, deckhand);
  await expect(handoff(page)).toBeDisabled();
  await expect(handoff(page)).toHaveAttribute('title', 'Add a note first');
  await expect(handoff(page)).toContainText('Hand off to Claude Code');
  await expect(card(page)).toBeHidden();
  expect(runs(deckhand)).toHaveLength(0);
});

test('AC-45 hand-off runs the agent once with all notes and reports what it applied', async ({ page, deckhand }) => {
  await addNotes(deckhand, THREE);
  await openEditor(page, deckhand);
  await expect(handoff(page).locator('.pill-count')).toHaveText('3');
  await handoff(page).click();
  await expect(card(page).locator('.activity-label')).toHaveText('All notes');
  await expect(card(page).locator('.activity-state')).toHaveText('Done');
  await expect(card(page).locator('.activity-summary')).toHaveText('Applied 3 of 3 notes.');
  await expect(heading(page)).toHaveText(/^Edited: /);
  await expect(page.locator('.note-item.is-done')).toHaveCount(3);
  expect(runs(deckhand)).toHaveLength(1);
});

test('AC-45 Run on a note runs only that note', async ({ page, deckhand }) => {
  const notes = await addNotes(deckhand, THREE);
  await openEditor(page, deckhand);
  await page.locator(`#note-${notes[1].id}`).getByRole('button', { name: 'Run' }).click();
  await expect(card(page).locator('.activity-label')).toHaveText('Note 2');
  await expect(card(page).locator('.activity-summary')).toHaveText('Applied 1 of 1 note.');
  await expect(page.locator(`#note-${notes[1].id}`)).toHaveClass(/is-done/);
  await expect(page.locator(`#note-${notes[0].id}`)).not.toHaveClass(/is-done/);
  await expect(page.locator(`#note-${notes[2].id}`)).not.toHaveClass(/is-done/);
  expect(runs(deckhand)).toHaveLength(1);
});

test.describe('while an agent is working', () => {
  test.use({ deckhandOptions: { deck: BASIC, agents: ['claude'], scenario: 'runs-ui-edit-hang' } });

  test('AC-46 the deck is locked, the pill shows, Run buttons are off and the button reads Stop', async ({ page, deckhand }) => {
    await addNotes(deckhand, THREE);
    await openEditor(page, deckhand);
    await handoff(page).click();
    await expect(page.locator('.editor-pill')).toHaveText('Claude Code is editing your deck…');
    await expect(stopButton(page)).toContainText('Stop');
    await expect(handoff(page)).toHaveCount(0);
    await expect(chip(page)).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Text', exact: true })).toBeDisabled();
    await expect(page.locator('.note-item').getByRole('button', { name: 'Run' })).toHaveCount(0);
    await expect(card(page).locator('.activity-state')).toHaveText('Working');
    await stopButton(page).click();
    await expect(card(page).locator('.activity-state')).toHaveText('Stopped');
    await expect(page.locator('.editor-pill')).toBeHidden();
  });

  test('AC-48 the deck reloads live when the agent writes the file mid-run', async ({ page, deckhand }) => {
    await addNotes(deckhand, THREE);
    await openEditor(page, deckhand);
    await expect(heading(page)).toHaveText('Basic deck');
    await handoff(page).click();
    await expect(heading(page)).toHaveText('Edited: Basic deck', { timeout: 5000 });
    await expect(stopButton(page)).toBeVisible();
    await expect(card(page).locator('.activity-line.kind-text')).toHaveText('Working on the rest.');
    await stopButton(page).click();
    await expect(card(page).locator('.activity-state')).toHaveText('Stopped');
  });

  test('AC-53 Stop responds at once, kills the agent and offers Revert', async ({ page, deckhand }) => {
    await addNotes(deckhand, THREE);
    await openEditor(page, deckhand);
    await handoff(page).click();
    await expect(card(page).locator('.activity-line.kind-text')).toBeVisible();
    const [entry] = runs(deckhand);
    expect(alive(entry.pid)).toBe(true);
    await stopButton(page).click();
    await expect(card(page).locator('.activity-state')).toHaveText(/Stopping…|Stopped/);
    await expect(card(page).locator('.activity-state')).toHaveText('Stopped');
    await expect(card(page).locator('.activity-summary')).toHaveText('Stopped. Any edits it already made are still in the file.');
    await expect(card(page).getByRole('button', { name: 'Revert changes' })).toBeVisible();
    await expect(handoff(page)).toBeVisible();
    await expect.poll(() => alive(entry.pid), { timeout: 3000 }).toBe(false);
  });

  test('AC-54 reopening the tab mid-run shows the running state and the full log', async ({ page, context, deckhand }) => {
    await addNotes(deckhand, THREE);
    await openEditor(page, deckhand);
    await handoff(page).click();
    await expect(card(page).locator('.activity-line.kind-text')).toBeVisible();
    const before = await card(page).locator('.activity-line').allTextContents();
    await page.close();

    const again = await context.newPage();
    await openEditor(again, deckhand);
    await expect(stopButton(again)).toBeVisible();
    await expect(again.locator('.editor-pill')).toHaveText('Claude Code is editing your deck…');
    await expect(card(again).locator('.activity-line')).toHaveText(before);
    await stopButton(again).click();
    await expect(card(again).locator('.activity-state')).toHaveText('Stopped');
  });

  test('a create run makes the hand-off button read Busy with another run', async ({ page, deckhand }) => {
    await addNotes(deckhand, THREE);
    await openEditor(page, deckhand);
    const run = await postApi(deckhand, '/api/runs', { kind: 'create', description: 'A deck about busy tests' });
    await expect(handoff(page)).toBeDisabled();
    await expect(handoff(page)).toContainText('Busy with another run');
    await expect(page.locator('.editor-pill')).toBeHidden();
    await postApi(deckhand, `/api/runs/${run.id}/stop`);
    await expect(handoff(page)).toContainText('Hand off to Claude Code');
  });
});

test.describe('blocked tools', () => {
  test.use({ deckhandOptions: { deck: BASIC, agents: ['claude'], scenario: 'blocked' } });

  test('AC-47 activity reads start, read, blocked, edit, agent text and result in order', async ({ page, deckhand }) => {
    await addNotes(deckhand, THREE);
    await openEditor(page, deckhand);
    await handoff(page).click();
    await expect(card(page).locator('.activity-state')).toHaveText('Done');
    const kinds = await card(page).locator('.activity-line').evaluateAll((els) => els.map((e) => [...e.classList].find((c) => c.startsWith('kind-')).slice(5)));
    const order = kinds.filter((k, i) => k !== kinds[i - 1]);
    expect(order).toEqual(['status', 'read', 'blocked', 'edit', 'text', 'result']);
    const lines = card(page).locator('.activity-line');
    await expect(lines.filter({ hasText: 'Blocked: Bash' })).toHaveCount(1);
    await expect(lines.filter({ hasText: 'Blocked: Read' })).toHaveCount(1);
    await expect(lines.filter({ hasText: 'Reading basic.html' })).toHaveCount(1);
    await expect(lines.filter({ hasText: 'Editing basic.html' })).toHaveCount(1);
  });
});

test.describe('partial runs', () => {
  test.use({ deckhandOptions: { deck: BASIC, agents: ['claude'], scenario: 'runs-ui-tick-two' } });

  test('AC-49 two of three applied: summary and a Still open tag', async ({ page, deckhand }) => {
    const notes = await addNotes(deckhand, THREE);
    await openEditor(page, deckhand);
    await handoff(page).click();
    await expect(card(page).locator('.activity-summary')).toHaveText('Applied 2 of 3 notes.');
    await expect(page.locator(`#note-${notes[2].id}`)).toContainText('Still open');
    await expect(page.locator(`#note-${notes[0].id}`)).not.toContainText('Still open');
    await expect(page.locator(`#note-${notes[0].id}`)).toHaveClass(/is-done/);
    await expect(handoff(page).locator('.pill-count')).toHaveText('1');
  });
});

test('AC-50 the browser never writes notes during or after a run', async ({ page, deckhand }) => {
  await addNotes(deckhand, THREE);
  await openEditor(page, deckhand);
  const writes = [];
  page.on('request', (r) => { if (r.method() === 'POST' && new URL(r.url()).pathname === '/api/notes') writes.push(r.postData()); });
  await handoff(page).click();
  await expect(card(page).locator('.activity-state')).toHaveText('Done');
  await page.waitForTimeout(300);
  expect(writes).toEqual([]);
  const saved = JSON.parse(fs.readFileSync(sidecar(deckhand, 'json'), 'utf8'));
  expect(saved.notes.map((n) => n.status)).toEqual(['done', 'done', 'done']);
  expect(saved.notes.every((n) => n.doneBy === 'claude')).toBe(true);
});

test('AC-51 Revert asks first, then restores the deck and notes byte for byte', async ({ page, deckhand }) => {
  await addNotes(deckhand, THREE);
  await openEditor(page, deckhand);
  const before = { deck: readMaybe(deckhand.deckPath), json: readMaybe(sidecar(deckhand, 'json')), md: readMaybe(sidecar(deckhand, 'md')) };
  await handoff(page).click();
  await expect(card(page).locator('.activity-state')).toHaveText('Done');
  await expect(heading(page)).toHaveText(/^Edited: /);

  const revert = card(page).getByRole('button', { name: 'Revert changes' });
  await revert.click();
  const dialog = page.getByRole('dialog', { name: 'Revert this run?' });
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toBeHidden();
  expect(readMaybe(deckhand.deckPath).equals(fs.readFileSync(deckhand.deckPath))).toBe(true);
  await expect(heading(page)).toHaveText(/^Edited: /);

  await revert.click();
  await page.getByRole('dialog', { name: 'Revert this run?' }).getByRole('button', { name: 'Revert changes' }).click();
  await expect(page.locator('.toast')).toContainText('Reverted');
  await expect(card(page).locator('.activity-summary')).toContainText('back how they were');
  await expect(card(page).getByRole('button', { name: 'Revert changes' })).toHaveCount(0);
  await expect(heading(page)).toHaveText('Basic deck');
  expect(readMaybe(deckhand.deckPath)).toEqual(before.deck);
  expect(readMaybe(sidecar(deckhand, 'json'))).toEqual(before.json);
  expect(readMaybe(sidecar(deckhand, 'md'))).toEqual(before.md);
  await expect(page.locator('.note-item.is-done')).toHaveCount(0);
});

test.describe('a failing agent', () => {
  test.use({ deckhandOptions: { deck: BASIC, agents: ['claude'], scenario: 'edit-then-fail' } });

  test('AC-52 a failed run shows Didn\'t finish, the error, Revert and Copy prompt', async ({ page, deckhand }) => {
    await addNotes(deckhand, THREE);
    await openEditor(page, deckhand);
    await handoff(page).click();
    await expect(card(page).locator('.activity-state')).toHaveText("Didn't finish");
    await expect(card(page)).toHaveClass(/tone-error/);
    await expect(card(page).locator('.activity-error')).toContainText('Something went wrong after editing.');
    await expect(card(page).getByRole('button', { name: 'Revert changes' })).toBeVisible();
    await expect(card(page).getByRole('button', { name: 'Copy prompt' })).toBeVisible();
    await expect(page.locator('.editor-pill')).toBeHidden();
    await expect(page.locator('.note-item.is-done')).toHaveCount(0);
  });
});

test.describe('prompts', () => {
  test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

  test('AC-55 Copy prompt and Show prompt name the deck and the work order', async ({ page, deckhand }) => {
    await addNotes(deckhand, THREE);
    await openEditor(page, deckhand);
    const { deck } = await getState(deckhand);
    await page.locator('.runs-caret').click();
    await page.getByRole('menuitem', { name: 'Copy prompt' }).click();
    await expect(page.locator('.toast')).toContainText('Prompt copied');
    const clip = await page.evaluate(() => navigator.clipboard.readText());
    expect(clip).toContain(deck.path);
    expect(clip).toContain(deck.workOrderPath);

    await page.locator('.runs-caret').click();
    await page.getByRole('menuitem', { name: 'Show prompt' }).click();
    const dialog = page.getByRole('dialog', { name: 'The prompt for your AI' });
    await expect(dialog.locator('.prompt-text')).toContainText(deck.workOrderPath);
    await expect(dialog.locator('.prompt-meta')).toContainText('Work order');
    expect(runs(deckhand)).toHaveLength(0);
  });

  test.describe('with no agent', () => {
    test.use({ deckhandOptions: { deck: BASIC, agents: [] } });

    test('AC-8 the editor footer reads Copy prompt for your AI and copies it', async ({ page, deckhand }) => {
      await addNotes(deckhand, THREE);
      await openEditor(page, deckhand);
      const main = page.locator('.runs-copy');
      await expect(main).toHaveText('Copy prompt for your AI');
      await expect(handoff(page)).toHaveCount(0);
      await expect(chip(page)).toContainText('No agent');
      await main.click();
      await expect(page.locator('.toast')).toContainText('Prompt copied');
      expect(await page.evaluate(() => navigator.clipboard.readText())).toContain(deckhand.deckPath);
      await page.locator('.runs-caret').click();
      await expect(page.getByRole('menuitem')).toHaveText(['Show prompt']);
    });
  });
});

test('AC-56 the edit run only offers file tools and carries the guardrail', async ({ page, deckhand }) => {
  await addNotes(deckhand, THREE);
  await openEditor(page, deckhand);
  await handoff(page).click();
  await expect(card(page).locator('.activity-state')).toHaveText('Done');
  const [entry] = runs(deckhand);
  const argv = entry.argv.join(' ');
  expect(argv).toContain('--tools Read,Edit,Write,Glob,Grep');
  expect(entry.argv).toContain('--append-system-prompt');
  expect(entry.cwd).toMatch(/deckhand-run-/);
});
