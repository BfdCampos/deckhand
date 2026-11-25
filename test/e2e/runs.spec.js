import fs from 'node:fs';
import { test, expect } from './fixtures.js';
import { mockRuns, writeNotes, runningRun } from './runs-mock.js';

// Agents and runs routes plus run events are mocked (see runs-mock.js) until
// WP3.1 lands; the deck, notes file and file watching are the real server.

test.use({ deckhandOptions: { deck: 'test/fixtures/decks/basic.html', agents: ['claude'] } });

const THREE = [
  { id: 'n_a', text: 'Make the title bigger', targetTag: 'h1', slide: 1 },
  { id: 'n_b', text: 'Two columns here', targetTag: 'ul', slide: 2 },
  { id: 'n_c', text: 'Warmer quote', targetTag: 'blockquote', slide: 3 },
];

async function openEditor(page, deckhand, { notes = [], ...opts } = {}) {
  writeNotes(deckhand.deckPath, notes);
  const mock = await mockRuns(page, { deckPath: deckhand.deckPath, ...opts });
  await page.goto(deckhand.url);
  await expect(page.locator('.sb-file')).toContainText('basic.html');
  await expect(page.locator('.runs-foot')).toBeVisible();
  if (notes.length) await expect(page.locator('.note-item')).toHaveCount(notes.length);
  await mock.ready();
  await page.waitForLoadState('networkidle');
  return mock;
}

const handoff = (page) => page.locator('.runs-handoff');
const card = (page) => page.locator('.activity-card');

test('AC-44 hand-off is disabled with no notes and no tweaks', async ({ page, deckhand }) => {
  await openEditor(page, deckhand);
  await expect(handoff(page)).toBeDisabled();
  await expect(handoff(page)).toHaveAttribute('title', 'Add a note first');
  await expect(handoff(page)).toContainText('Hand off to Claude Code');
  await expect(card(page)).toBeHidden();
});

test('AC-45 hand-off runs the selected agent once with all notes', async ({ page, deckhand }) => {
  const mock = await openEditor(page, deckhand, { notes: THREE });
  await expect(handoff(page)).toBeEnabled();
  await expect(handoff(page).locator('.pill-count')).toHaveText('3');
  await handoff(page).click();
  await expect.poll(() => mock.callsTo('POST', '/api/runs').length).toBe(1);
  expect(mock.callsTo('POST', '/api/runs')[0].body).toEqual({ kind: 'edit', scope: 'all' });
  await expect(card(page).locator('.activity-label')).toHaveText('All notes');
});

test('AC-45 Run on a note runs only that note', async ({ page, deckhand }) => {
  const mock = await openEditor(page, deckhand, { notes: THREE });
  await page.locator('#note-n_b').getByRole('button', { name: 'Run' }).click();
  await expect.poll(() => mock.callsTo('POST', '/api/runs').length).toBe(1);
  expect(mock.callsTo('POST', '/api/runs')[0].body).toEqual({ kind: 'edit', scope: 'note', noteId: 'n_b' });
  await expect(card(page).locator('.activity-label')).toHaveText('Note 2');
});

test('AC-46 while running the deck is locked, the pill shows and the button reads Stop', async ({ page, deckhand }) => {
  await openEditor(page, deckhand, { notes: THREE });
  await handoff(page).click();
  await expect(page.getByText('Claude Code is editing your deck…')).toBeVisible();
  const stop = page.locator('.runs-stop');
  await expect(stop).toBeVisible();
  await expect(stop).toContainText('Stop');
  await expect(handoff(page)).toBeHidden();
  await expect(page.locator('.runs-foot .agent-chip')).toBeDisabled();
  await expect(card(page).locator('.activity-state')).toHaveText('Working');
});

test('AC-47 activity reads read, edit, blocked, agent text and result in order', async ({ page, deckhand }) => {
  const mock = await openEditor(page, deckhand, { notes: THREE });
  await handoff(page).click();
  await expect(card(page)).toBeVisible();
  mock.line({ kind: 'status', text: 'Starting Claude Code' });
  mock.line({ kind: 'status', text: 'Thinking…' });
  mock.line({ kind: 'status', text: 'Thinking…' });
  mock.line({ kind: 'read', text: 'Reading basic.html', file: 'basic.html' });
  mock.line({ kind: 'edit', text: 'Editing basic.html', file: 'basic.html' });
  mock.line({ kind: 'blocked', text: 'Blocked: Bash (not allowed)', tool: 'Bash' });
  mock.line({ kind: 'text', text: 'I made the title bigger and split the list.' });
  mock.line({ kind: 'result', text: 'Applied the notes.' });
  const lines = card(page).locator('.activity-line');
  await expect(lines).toHaveText([
    'Starting Claude Code',
    'Thinking…',
    'Reading basic.html',
    'Editing basic.html',
    'Blocked: Bash (not allowed)',
    'I made the title bigger and split the list.',
    'Applied the notes.',
  ]);
  await expect(lines.nth(4)).toHaveClass(/kind-blocked/);
  await expect(lines.nth(5)).toHaveClass(/kind-text/);
});

