import fs from 'node:fs/promises';
import path from 'node:path';
import { test, expect } from './fixtures.js';
import {
  deckFrame, readDisk, stripAnchors, sidecar, openEditor, openDeckAt, waitForReload, frameGen,
  expectSaved, diskEventually, blurEditing, dragBy, addImage, writeDeck, REPO, caretToEnd,
} from './editor-helpers.js';

const BASIC = 'test/fixtures/decks/basic.html';

test.use({ deckhandOptions: { deck: BASIC } });

test.describe('manual edits', () => {
  let original;
  test.beforeEach(async ({ deckhand }) => { original = await readDisk(deckhand.deckPath); });

  test('AC-26 editing a heading writes the new text and shows Saved', async ({ page, deckhand }) => {
    await openEditor(page, deckhand);
    const h1 = deckFrame(page).locator('h1');
    await h1.dblclick();
    await expect(h1).toHaveAttribute('contenteditable', 'true');
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.type('Hello world');
    await blurEditing(page);
    await diskEventually(deckhand.deckPath, (s) => /<h1 data-ai-id="dh\d+">Hello world<\/h1>/.test(s), 1_500);
    await expectSaved(page);
    expect(stripAnchors(await readDisk(deckhand.deckPath))).toBe(original.replace('<h1>Basic deck</h1>', '<h1>Hello world</h1>'));
  });

  test('AC-28 dragging moves the element and records a layout tweak', async ({ page, deckhand }) => {
    await openEditor(page, deckhand);
    const li = deckFrame(page).locator('li', { hasText: 'First thing' });
    await li.scrollIntoViewIfNeeded();
    await dragBy(page, li, 100, 0);
    await diskEventually(deckhand.deckPath, (s) => /<li data-ai-id="dh\d+" style="transform: translate\(100px, 0px\);">First thing/.test(s));
    await diskEventually(sidecar(deckhand.deckPath, 'md'), (s) => /\(li\): moved by \(100, 0\) px/.test(s));
    await expectSaved(page);
  });

  test('AC-29 "+ Text" adds selected New text on the slide in view', async ({ page, deckhand }) => {
    await openEditor(page, deckhand);
    await page.getByRole('button', { name: 'Text', exact: true }).click();
    const added = deckFrame(page).locator('[data-editable]');
    await expect(added).toHaveText('New text');
    await expect(added).toHaveAttribute('contenteditable', 'true');
    expect(await added.evaluate((el) => el.ownerDocument.getSelection().toString())).toBe('New text');
    expect(await added.evaluate((el) => el.closest('section') === el.ownerDocument.querySelector('section'))).toBe(true);
    await page.keyboard.type('Fresh words');
    await blurEditing(page);
    await diskEventually(deckhand.deckPath, (s) => /<div data-ai-id="dh\d+" data-editable="" style="[^"]*">Fresh words<\/div>\s*<\/section>/.test(s));
    await expectSaved(page);
  });

  test('AC-32 dragging an image corner resizes it with the aspect ratio kept', async ({ page, deckhand }) => {
    await openEditor(page, deckhand);
    await addImage(page, { width: 200, height: 100 });
    const img = deckFrame(page).locator('img');
    await expect(img).toBeVisible();
    await diskEventually(deckhand.deckPath, (s) => /<img data-ai-id="dh\d+" src="deckhand-assets\//.test(s));
    const before = await img.boundingBox();
    const handle = page.locator('.handle').nth(3);
    const hb = await handle.boundingBox();
    await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
    await page.mouse.down();
    await page.mouse.move(hb.x + 60, hb.y + 30, { steps: 6 });
    await page.mouse.up();
    const after = await img.boundingBox();
    expect(after.width).toBeGreaterThan(before.width + 40);
    expect(Math.abs(after.width / after.height - 2)).toBeLessThan(0.05);
    await diskEventually(deckhand.deckPath, (s) => /<img[^>]*style="[^"]*width: \d+px; height: \d+px;[^"]*"/.test(s));
    const m = /width: (\d+)px; height: (\d+)px/.exec(await readDisk(deckhand.deckPath));
    expect(Math.abs(Number(m[1]) / Number(m[2]) - 2)).toBeLessThan(0.05);
  });

  test('AC-33 Delete removes the selection, but not while editing text', async ({ page, deckhand }) => {
    await openEditor(page, deckhand);
    const frame = deckFrame(page);
    const p = frame.locator('section').first().locator('p');
    await p.dblclick();
    await caretToEnd(p);
    await page.keyboard.press('Backspace');
    await blurEditing(page);
    await diskEventually(deckhand.deckPath, (s) => s.includes('>The first slide</p>'));
    await expect(p).toHaveCount(1);

    const li = frame.locator('li', { hasText: 'Second thing' });
    await li.scrollIntoViewIfNeeded();
    await li.click();
    await page.keyboard.press('Delete');
    await expect(li).toHaveCount(0);
    await diskEventually(deckhand.deckPath, (s) => !s.includes('Second thing'));
    await expectSaved(page);
  });

  test('AC-34 undo and redo walk back through every kind of edit, on disk', async ({ page, deckhand }) => {
    await openEditor(page, deckhand);
    const frame = deckFrame(page);
    const disk = () => readDisk(deckhand.deckPath);

    await page.getByRole('button', { name: 'Text', exact: true }).click();
    await diskEventually(deckhand.deckPath, (s) => s.includes('>New text</div>'));
    await page.keyboard.type('Added words');
    await blurEditing(page);
    await diskEventually(deckhand.deckPath, (s) => s.includes('>Added words</div>'));

    await dragBy(page, frame.locator('h1'), 100, 0);
    await diskEventually(deckhand.deckPath, (s) => /<h1[^>]*transform: translate\(100px, 0px\)/.test(s));

    await addImage(page, { width: 200, height: 100 });
    await diskEventually(deckhand.deckPath, (s) => s.includes('<img'));
    const hb = await page.locator('.handle').nth(3).boundingBox();
    await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
    await page.mouse.down();
    await page.mouse.move(hb.x + 40, hb.y + 20, { steps: 4 });
    await page.mouse.up();
    await diskEventually(deckhand.deckPath, (s) => /<img[^>]*width: \d+px/.test(s));

    await frame.locator('p', { hasText: 'The first slide.' }).click();
    await page.keyboard.press('Delete');
    await diskEventually(deckhand.deckPath, (s) => !s.includes('The first slide.'));

    const undo = () => page.keyboard.press('ControlOrMeta+z');
    await undo();
    await diskEventually(deckhand.deckPath, (s) => s.includes('The first slide.'));
    await expect(frame.locator('p', { hasText: 'The first slide.' })).toHaveCount(1);
    await undo();
    await diskEventually(deckhand.deckPath, (s) => /<img/.test(s) && !/<img[^>]*width: \d+px/.test(s));
    await undo();
    await diskEventually(deckhand.deckPath, (s) => !s.includes('<img'));
    await undo();
    await diskEventually(deckhand.deckPath, (s) => !s.includes('translate(100px'));
    await undo();
    await diskEventually(deckhand.deckPath, (s) => s.includes('>New text</div>'));
    await expect(frame.locator('[data-editable]')).toHaveText('New text');
    await undo();
    await diskEventually(deckhand.deckPath, (s) => !s.includes('data-editable'));
    await expect(frame.locator('[data-editable]')).toHaveCount(0);
    expect(stripAnchors(await disk())).toBe(stripAnchors(original));

    await page.keyboard.press('ControlOrMeta+Shift+z');
    await diskEventually(deckhand.deckPath, (s) => s.includes('>New text</div>'));
    await expect(frame.locator('[data-editable]')).toHaveText('New text');
    await page.keyboard.press('ControlOrMeta+Shift+z');
    await diskEventually(deckhand.deckPath, (s) => s.includes('>Added words</div>'));
    await expectSaved(page);
  });

  test('AC-35 Escape closes a menu first, then ends editing, then clears the selection', async ({ page, deckhand }) => {
    await openEditor(page, deckhand);
    const h1 = deckFrame(page).locator('h1');
    await h1.click();
    await expect(page.locator('.sel-box')).toBeVisible();
    await page.locator('.implement-caret, .runs-caret').first().click();
    await expect(page.getByRole('menu')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('menu')).toHaveCount(0);
    await expect(page.locator('.sel-box')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('.sel-box')).toBeHidden();

    await h1.dblclick();
    await caretToEnd(h1);
    await page.keyboard.type(' again');
    await page.keyboard.press('Escape');
    await expect(h1).not.toHaveAttribute('contenteditable', 'true');
    await diskEventually(deckhand.deckPath, (s) => s.includes('>Basic deck again</h1>'));
  });
});

test.describe('reloads', () => {
  test.use({ allowedConsoleErrors: [/status of 409 \(Conflict\)/] });

  test('AC-36 an external change and a refresh both keep the slide in view', async ({ page, deckhand }) => {
    let gen = await openEditor(page, deckhand);
    await page.locator('.dock-tile').nth(1).click();
    const slideTop = () => deckFrame(page).locator('section').nth(1).evaluate((s) => Math.round(s.getBoundingClientRect().top));
    await expect.poll(slideTop).toBe(0);
    await expect(page).toHaveURL(/[?&]slide=2(&|$)/);

    await fs.appendFile(deckhand.deckPath, '\n<!-- external -->\n');
    await waitForReload(page, gen);
    await expect.poll(slideTop).toBe(0);

    gen = await frameGen(page);
    await page.reload();
    await expect(page.locator('body[data-ready]')).toBeAttached();
    await expect.poll(slideTop).toBe(0);
  });

  test('AC-37 an external write reloads with a toast, waiting for a text edit to finish', async ({ page, deckhand }) => {
    test.info().annotations.push({ type: 'note', description: 'the edit made during the external write is refused with 409 deck_changed' });
    let gen = await openEditor(page, deckhand);
    const text = (await readDisk(deckhand.deckPath)).replace('Thanks for watching.', 'Thanks for reading.');
    await fs.writeFile(deckhand.deckPath, text);
    await waitForReload(page, gen);
    await expect(page.locator('.toast')).toContainText('Updated from disk');
    await expect(deckFrame(page).locator('blockquote')).toHaveText('Thanks for reading.');

    gen = await frameGen(page);
    const h1 = deckFrame(page).locator('h1');
    await h1.dblclick();
    await page.keyboard.type('X');
    await fs.writeFile(deckhand.deckPath, (await readDisk(deckhand.deckPath)).replace('The first slide.', 'Changed outside.'));
    await page.waitForTimeout(1_200);
    expect(await frameGen(page)).toBe(gen);
    await expect(h1).toHaveAttribute('contenteditable', 'true');
    await blurEditing(page);
    await waitForReload(page, gen);
    await expect(deckFrame(page).locator('p').first()).toHaveText('Changed outside.');
  });

  test('AC-38 deleting the deck file shows the Can\'t find banner', async ({ page, deckhand }) => {
    await openEditor(page, deckhand);
    await fs.rm(deckhand.deckPath);
    const banner = page.locator('.banner', { hasText: "Can't find basic.html any more." });
    await expect(banner).toBeVisible();
    await banner.getByRole('button', { name: 'Back to Home' }).click();
    await expect(page.locator('.landing')).toBeVisible();
  });

  test('undo history clears on an external change, with a toast only if it had steps', async ({ page, deckhand }) => {
    const gen = await openEditor(page, deckhand);
    await deckFrame(page).locator('h1').dblclick();
    await page.keyboard.type('!');
    await blurEditing(page);
    await diskEventually(deckhand.deckPath, (s) => /<h1[^>]*>!?Basic deck!?<\/h1>/.test(s) && s.includes('!'));
    await page.waitForTimeout(400);
    await fs.appendFile(deckhand.deckPath, '\n<!-- external -->\n');
    await waitForReload(page, gen);
    await expect(page.locator('.toast', { hasText: 'Undo history cleared' })).toBeVisible();
  });
});

test.describe('deck states', () => {
  test.use({ deckhandOptions: {} });

  test('a read-only deck shows the banner and refuses edits', async ({ page, deckhand }) => {
    const file = await writeDeck(deckhand.home, 'locked.html', await readDisk(path.join(REPO, BASIC)));
    await fs.chmod(file, 0o444);
    await openDeckAt(page, deckhand, file);
    await expect(page.locator('.banner', { hasText: "This file is read-only. You can browse it and copy prompts, but edits won't save." })).toBeVisible();
    await deckFrame(page).locator('h1').dblclick();
    await expect(deckFrame(page).locator('h1')).not.toHaveAttribute('contenteditable', 'true');
    await expect(page.getByRole('button', { name: 'Text', exact: true })).toBeDisabled();
  });

  test('a deck with no slides says so and still edits', async ({ page, deckhand }) => {
    const file = await writeDeck(deckhand.home, 'page.html', '<!DOCTYPE html><html><head><title>Page</title></head><body><h1>Just a page</h1><p>No slides here.</p></body></html>');
    await openDeckAt(page, deckhand, file);
    await expect(page.locator('.banner', { hasText: 'No slides found. Editing as one page.' })).toBeVisible();
    await expect(page.locator('.dock')).toBeHidden();
    await deckFrame(page).locator('h1').dblclick();
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.type('Still editable');
    await blurEditing(page);
    await diskEventually(file, (s) => s.includes('>Still editable</h1>'));
  });
});
