import fs from 'node:fs/promises';
import path from 'node:path';
import { test, expect } from './fixtures.js';
import {
  deckFrame, readDisk, stripAnchors, sidecar, openEditor, openDeckAt, frameGen, diskEventually, blurEditing,
  dragBy, caretToEnd, writeDeck, png, REPO,
} from './editor-helpers.js';

const BASIC = 'test/fixtures/decks/basic.html';
test.use({ deckhandOptions: { deck: BASIC } });

async function allowClipboard(page, deckhand) {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: deckhand.url });
}

async function clipboardHtml(page, html, text) {
  await page.evaluate(async ({ html, text }) => {
    await navigator.clipboard.write([new ClipboardItem({
      'text/html': new Blob([html], { type: 'text/html' }),
      'text/plain': new Blob([text], { type: 'text/plain' }),
    })]);
  }, { html, text });
}

async function clipboardImage(page, buffer) {
  await page.evaluate(async (b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': new Blob([bytes], { type: 'image/png' }) })]);
  }, buffer.toString('base64'));
}

async function editAppend(page, locator, text) {
  await locator.scrollIntoViewIfNeeded();
  await locator.dblclick();
  await expect(locator).toHaveAttribute('contenteditable', 'true');
  await caretToEnd(locator);
  await page.keyboard.type(text);
  await blurEditing(page);
}

test.describe('B1 failed saves', () => {
  test.use({ allowedConsoleErrors: [/status of 500/] });

  test('keep every typed edit, never claim Saved, and retry them all in order', async ({ page, deckhand }) => {
    const dir = path.dirname(deckhand.deckPath);
    const gen = await openEditor(page, deckhand);
    const frame = deckFrame(page);
    const p = frame.locator('section').first().locator('p');
    const h1 = frame.locator('h1');
    try {
      await fs.chmod(dir, 0o555);
      await editAppend(page, p, ' first-typed');
      await expect(page.locator('.save-status')).toContainText("Couldn't save");
      await editAppend(page, p, ' second-typed');
      await editAppend(page, h1, ' third');
      await page.waitForTimeout(500);
      await expect(page.locator('.save-status')).toContainText("Couldn't save");
      await expect(p).toHaveText('The first slide. first-typed second-typed');
      await expect(h1).toHaveText('Basic deck third');
      expect(await frameGen(page)).toBe(gen);
    } finally {
      await fs.chmod(dir, 0o755);
    }
    await page.locator('.save-status').getByRole('button', { name: 'Retry' }).click();
    await expect(page.locator('.save-status')).toHaveText('Saved');
    await diskEventually(deckhand.deckPath, (s) => s.includes('The first slide. first-typed second-typed</p>') && s.includes('>Basic deck third</h1>'));
  });
});

test('B2 Enter ends the edit and Shift+Enter adds a line break', async ({ page, deckhand }) => {
  await openEditor(page, deckhand);
  const p = deckFrame(page).locator('section').first().locator('p');
  await p.dblclick();
  await caretToEnd(p);
  await page.keyboard.type(' one');
  await page.keyboard.press('Shift+Enter');
  await page.keyboard.type('two');
  await page.keyboard.press('Enter');
  await expect(p).not.toHaveAttribute('contenteditable', 'true');
  await diskEventually(deckhand.deckPath, (s) => /<p data-ai-id="dh\d+">The first slide\. one<br>two<\/p>/.test(s));

  const h1 = deckFrame(page).locator('h1');
  await h1.dblclick();
  await caretToEnd(h1);
  await page.keyboard.type('!');
  await page.keyboard.press('Enter');
  await expect(h1).not.toHaveAttribute('contenteditable', 'true');
  await diskEventually(deckhand.deckPath, (s) => s.includes('>Basic deck!</h1>'));
  expect(await readDisk(deckhand.deckPath)).not.toContain('<div>');
});

