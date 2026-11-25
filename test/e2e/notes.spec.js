import { test, expect } from './fixtures.js';
import { deckFrame, readDisk, sidecar, openEditor, diskEventually } from './editor-helpers.js';

test.use({ deckhandOptions: { deck: 'test/fixtures/decks/basic.html' } });

const json = async (deckhand) => JSON.parse(await readDisk(sidecar(deckhand.deckPath, 'json')));

async function addNote(page, locator, text, { global = false } = {}) {
  await locator.scrollIntoViewIfNeeded();
  await locator.click({ button: 'right' });
  const pop = page.locator('.note-pop');
  await expect(pop).toBeVisible();
  await pop.locator('textarea').fill(text);
  if (global) await pop.getByLabel('Apply to all similar elements').check();
  await pop.locator('textarea').press('ControlOrMeta+Enter');
  await expect(pop).toHaveCount(0);
}

test('AC-39 a note gets a pin, a sidebar card and lands in the json and work order', async ({ page, deckhand }) => {
  await openEditor(page, deckhand);
  const h2 = deckFrame(page).locator('h2', { hasText: 'Things to say' });
  await addNote(page, h2, 'Make this two columns');

  await expect(page.locator('.pin')).toHaveText('1');
  const card = page.locator('.note-item');
  await expect(card).toHaveCount(1);
  await expect(card).toContainText('Make this two columns');
  await expect(card).toContainText('heading · slide 2');

  await expect.poll(async () => (await json(deckhand)).notes.map((n) => n.text)).toEqual(['Make this two columns']);
  const note = (await json(deckhand)).notes[0];
  expect(note).toMatchObject({ targetTag: 'h2', scope: 'element', slide: 2, status: 'open' });
  expect(note.aiId).toMatch(/^dh\d+$/);
  await diskEventually(sidecar(deckhand.deckPath, 'md'), (s) => s.includes('Make this two columns'));
});

test('AC-40 "Apply to all similar elements" stores a global note', async ({ page, deckhand }) => {
  await openEditor(page, deckhand);
  await addNote(page, deckFrame(page).locator('h2', { hasText: 'Things to say' }), 'Make every heading sans-serif', { global: true });
  await expect.poll(async () => (await json(deckhand)).notes[0]?.scope).toBe('global');
  await expect(page.locator('.note-item')).toContainText('all similar headings');
  await diskEventually(sidecar(deckhand.deckPath, 'md'), (s) => /all similar headings/.test(s));
});

test('AC-41 a stray click keeps a typed note, but closes an empty one', async ({ page, deckhand }) => {
  await openEditor(page, deckhand);
  const frame = deckFrame(page);
  await frame.locator('h1').click({ button: 'right' });
  const pop = page.locator('.note-pop');
  await pop.locator('textarea').fill('Half a thought');
  await frame.locator('p').first().click();
  await page.locator('.sidebar .sb-head').click();
  await expect(pop).toBeVisible();
  await expect(pop.locator('textarea')).toHaveValue('Half a thought');
  await pop.getByRole('button', { name: 'Cancel' }).click();
  await expect(pop).toHaveCount(0);

  await frame.locator('h1').click({ button: 'right' });
  await expect(pop).toBeVisible();
  await frame.locator('p').first().click();
  await expect(pop).toHaveCount(0);
});

test('AC-42 notes edit inline from the sidebar and the pin, and delete cleanly', async ({ page, deckhand }) => {
  await openEditor(page, deckhand);
  await addNote(page, deckFrame(page).locator('h1'), 'First idea');
  await expect.poll(async () => (await json(deckhand)).notes.length).toBe(1);

  const card = page.locator('.note-item');
  await card.getByRole('button', { name: 'Edit' }).click();
  const area = card.locator('textarea');
  await expect(area).toBeFocused();
  await area.fill('Second idea');
  await area.press('ControlOrMeta+Enter');
  await expect(card.locator('.n-text')).toHaveText('Second idea');
  await expect.poll(async () => (await json(deckhand)).notes[0].text).toBe('Second idea');

  await card.getByRole('button', { name: 'Edit' }).click();
  await card.locator('textarea').fill('Throw this away');
  await card.locator('textarea').press('Escape');
  await expect(card.locator('.n-text')).toHaveText('Second idea');

  await page.locator('.pin').click();
  const pop = page.locator('.note-pop');
  await pop.locator('textarea').fill('Third idea');
  await pop.getByRole('button', { name: 'Save' }).click();
  await expect(card.locator('.n-text')).toHaveText('Third idea');
  await expect.poll(async () => (await json(deckhand)).notes[0].text).toBe('Third idea');

  await card.getByRole('button', { name: 'Delete' }).click();
  await expect(page.locator('.note-item')).toHaveCount(0);
  await expect(page.locator('.pin')).toHaveCount(0);
  await expect.poll(async () => (await json(deckhand)).notes.length).toBe(0);
  await expect(page.locator('.notes-empty')).toHaveText('No notes yet. Right-click anything on a slide to tell the AI what to change.');
});

test.describe('server restart', () => {
  test.use({ allowedConsoleErrors: [/WebSocket connection to .* failed/] });

  test('AC-43 notes and pins survive a refresh and a server restart', async ({ page, deckhand }) => {
    await openEditor(page, deckhand);
    await addNote(page, deckFrame(page).locator('h1'), 'Keep me');
    await expect.poll(async () => (await json(deckhand)).notes.length).toBe(1);

    await page.reload();
    await expect(page.locator('body[data-ready]')).toBeAttached();
    await expect(page.locator('.note-item')).toContainText('Keep me');
    await expect(page.locator('.pin')).toHaveCount(1);

    await deckhand.restart();
    await page.reload();
    await expect(page.locator('body[data-ready]')).toBeAttached();
    await expect(page.locator('.note-item')).toContainText('Keep me');
    await expect(page.locator('.pin')).toHaveCount(1);
  });
});

test('the note popover names its target in plain words', async ({ page, deckhand }) => {
  await openEditor(page, deckhand);
  const frame = deckFrame(page);
  const pop = page.locator('.note-pop');
  const targetOf = async (locator, options) => {
    await locator.scrollIntoViewIfNeeded();
    await locator.click({ button: 'right', ...options });
    const text = await pop.locator('.note-pop-target').innerText();
    await page.keyboard.press('Escape');
    await expect(pop).toHaveCount(0);
    return text;
  };
  expect(await targetOf(frame.locator('h2', { hasText: 'Things to say' }))).toBe("On heading: 'Things to say'");
  expect(await targetOf(frame.locator('li', { hasText: 'First thing' }))).toBe("On list item: 'First thing'");
  expect(await targetOf(frame.locator('p', { hasText: 'The first slide.' }))).toBe("On paragraph: 'The first slide.'");
  expect(await targetOf(frame.locator('section').nth(2), { position: { x: 20, y: 400 } })).toBe('On slide 3');
});
