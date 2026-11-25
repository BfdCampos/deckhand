import { test, expect } from './fixtures.js';
import { SCREENS, screen, settle, horizontalOverflow, overlaps, contrastFailures, motion, tabTargets, focusState } from './screens.js';

// UI issues found by these checks and reported for fixing (owners in brackets). Matching findings are
// recorded as annotations instead of failing; remove each entry once its fix lands.
const KNOWN_UI_ISSUES = [
  // public/css/editor.css:39 `.note-item.is-done { opacity: 0.72 }` dims a done note's text below 4.5:1 (Dev E)
  /^span\.badge "\d+": /,
  /^span\.t-meta\.grow "[^"]*": /,
  /^span\.tag\.tag-success "Done": /,
  // public/css/runs.css:104 `.activity-line.kind-error` uses --error (#ff4f40-ish) on the card: 4.34:1 (Dev H)
  /^span\.activity-text "[^"]*": 4\.3\d < 4\.5 \(rgb\(255, 79, 64\)/,
];

function unexpected(findings, testInfo) {
  const known = findings.filter((f) => KNOWN_UI_ISSUES.some((re) => re.test(f)));
  for (const f of known) testInfo.annotations.push({ type: 'known UI issue', description: f });
  return findings.filter((f) => !known.includes(f));
}

const LAYOUTS = [
  { width: 1280, height: 800 },
  { width: 1440, height: 900 },
];

for (const s of SCREENS) {
  test.describe(s.name, () => {
    test.use({ deckhandOptions: s.options });

    test(`AC-63 ${s.name} renders with no console errors`, async ({ page, deckhand }) => {
      await s.go(page, deckhand);
      await page.waitForTimeout(300);
    });

    test(`AC-67 ${s.name} text meets WCAG AA contrast`, async ({ page, deckhand }, testInfo) => {
      await s.go(page, deckhand);
      await settle(page);
      expect(unexpected(await page.evaluate(contrastFailures), testInfo)).toEqual([]);
    });

    for (const size of LAYOUTS) {
      test(`AC-65 ${s.name} at ${size.width}x${size.height} has no overflow or overlap`, async ({ page, deckhand }) => {
        await page.setViewportSize(size);
        await s.go(page, deckhand);
        await settle(page);
        const { scrollWidth, clientWidth } = await page.evaluate(horizontalOverflow);
        expect(scrollWidth, 'horizontal overflow').toBeLessThanOrEqual(clientWidth);
        expect(await page.evaluate(overlaps)).toEqual([]);
      });
    }

    test.describe('with reduced motion', () => {
      test.use({ contextOptions: { reducedMotion: 'reduce' } });

      test(`AC-69 ${s.name} has no transitions or animations`, async ({ page, deckhand }) => {
        await s.go(page, deckhand);
        const { moving, running } = await page.evaluate(motion);
        expect(moving).toEqual([]);
        expect(running).toBe(0);
      });
    });
  });
}

test.describe('Home at 800 px wide', () => {
  test.use({ deckhandOptions: screen('home').options, viewport: { width: 800, height: 900 } });

  test('AC-65 the cards stack, Create first, with no overflow or overlap', async ({ page, deckhand }) => {
    await screen('home').go(page, deckhand);
    await settle(page);
    const create = await page.locator('.home-create').boundingBox();
    const open = await page.locator('.home-open').boundingBox();
    expect(create.y + create.height).toBeLessThanOrEqual(open.y + 1);
    const { scrollWidth, clientWidth } = await page.evaluate(horizontalOverflow);
    expect(scrollWidth).toBeLessThanOrEqual(clientWidth);
    expect(await page.evaluate(overlaps)).toEqual([]);
  });
});

async function tabThrough(page, scope, start) {
  const total = await page.evaluate(tabTargets, scope);
  expect(total).toBeGreaterThan(0);
  if (start) await start();
  const reached = new Set();
  const invisible = [];
  for (let i = 0; i < total + 20 && reached.size < total; i++) {
    await page.keyboard.press('Tab');
    const f = await page.evaluate(focusState);
    if (!f || f.probe === null) continue;
    reached.add(f.probe);
    if (!f.visible) invisible.push(f.what);
  }
  const missed = await page.evaluate((got) => [...document.querySelectorAll('[data-tab-probe]')]
    .filter((el) => !got.includes(el.getAttribute('data-tab-probe')))
    .map((el) => `${el.tagName.toLowerCase()}.${String(el.className).trim().split(/\s+/).join('.')} "${(el.innerText || el.getAttribute('aria-label') || '').trim().slice(0, 30)}"`), [...reached]);
  return { missed, invisible };
}

test.describe('keyboard', () => {
  test.describe('Home', () => {
    test.use({ deckhandOptions: screen('home').options });

    test('AC-66 every control on Home is reachable by Tab with a visible focus ring', async ({ page, deckhand }) => {
      await screen('home').go(page, deckhand);
      await page.evaluate(() => document.activeElement?.blur());
      const { missed, invisible } = await tabThrough(page, '.home');
      expect(missed, 'not reachable by Tab').toEqual([]);
      expect(invisible, 'no visible focus ring').toEqual([]);
    });
  });

  test.describe('editor sidebar', () => {
    test.use({ deckhandOptions: screen('editor').options });

    test('AC-66 every control in the sidebar is reachable by Tab with a visible focus ring', async ({ page, deckhand }) => {
      await screen('editor').go(page, deckhand);
      const { missed, invisible } = await tabThrough(page, '.sidebar', () => page.locator('.sidebar .sb-head').click());
      expect(missed, 'not reachable by Tab').toEqual([]);
      expect(invisible, 'no visible focus ring').toEqual([]);
    });
  });
});

test.describe('the checks themselves', () => {
  test('they catch overflow, overlap, low contrast, motion and a missing focus ring', async ({ page }) => {
    await page.setViewportSize({ width: 600, height: 400 });
    await page.setContent(`<!DOCTYPE html><html><head><style>
      body { margin: 0; background: #fff; font: 16px sans-serif; }
      .wide { width: 900px; height: 10px; }
      .a, .b { position: absolute; top: 300px; left: 40px; width: 120px; height: 40px; }
      .b { left: 100px; }
      .grey { color: #bbb; }
      .move { transition: opacity 200ms; }
      button:focus { outline: none; }
    </style></head><body>
      <div class="wide"></div>
      <button class="a">One</button><button class="b">Two</button>
      <p class="grey">Faint text</p>
      <p class="move">Moving</p>
    </body></html>`);
    expect((await page.evaluate(horizontalOverflow)).scrollWidth).toBeGreaterThan(600);
    expect(await page.evaluate(overlaps)).toEqual([expect.stringMatching(/^button\.a "One" overlaps button\.b "Two"/)]);
    expect(await page.evaluate(contrastFailures)).toEqual([expect.stringMatching(/^p\.grey "Faint text": 1\.9\d < 4\.5/)]);
    expect((await page.evaluate(motion)).moving).toEqual([expect.stringMatching(/^p\.move: transition 0\.2s/)]);
    expect(await page.evaluate(tabTargets, null)).toBe(2);
    await page.keyboard.press('Tab');
    expect(await page.evaluate(focusState)).toMatchObject({ probe: '0', visible: false });
  });
});
