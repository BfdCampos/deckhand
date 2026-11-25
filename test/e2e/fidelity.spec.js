import { test, expect } from './fixtures.js';
import { deckFrame, readDisk, stripAnchors, openDeckAt, openEditor, diskEventually, blurEditing, dragBy, writeDeck } from './editor-helpers.js';

const AWKWARD = `<!doctype html>
<HTML lang=en>
<head>
<meta charset=utf-8>
<title>Awkward   deck</title>
<style>
  body { margin:0 } .slide { min-height: 100vh; padding: 40px }
</style>
</head>
<BODY>
<!-- a comment the browser keeps but never shows -->
<section class=slide>
  <H2 CLASS="title"   >Quarterly   review</H2>
  <P class=lead>Revenue grew &amp; costs fell<br/>in Q3 &mdash; mostly.
  <p>Implied end tag before this one
  <ul><li>One<li>Two</ul>
  <p style="color:#FFF;margin:0">Styled text</p>
</section>
<section class="slide"><h2>Second</h2><p id="runtime-target">Untouched</p></section>
<script>
  document.body.classList.add('js-ready');
  const d = document.createElement('div');
  d.className = 'runtime-only';
  d.textContent = 'Injected at runtime';
  document.querySelector('section').appendChild(d);
  document.getElementById('runtime-target').setAttribute('data-touched', 'yes');
</script>
</BODY>
</HTML>
`;

test.use({ deckhandOptions: {} });

test('AC-27 editing one word saves only that word plus anchors', async ({ page, deckhand }) => {
  const file = await writeDeck(deckhand.home, 'awkward.html', AWKWARD);
  await openDeckAt(page, deckhand, file);
  const frame = deckFrame(page);
  await expect(frame.locator('.runtime-only')).toHaveText('Injected at runtime');

  const heading = frame.locator('h2.title');
  await heading.dblclick();
  await heading.evaluate((el) => {
    const doc = el.ownerDocument;
    const text = el.firstChild;
    const range = doc.createRange();
    range.setStart(text, text.data.indexOf('review'));
    range.setEnd(text, text.data.indexOf('review') + 'review'.length);
    doc.getSelection().removeAllRanges();
    doc.getSelection().addRange(range);
  });
  await page.keyboard.type('summary');
  await blurEditing(page);

  await diskEventually(file, (s) => s.includes('Quarterly   summary'));
  const saved = await readDisk(file);
  expect(stripAnchors(saved)).toBe(AWKWARD.replace('Quarterly   review', 'Quarterly   summary'));
  for (const leak of ['js-ready', 'runtime-only', 'Injected at runtime', 'data-touched', 'contenteditable', 'dh-style', 'data-dh-']) {
    expect(saved).not.toContain(leak);
  }
});

test('AC-27 moving an element keeps its other style declarations byte for byte', async ({ page, deckhand }) => {
  const file = await writeDeck(deckhand.home, 'awkward.html', AWKWARD);
  await openDeckAt(page, deckhand, file);
  const styled = deckFrame(page).locator('p', { hasText: 'Styled text' });
  await dragBy(page, styled, 40, 0);
  await diskEventually(file, (s) => /style="color:#FFF;margin:0; transform: translate\(40px, 0px\);"/.test(s));
  expect(stripAnchors(await readDisk(file)).replace('; transform: translate(40px, 0px);', '')).toBe(AWKWARD);
});

test.describe('script-owned text', () => {
  test.use({ deckhandOptions: { deck: 'test/fixtures/decks/scripted.html' } });

  test('editing text the deck script sets is refused with a toast and rolled back', async ({ page, deckhand }) => {
    const before = await readDisk(deckhand.deckPath);
    await openEditor(page, deckhand);
    const clock = deckFrame(page).locator('#clock');
    await expect(clock).toHaveText('Set by script');
    await clock.dblclick();
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.type('Mine now');
    await blurEditing(page);
    await expect(page.locator('.toast')).toContainText("This text is set by the deck's own script, so Deckhand can't save it. Leave a note instead.");
    await expect(clock).toHaveText('Set by script');
    expect(await readDisk(deckhand.deckPath)).toBe(before);
  });
});
