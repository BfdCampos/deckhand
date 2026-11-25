import { test, expect } from './fixtures.js';
import { mockRuns, writeNotes, runningRun } from './runs-mock.js';

// Detection and selection are mocked (see runs-mock.js) until WP3.1 lands.
// Persistence across a server restart (AC-7) and real PATH detection (AC-9)
// are covered server side by test/unit/detect.test.js in WP3.1.

test.use({ deckhandOptions: { deck: 'test/fixtures/decks/basic.html', agents: ['claude'] } });

async function openEditor(page, deckhand, opts = {}) {
  writeNotes(deckhand.deckPath, [{ id: 'n_a', text: 'Bigger title', targetTag: 'h1' }]);
  const mock = await mockRuns(page, { deckPath: deckhand.deckPath, ...opts });
  await page.goto(deckhand.url);
  await expect(page.locator('.runs-foot')).toBeVisible();
  await mock.ready();
  await page.waitForLoadState('networkidle');
  return mock;
}

const chip = (page) => page.locator('.runs-foot .agent-chip');

test('AC-6 with only Claude Code the chip reads Claude Code and has no dropdown', async ({ page, deckhand }) => {
  await openEditor(page, deckhand, { agents: ['claude'] });
  await expect(chip(page)).toHaveText('Claude Code');
  await expect(chip(page).locator('.dot-success')).toHaveCount(1);
  await expect(chip(page)).not.toHaveAttribute('aria-haspopup', 'menu');
  await chip(page).click();
  const pop = page.locator('.agent-pop');
  await expect(pop).toContainText('Using Claude Code 2.1.331. Deckhand runs it on this machine with your existing login.');
  await expect(pop.getByRole('button', { name: 'Check again' })).toBeVisible();
  await expect(page.getByRole('menu')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(pop).toBeHidden();
  await page.locator('.runs-caret').click();
  await expect(page.getByRole('menuitemradio')).toHaveCount(0);
});

test('AC-7 with both agents the chip is a keyboard dropdown and the choice drives the next run', async ({ page, deckhand }) => {
  const mock = await openEditor(page, deckhand, { agents: ['claude', 'codex'] });
  await expect(chip(page)).toHaveAttribute('aria-haspopup', 'menu');
  await expect(chip(page)).toContainText('Claude Code');

  await chip(page).focus();
  await page.keyboard.press('Enter');
  const menu = page.getByRole('menu');
  await expect(menu).toBeVisible();
  await expect(menu.getByRole('menuitemradio', { name: 'Claude Code' })).toHaveAttribute('aria-checked', 'true');
  await expect(menu.getByRole('menuitemradio', { name: 'Claude Code' })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');

  await expect.poll(() => mock.callsTo('POST', '/api/agents/select').map((c) => c.body)).toEqual([{ id: 'codex' }]);
  await expect(chip(page)).toContainText('Codex');
  await expect(chip(page)).toBeFocused();
  await expect(page.locator('.runs-handoff')).toContainText('Hand off to Codex');

  await page.locator('.runs-caret').click();
  await expect(page.getByRole('menuitemradio', { name: 'Codex' })).toHaveAttribute('aria-checked', 'true');
  await page.keyboard.press('Escape');

  await page.locator('.runs-handoff').click();
  await expect.poll(() => mock.run?.agentId).toBe('codex');
  await expect(page.getByText('Codex is editing your deck…')).toBeVisible();
});

test.describe('with no agent', () => {
  test.use({ deckhandOptions: { deck: 'test/fixtures/decks/basic.html', agents: [] } });

  test('AC-8 and AC-9 No agent, then Check again finds one without a restart', async ({ page, deckhand }) => {
    const mock = await openEditor(page, deckhand, { agents: [] });
    await expect(chip(page)).toContainText('No agent');
    await expect(chip(page).locator('.dot-warning')).toHaveCount(1);
    await chip(page).click();
    const pop = page.locator('.agent-pop');
    await expect(pop).toContainText('Deckhand needs Claude Code or Codex to create and edit decks for you.');
    await expect(pop.getByRole('link', { name: 'Claude Code' })).toHaveAttribute('target', '_blank');
    await expect(pop.getByRole('link', { name: 'Codex' })).toHaveAttribute('rel', /noopener/);

    await pop.getByRole('button', { name: 'Check again' }).click();
    await expect(pop).toContainText('Still no agent found.');

    mock.setFound(['claude']);
    await pop.getByRole('button', { name: 'Check again' }).click();
    await expect(chip(page)).toHaveText('Claude Code');
    await expect(page.locator('.agent-pop')).toHaveCount(0);
    await expect(page.locator('.toast')).toContainText('Found Claude Code 2.1.331');
    await expect(page.locator('.runs-handoff')).toContainText('Hand off to Claude Code');
    expect(mock.callsTo('POST', '/api/agents/detect')).toHaveLength(2);
  });
});

test('an agents event from the server updates the chip', async ({ page, deckhand }) => {
  const mock = await openEditor(page, deckhand, { agents: ['claude'] });
  mock.setFound(['claude', 'codex']);
  mock.selected = 'codex';
  mock.emit({ type: 'agents', agents: mock.agents() });
  await expect(chip(page)).toContainText('Codex');
  await expect(chip(page)).toHaveAttribute('aria-haspopup', 'menu');
});

test('switching agent is disabled while a run is going', async ({ page, deckhand }) => {
  await openEditor(page, deckhand, { agents: ['claude', 'codex'], run: runningRun(deckhand.deckPath) });
  await expect(chip(page)).toBeDisabled();
  await expect(chip(page)).toHaveAttribute('title', "You can't switch agents during a run.");
});