test('B2 M4 pasting rich content while editing inserts plain text with line breaks', async ({ page, deckhand }) => {
  await openEditor(page, deckhand);
  await allowClipboard(page, deckhand);
  await clipboardHtml(page,
    '<!--StartFragment--><span style="color: rgb(32, 33, 36)"><b>Mushy</b> peas</span><h2>Big</h2><p>para &amp; more</p><img src="https://example.invalid/x.png"><!--EndFragment-->',
    'Mushy peas\nBig\npara & more');
  const p = deckFrame(page).locator('section').first().locator('p');
  await p.dblclick();
  await caretToEnd(p);
  await page.keyboard.press('ControlOrMeta+v');
  await blurEditing(page);
  await diskEventually(deckhand.deckPath, (s) => s.includes('The first slide.Mushy peas<br>Big<br>para &amp; more</p>'));
  const saved = await readDisk(deckhand.deckPath);
  for (const leak of ['<span', '<b>', 'StartFragment', 'example.invalid', '<h2>Big']) expect(saved).not.toContain(leak);
});

test('M4 an image pasted while editing text is uploaded and placed beside it, not inside', async ({ page, deckhand }) => {
  await openEditor(page, deckhand);
  await allowClipboard(page, deckhand);
  await clipboardImage(page, png(24, 12));
  const p = deckFrame(page).locator('section').first().locator('p');
  await p.dblclick();
  await caretToEnd(p);
  await page.keyboard.press('ControlOrMeta+v');
  await expect(deckFrame(page).locator('section').first().locator('img')).toBeVisible();
  await expect(p.locator('img')).toHaveCount(0);
  await blurEditing(page);
  await diskEventually(deckhand.deckPath, (s) => /<img data-ai-id="dh\d+" src="deckhand-assets\//.test(s));
  expect(await readDisk(deckhand.deckPath)).not.toContain('data:image');
});

test('M5 Cmd+V of an image after clicking a slide element inserts it', async ({ page, deckhand }) => {
  await openEditor(page, deckhand);
  await allowClipboard(page, deckhand);
  await clipboardImage(page, png(24, 12));
  await deckFrame(page).locator('h1').click();
  await page.keyboard.press('ControlOrMeta+v');
  await expect(deckFrame(page).locator('img')).toBeVisible();
  await diskEventually(deckhand.deckPath, (s) => /<img data-ai-id="dh\d+" src="deckhand-assets\//.test(s));
});

test.describe('M3 moves keep the element\'s own transform', () => {
  test.use({ deckhandOptions: {} });
  const DECK = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>T</title><style>
  body { margin: 0 } .slide { position: relative; height: 100vh }
  h3.centre { position: absolute; left: 50%; top: 40%; transform: translateX(-50%); margin: 0 }
</style></head><body><section class="slide">
  <p id="tilted" style="transform: rotate(5deg); width: 300px">Tilted words</p>
  <h3 class="centre">Centred title</h3>
</section></body></html>
`;

  test('an inline rotate survives and a class translate does not jump', async ({ page, deckhand }) => {
    const file = await writeDeck(deckhand.home, 'transforms.html', DECK);
    await openDeckAt(page, deckhand, file);
    const frame = deckFrame(page);
    await dragBy(page, frame.locator('#tilted'), 40, 0);
    await diskEventually(file, (s) => /style="transform: rotate\(5deg\); width: 300px; translate: 40px 0px;"/.test(s));

    const h3 = frame.locator('h3.centre');
    const before = await h3.boundingBox();
    await dragBy(page, h3, 30, 0);
    const after = await h3.boundingBox();
    expect(Math.round(after.x - before.x)).toBe(30);
    await diskEventually(file, (s) => /<h3 data-ai-id="dh\d+" style="translate: 30px 0px;" class="centre">/.test(s));
    await diskEventually(sidecar(file, 'md'), (s) => /\(h3\): moved by \(30, 0\) px/.test(s) && /\(p\): moved by \(40, 0\) px/.test(s));
  });
});

test.describe('M2 restart mid-edit', () => {
  test.use({ deckhandOptions: {}, allowedConsoleErrors: [/WebSocket connection to .* failed|ERR_CONNECTION_REFUSED|Failed to load resource/] });

  test('keeps the typed text and saves it once Deckhand is back', async ({ page, deckhand }) => {
    const file = await writeDeck(deckhand.home, 'restart.html', await readDisk(path.join(REPO, BASIC)));
    await openDeckAt(page, deckhand, file);
    const h1 = deckFrame(page).locator('h1');
    await h1.dblclick();
    await caretToEnd(h1);
    await page.keyboard.type(' typed before the restart');
    await deckhand.stop();
    await expect(page.locator('.banner', { hasText: 'Lost connection to Deckhand. Trying again…' })).toBeVisible();
    await blurEditing(page);
    await expect(h1).toHaveText('Basic deck typed before the restart');

    await deckhand.restart();
    await diskEventually(file, (s) => s.includes('>Basic deck typed before the restart</h1>'), 15_000);
    await expect(page.locator('.save-status')).toHaveText('Saved');
    await expect(page.locator('.banner')).toHaveCount(0);
    await expect(page.locator('.banner', { hasText: 'closed in another tab' })).toHaveCount(0);
    await expect(h1).toHaveText('Basic deck typed before the restart');
  });
});

test('m3 clearing a heading saves it empty, not a lone <br>', async ({ page, deckhand }) => {
  await openEditor(page, deckhand);
  const h2 = deckFrame(page).locator('h2', { hasText: 'Things to say' });
  await h2.scrollIntoViewIfNeeded();
  await h2.dblclick();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.press('Backspace');
  await blurEditing(page);
  await diskEventually(deckhand.deckPath, (s) => /<h2 data-ai-id="dh\d+"><\/h2>/.test(s));
});

test('m5 Backspace with a sidebar control focused never deletes the slide selection', async ({ page, deckhand }) => {
  await openEditor(page, deckhand);
  const li = deckFrame(page).locator('li', { hasText: 'First thing' });
  await li.scrollIntoViewIfNeeded();
  await li.click();
  await page.getByRole('button', { name: 'Text', exact: true }).focus();
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Delete');
  await page.waitForTimeout(300);
  await expect(li).toHaveCount(1);
  expect(stripAnchors(await readDisk(deckhand.deckPath))).toContain('First thing');
});

test('m4 a note deleted in another tab while you edit it keeps your text and can be saved back', async ({ page, deckhand }) => {
  await openEditor(page, deckhand);
  const h1 = deckFrame(page).locator('h1');
  await h1.click({ button: 'right' });
  await page.locator('.note-pop textarea').fill('Original note');
  await page.locator('.note-pop textarea').press('ControlOrMeta+Enter');
  await expect(page.locator('.note-item')).toHaveCount(1);

  const other = await page.context().newPage();
  await openEditor(other, deckhand);
  await expect(other.locator('.note-item')).toHaveCount(1);

  await page.locator('.note-item').getByRole('button', { name: 'Edit' }).click();
  await page.locator('.note-item textarea').fill('My better wording');
  await other.locator('.note-item').getByRole('button', { name: 'Delete' }).click();

  const card = page.locator('.note-item');
  await expect(card).toContainText('This note was deleted in another tab.');
  await expect(card.locator('textarea')).toHaveValue('My better wording');
  await card.getByRole('button', { name: 'Save' }).click();
  await expect(page.locator('.note-item .n-text')).toHaveText('My better wording');
  await expect(other.locator('.note-item .n-text')).toHaveText('My better wording');
  await other.close();
});

test('m4 an inline edit warns when another tab changed the note first', async ({ page, deckhand }) => {
  await openEditor(page, deckhand);
  await deckFrame(page).locator('h1').click({ button: 'right' });
  await page.locator('.note-pop textarea').fill('Version one');
  await page.locator('.note-pop textarea').press('ControlOrMeta+Enter');
  const other = await page.context().newPage();
  await openEditor(other, deckhand);

  await page.locator('.note-item').getByRole('button', { name: 'Edit' }).click();
  await other.locator('.note-item').getByRole('button', { name: 'Edit' }).click();
  await other.locator('.note-item textarea').fill('Version from tab two');
  await other.locator('.note-item textarea').press('ControlOrMeta+Enter');

  const card = page.locator('.note-item');
  await expect(card).toContainText('This note was changed in another tab.');
  await expect(card.locator('textarea')).toHaveValue('Version one');
  await other.close();
});

test.fixme('M1 an external write to another element during a text edit does not discard the edit', async ({ page, deckhand }) => {
  await openEditor(page, deckhand);
  const p = deckFrame(page).locator('section').first().locator('p');
  await p.dblclick();
  await caretToEnd(p);
  await page.keyboard.type(' still mine');
  await fs.writeFile(deckhand.deckPath, (await readDisk(deckhand.deckPath)).replace('Thanks for watching.', 'Thanks for reading.'));
  await page.waitForTimeout(800);
  await blurEditing(page);
  await diskEventually(deckhand.deckPath, (s) => s.includes('The first slide. still mine</p>') && s.includes('Thanks for reading.'));
  await expect(p).toHaveText('The first slide. still mine');
});