test('AC-48 the deck reloads live when the agent writes the file mid-run', async ({ page, deckhand }) => {
  await openEditor(page, deckhand, { notes: THREE });
  await handoff(page).click();
  await expect(page.locator('.runs-stop')).toBeVisible();
  const src = fs.readFileSync(deckhand.deckPath, 'utf8');
  fs.writeFileSync(deckhand.deckPath, src.replace('<h1>Basic deck</h1>', '<h1>Edited: Basic deck</h1>'));
  await expect(page.frameLocator('iframe#deck').locator('h1')).toHaveText('Edited: Basic deck', { timeout: 5000 });
});

test('AC-49 two of three applied: summary and a Still open tag', async ({ page, deckhand }) => {
  const mock = await openEditor(page, deckhand, { notes: THREE });
  await handoff(page).click();
  await expect(page.locator('.runs-stop')).toBeVisible();
  mock.setRun({ noteIds: ['n_a', 'n_b', 'n_c'] });
  writeNotes(deckhand.deckPath, THREE.map((n) => ({ ...n, status: n.id === 'n_c' ? 'open' : 'done' })));
  mock.finish('succeeded', { summary: { applied: 2, total: 3 } });
  mock.emit({ type: 'deck-changed', source: 'agent' });
  await expect(card(page).locator('.activity-state')).toHaveText('Done');
  await expect(card(page).locator('.activity-summary')).toHaveText('Applied 2 of 3 notes.');
  await expect(page.locator('#note-n_c')).toContainText('Still open');
  await expect(page.locator('#note-n_a')).not.toContainText('Still open');
  await expect(handoff(page)).toBeVisible();
});

test('AC-50 the browser never writes notes during or after a run', async ({ page, deckhand }) => {
  const mock = await openEditor(page, deckhand, { notes: THREE });
  await handoff(page).click();
  await expect(page.locator('.runs-stop')).toBeVisible();
  const before = mock.sent.length;
  writeNotes(deckhand.deckPath, THREE.map((n) => ({ ...n, status: 'done', text: `${n.text} (agent)` })));
  mock.finish('succeeded', { summary: { applied: 3, total: 3 } });
  mock.emit({ type: 'deck-changed', source: 'agent' });
  await expect(card(page).locator('.activity-state')).toHaveText('Done');
  await page.waitForTimeout(300);
  const writes = mock.sent.slice(before).filter((m) => /save-notes|save-html/.test(String(m)));
  expect(writes).toEqual([]);
  const saved = JSON.parse(fs.readFileSync(deckhand.deckPath.replace(/\.html$/, '.deckhand.json'), 'utf8'));
  expect(saved.notes.every((n) => n.text.endsWith('(agent)'))).toBe(true);
});

