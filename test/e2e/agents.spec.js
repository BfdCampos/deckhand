import { test, expect } from './fixtures.js';
import { BASIC, THREE, addNotes, openEditor, postApi, runs, handoff, card, chip } from './runs-helpers.js';

test.use({ deckhandOptions: { deck: BASIC, agents: ['claude'] } });

test('AC-6 with only Claude Code the chip reads Claude Code and has no dropdown', async ({ page, deckhand }) => {
  await openEditor(page, deckhand);
  await expect(chip(page)).toHaveText('Claude Code');
  await expect(chip(page).locator('.dot-success')).toHaveCount(1);
  await expect(chip(page)).not.toHaveAttribute('aria-haspopup', 'menu');
  await chip(page).click();
  const pop = page.locator('.agent-pop');
  await expect(pop).toContainText('Using Claude Code 2.1.331. Deckhand runs it on this machine with your existing login.');
  await expect(pop.getByRole('button', { name: 'Check again' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(pop).toBeHidden();
  await page.locator('.runs-caret').click();
  await expect(page.getByRole('menuitemradio')).toHaveCount(0);
});

test.describe('with both agents', () => {
  test.use({ deckhandOptions: { deck: BASIC, agents: ['claude', 'codex'] } });

  test('AC-7 the chip is a keyboard dropdown, the choice survives a restart and drives the next run', async ({ page, deckhand }) => {
    await addNotes(deckhand, THREE);
    await openEditor(page, deckhand);
    await expect(chip(page)).toHaveAttribute('aria-haspopup', 'menu');
    await expect(chip(page)).toContainText('Claude Code');

    await chip(page).focus();
    await page.keyboard.press('Enter');
    const menu = page.getByRole('menu');
    await expect(menu.getByRole('menuitemradio', { name: 'Claude Code' })).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await expect(chip(page)).toContainText('Codex');
    await expect(chip(page)).toBeFocused();
    await expect(handoff(page)).toContainText('Hand off to Codex');

    await deckhand.restart();
    await openEditor(page, deckhand);
    await expect(chip(page)).toContainText('Codex');

    await handoff(page).click();
    await expect(card(page).locator('.activity-state')).toHaveText('Done');
    const [entry] = runs(deckhand);
    expect(entry.tool).toBe('codex');
    expect(entry.argv).toEqual(expect.arrayContaining(['exec', '--json', '--sandbox', 'workspace-write']));
  });

  test('AC-10 Codex produces the same activity lines as Claude Code', async ({ page, deckhand }) => {
    const texts = async () => (await card(page).locator('.activity-line').allTextContents())
      .map((t) => t.replace(/Claude Code|Codex/g, 'AGENT'));
    await addNotes(deckhand, THREE);
    await openEditor(page, deckhand);
    await handoff(page).click();
    await expect(card(page).locator('.activity-state')).toHaveText('Done');
    const claude = await texts();

    await card(page).getByRole('button', { name: 'Revert changes' }).click();
    await page.getByRole('dialog', { name: 'Revert this run?' }).getByRole('button', { name: 'Revert changes' }).click();
    await expect(handoff(page)).toBeEnabled();
    await postApi(deckhand, '/api/agents/select', { id: 'codex' });
    await expect(handoff(page)).toContainText('Hand off to Codex');
    await handoff(page).click();
    await expect(card(page).locator('.activity-state')).toHaveText('Done');
    const codex = await texts();

    expect(runs(deckhand).map((r) => r.tool)).toEqual(['claude', 'codex']);
    const kinds = (list) => list.filter((t) => !/Thinking/.test(t));
    expect(kinds(codex).slice(0, 3)).toEqual(kinds(claude).slice(0, 3));
    expect(codex.some((t) => /Editing basic\.html/.test(t))).toBe(true);
    expect(codex.at(-1)).toBe(claude.at(-1));
  });

  test('switching agent is disabled while a run is going', async ({ page, deckhand }) => {
    await addNotes(deckhand, THREE);
    await openEditor(page, deckhand);
    await postApi(deckhand, '/api/runs', { kind: 'create', description: 'A deck about waiting [[fake:hang]]' });
    await expect(chip(page)).toBeDisabled();
    await expect(chip(page)).toHaveAttribute('title', "You can't switch agents during a run.");
  });
});

test.describe('with no agent', () => {
  test.use({ deckhandOptions: { deck: BASIC, agents: [] } });

  test('AC-8 and AC-9 No agent, then Check again finds one without a restart', async ({ page, deckhand }) => {
    await addNotes(deckhand, THREE);
    await openEditor(page, deckhand);
    await expect(chip(page)).toContainText('No agent');
    await expect(chip(page).locator('.dot-warning')).toHaveCount(1);
    await chip(page).click();
    const pop = page.locator('.agent-pop');
    await expect(pop).toContainText('Deckhand needs Claude Code or Codex to create and edit decks for you.');
    await expect(pop.getByRole('link', { name: 'Claude Code' })).toHaveAttribute('target', '_blank');
    await pop.getByRole('button', { name: 'Check again' }).click();
    await expect(pop).toContainText('Still no agent found.');

    deckhand.setAgents(['claude']);
    await pop.getByRole('button', { name: 'Check again' }).click();
    await expect(chip(page)).toHaveText('Claude Code');
    await expect(page.locator('.toast')).toContainText('Found Claude Code 2.1.331');
    await expect(handoff(page)).toContainText('Hand off to Claude Code');
  });

  test('an agents event from the server updates the chip', async ({ page, deckhand }) => {
    await openEditor(page, deckhand);
    await expect(chip(page)).toContainText('No agent');
    deckhand.setAgents(['claude', 'codex']);
    await postApi(deckhand, '/api/agents/detect');
    await expect(chip(page)).toContainText('Claude Code');
    await expect(chip(page)).toHaveAttribute('aria-haspopup', 'menu');
  });
});