test('AC-51 Revert asks first, then reverts the run', async ({ page, deckhand }) => {
  const mock = await openEditor(page, deckhand, { notes: THREE });
  await handoff(page).click();
  await expect(page.locator('.runs-stop')).toBeVisible();
  mock.finish('succeeded', { summary: { applied: 3, total: 3 } });
  const revert = card(page).getByRole('button', { name: 'Revert changes' });
  await revert.click();
  const dialog = page.getByRole('dialog', { name: 'Revert this run?' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toBeHidden();
  expect(mock.callsTo('POST', '/api/runs/run_1/revert')).toHaveLength(0);

  await revert.click();
  await page.getByRole('dialog', { name: 'Revert this run?' }).getByRole('button', { name: 'Revert changes' }).click();
  await expect.poll(() => mock.callsTo('POST', '/api/runs/run_1/revert').length).toBe(1);
  await expect(page.locator('.toast')).toContainText('Reverted');
  await expect(card(page).getByRole('button', { name: 'Revert changes' })).toHaveCount(0);
  await expect(card(page).locator('.activity-summary')).toContainText('back how they were');
});

test('AC-52 a failed run shows Didn\'t finish, the error, Revert and Copy prompt', async ({ page, deckhand }) => {
  const mock = await openEditor(page, deckhand, { notes: THREE });
  await handoff(page).click();
  await expect(page.locator('.runs-stop')).toBeVisible();
  mock.line({ kind: 'edit', text: 'Editing basic.html' });
  mock.finish('failed', { error: 'API Error: 401 Invalid API key. Please run /login' });
  await expect(card(page).locator('.activity-state')).toHaveText("Didn't finish");
  await expect(card(page)).toHaveClass(/tone-error/);
  await expect(card(page).locator('.activity-error')).toHaveText('API Error: 401 Invalid API key. Please run /login');
  await expect(card(page).getByRole('button', { name: 'Revert changes' })).toBeVisible();
  await expect(card(page).getByRole('button', { name: 'Copy prompt' })).toBeVisible();
  await expect(page.getByText('Claude Code is editing your deck…')).toBeHidden();
});

test('AC-53 Stop responds at once, stops the run and offers Revert', async ({ page, deckhand }) => {
  const mock = await openEditor(page, deckhand, { notes: THREE });
  await handoff(page).click();
  const stop = page.locator('.runs-stop');
  await expect(stop).toBeVisible();
  mock.holdStop = true;
  await stop.click();
  await expect(stop).toBeDisabled();
  await expect(stop).toContainText('Stopping…');
  await expect(card(page).locator('.activity-state')).toHaveText('Stopping…');
  await expect.poll(() => mock.callsTo('POST', '/api/runs/run_1/stop').length).toBe(1);
  mock.releaseStop();
  await expect(card(page).locator('.activity-state')).toHaveText('Stopped');
  await expect(card(page).locator('.activity-summary')).toHaveText('Stopped. Any edits it already made are still in the file.');
  await expect(card(page).getByRole('button', { name: 'Revert changes' })).toBeVisible();
  await expect(handoff(page)).toBeVisible();
});

test('AC-54 reopening the tab mid-run shows the running state and the full log', async ({ page, deckhand }) => {
  const run = runningRun(deckhand.deckPath);
  const activity = [
    { seq: 1, ts: run.startedAt, kind: 'status', text: 'Starting Claude Code' },
    { seq: 2, ts: run.startedAt, kind: 'read', text: 'Reading basic.html' },
    { seq: 3, ts: run.startedAt, kind: 'edit', text: 'Editing basic.html' },
  ];
  const mock = await openEditor(page, deckhand, { notes: THREE, run, activity });
  await expect(page.locator('.runs-stop')).toBeVisible();
  await expect(page.getByText('Claude Code is editing your deck…')).toBeVisible();
  const lines = card(page).locator('.activity-line');
  await expect(lines).toHaveText(['Starting Claude Code', 'Reading basic.html', 'Editing basic.html']);
  await expect(card(page).locator('.activity-timer')).toHaveText(/^0:4\d$/);

  mock.emit({ type: 'run-activity', runId: run.id, line: activity[2] });
  mock.line({ kind: 'text', text: 'Nearly there.' });
  await expect(lines).toHaveText(['Starting Claude Code', 'Reading basic.html', 'Editing basic.html', 'Nearly there.']);
});

test.describe('prompts', () => {
  test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

  test('AC-55 Copy prompt and Show prompt name the deck and the work order', async ({ page, deckhand }) => {
    await openEditor(page, deckhand, { notes: THREE });
    const wo = deckhand.deckPath.replace(/\.html$/, '.deckhand.md');
    await page.locator('.runs-caret').click();
    await page.getByRole('menuitem', { name: 'Copy prompt' }).click();
    await expect(page.locator('.toast')).toContainText('Prompt copied');
    const clip = await page.evaluate(() => navigator.clipboard.readText());
    expect(clip).toContain(deckhand.deckPath);
    expect(clip).toContain(wo);

    await page.locator('.runs-caret').click();
    await page.getByRole('menuitem', { name: 'Show prompt' }).click();
    const dialog = page.getByRole('dialog', { name: 'The prompt for your AI' });
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('.prompt-text')).toContainText(wo);
    await expect(dialog).toContainText(deckhand.deckPath);
  });

  test.describe('with no agent', () => {
    test.use({ deckhandOptions: { deck: 'test/fixtures/decks/basic.html', agents: [] } });

    test('AC-8 the footer reads Copy prompt for your AI and copies it', async ({ page, deckhand }) => {
      const mock = await openEditor(page, deckhand, { notes: THREE, agents: [] });
      const main = page.locator('.runs-copy');
      await expect(main).toHaveText('Copy prompt for your AI');
      await expect(handoff(page)).toHaveCount(0);
      await expect(page.locator('.runs-foot .agent-chip')).toContainText('No agent');
      await main.click();
      await expect(page.locator('.toast')).toContainText('Prompt copied');
      expect(await page.evaluate(() => navigator.clipboard.readText())).toContain(deckhand.deckPath);
      expect(mock.callsTo('POST', '/api/runs')).toHaveLength(0);
      await page.locator('.runs-caret').click();
      await expect(page.getByRole('menuitem')).toHaveText(['Show prompt']);
    });
});
});

test('a run on another deck or a create run makes the button read Busy with another run', async ({ page, deckhand }) => {
  const run = runningRun('/elsewhere/other.html', { kind: 'create', label: 'New deck' });
  await openEditor(page, deckhand, { notes: THREE, run });
  await expect(handoff(page)).toBeDisabled();
  await expect(handoff(page)).toContainText('Busy with another run');
  await expect(page.getByText('Claude Code is editing your deck…')).toHaveCount(0);
});

test.describe('server errors', () => {
  test.use({ allowedConsoleErrors: [/Failed to load resource: the server responded with a status of 409/] });

  test('a busy reply from the server shows a calm toast and changes nothing', async ({ page, deckhand }) => {
    const mock = await openEditor(page, deckhand, { notes: THREE });
    mock.failNext['POST /api/runs'] = { status: 409, code: 'busy' };
    await handoff(page).click();
    await expect(page.locator('.toast')).toContainText('Busy with another run');
    await expect(handoff(page)).toBeEnabled();
    await expect(card(page)).toBeHidden();
  });
});
