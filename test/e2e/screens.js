import path from 'node:path';
import { expect } from './fixtures.js';
import { makeDeck, openAsRecent, openHome, input, createBtn } from './home-helpers.js';
import { addNotes, postApi, openEditor as openRunsEditor } from './runs-helpers.js';

const SAMPLE = 'samples/sample-deck.html';

async function startCreate(page, deckhand, description) {
  makeDeck(path.join(deckhand.home, 'Talks'), 'last-year.html');
  await openHome(page, deckhand);
  await input(page).fill(description);
  await createBtn(page).click();
  await expect(page.locator('.generation')).toBeVisible();
}

async function editorWithNotes(page, deckhand, notes) {
  await addNotes(deckhand, notes);
  await openRunsEditor(page, deckhand);
}

async function finishRun(page, tone) {
  await page.locator('.runs-handoff').click();
  await expect(page.locator('.editor .activity-card')).toHaveClass(new RegExp(`tone-${tone}`), { timeout: 10_000 });
}

export const SCREENS = [
  {
    name: 'home',
    options: { agents: ['claude', 'codex'] },
    async go(page, deckhand) {
      await openAsRecent(deckhand, makeDeck(path.join(deckhand.home, 'Talks'), 'quarterly-review.html'));
      await openHome(page, deckhand);
    },
  },
  {
    name: 'home-no-agent',
    options: { agents: [] },
    go: openHome,
  },
  {
    name: 'home-continue',
    options: { agents: ['claude'], deck: SAMPLE },
    async go(page, deckhand) {
      await openHome(page, deckhand);
      await expect(page.locator('.home-continue')).toContainText('Continue editing sample-deck.html');
    },
  },
  {
    name: 'home-run-paused',
    options: { agents: ['claude'], deck: SAMPLE },
    async go(page, deckhand) {
      await addNotes(deckhand, [{ text: 'Take your time [[fake:hang]]', targetTag: 'h1', aiId: 'dh1', slide: 1 }]);
      await postApi(deckhand, '/api/runs', { kind: 'edit', scope: 'all' });
      await openHome(page, deckhand);
      await expect(page.locator('.home-running')).toContainText('is editing sample-deck.html');
      await expect(page.locator('.open-busy')).toBeVisible();
    },
  },
  {
    name: 'browse',
    options: { agents: ['claude'] },
    async go(page, deckhand) {
      makeDeck(path.join(deckhand.home, 'Talks'), 'team-offsite.html');
      await openHome(page, deckhand);
      await page.locator('.open-browse').click();
      await expect(page.locator('.dialog .browse-list')).toBeVisible();
      await page.waitForLoadState('networkidle');
    },
  },
  {
    name: 'generation',
    options: { agents: ['claude'] },
    async go(page, deckhand) {
      await startCreate(page, deckhand, 'A calm deck about tea for the team [[fake:long-run]]');
      await expect(page.locator('.generation .activity-card')).toContainText('Still working', { timeout: 5_000 });
    },
  },
  {
    name: 'generation-failed',
    options: { agents: ['claude'] },
    async go(page, deckhand) {
      await startCreate(page, deckhand, 'A calm deck about tea for the team [[fake:fail-mid-run]]');
      await expect(page.locator('.gen-failure')).toBeVisible({ timeout: 10_000 });
    },
  },
  {
    name: 'editor',
    options: { agents: ['claude'], deck: SAMPLE },
    go: (page, deckhand) => editorWithNotes(page, deckhand, [
      { text: 'Make the title warmer', targetTag: 'h1', aiId: 'dh1', slide: 1 },
      { text: 'All headings in a serif', targetTag: 'h2', aiId: 'dh4', slide: 2, scope: 'global' },
    ]),
  },
  {
    name: 'editor-run-done',
    options: { agents: ['claude'], deck: SAMPLE },
    async go(page, deckhand) {
      await editorWithNotes(page, deckhand, [{ text: 'Make the title warmer', targetTag: 'h1', aiId: 'dh1', slide: 1 }]);
      await finishRun(page, 'done');
    },
  },
  {
    name: 'editor-run-failed',
    options: { agents: ['claude'], deck: SAMPLE },
    async go(page, deckhand) {
      await editorWithNotes(page, deckhand, [{ text: 'Make the title warmer [[fake:fail]]', targetTag: 'h1', aiId: 'dh1', slide: 1 }]);
      await finishRun(page, 'error');
    },
  },
];

export const screen = (name) => SCREENS.find((s) => s.name === name);

export async function settle(page) {
  await page.evaluate(() => Promise.all(document.getAnimations()
    .filter((a) => a.effect?.getComputedTiming().endTime !== Infinity)
    .map((a) => a.finished.catch(() => {}))));
}

// The functions below run inside the page.

export function horizontalOverflow() {
  const doc = document.documentElement;
  return { scrollWidth: doc.scrollWidth, clientWidth: doc.clientWidth };
}

export function overlaps() {
  const describe = (el) => {
    const cls = typeof el.className === 'string' && el.className.trim() ? `.${el.className.trim().split(/\s+/).join('.')}` : '';
    const text = (el.innerText || el.value || el.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' ').slice(0, 30);
    return `${el.tagName.toLowerCase()}${cls}${text ? ` "${text}"` : ''}`;
  };
  const visibleRect = (el) => {
    const cs = getComputedStyle(el);
    if (cs.visibility !== 'visible' || Number(cs.opacity) === 0 || el.closest('[hidden], [inert]')) return null;
    let r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return null;
    let box = { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
    for (let a = el.parentElement; a; a = a.parentElement) {
      const o = getComputedStyle(a);
      if (o.overflowX === 'visible' && o.overflowY === 'visible') continue;
      r = a.getBoundingClientRect();
      box = { left: Math.max(box.left, r.left), top: Math.max(box.top, r.top), right: Math.min(box.right, r.right), bottom: Math.min(box.bottom, r.bottom) };
      if (box.right - box.left < 1 || box.bottom - box.top < 1) return null;
    }
    return box;
  };
  const layer = (el) => el.closest('.dialog, .toast, .toasts, .popover, .menu, .editor-pill, .editor-veil, .dock') || document.body;
  const sel = 'button, a[href], input, textarea, select, h1, h2, h3, p, label, .chip';
  const items = [...document.querySelectorAll(sel)].map((el) => ({ el, box: visibleRect(el), layer: layer(el) })).filter((i) => i.box);
  const found = [];
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const a = items[i];
      const b = items[j];
      if (a.layer !== b.layer || a.el.contains(b.el) || b.el.contains(a.el)) continue;
      const w = Math.min(a.box.right, b.box.right) - Math.max(a.box.left, b.box.left);
      const h = Math.min(a.box.bottom, b.box.bottom) - Math.max(a.box.top, b.box.top);
      if (w > 1 && h > 1) found.push(`${describe(a.el)} overlaps ${describe(b.el)} by ${Math.round(w)}x${Math.round(h)}px`);
    }
  }
  return found;
}

export function contrastFailures() {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 1;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const rgba = (css) => {
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = '#000';
    ctx.fillStyle = css;
    ctx.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
    return { r, g, b, a: a / 255 };
  };
  const over = (top, bottom) => ({
    r: top.r * top.a + bottom.r * (1 - top.a),
    g: top.g * top.a + bottom.g * (1 - top.a),
    b: top.b * top.a + bottom.b * (1 - top.a),
    a: 1,
  });
  const lum = ({ r, g, b }) => {
    const ch = (v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
  };
  const ratio = (x, y) => { const [a, b] = [lum(x), lum(y)].sort((p, q) => q - p); return (a + 0.05) / (b + 0.05); };
  const background = (el) => {
    const layers = [];
    for (let a = el; a; a = a.parentElement) {
      const cs = getComputedStyle(a);
      if (cs.backgroundImage !== 'none') return null;
      const c = rgba(cs.backgroundColor);
      if (c.a > 0) layers.push(c);
      if (c.a >= 1) break;
    }
    let bg = { r: 255, g: 255, b: 255, a: 1 };
    for (const c of layers.reverse()) bg = over(c, bg);
    return bg;
  };
  const opacity = (el) => { let o = 1; for (let a = el; a; a = a.parentElement) o *= Number(getComputedStyle(a).opacity); return o; };
  const failures = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const seen = new Set();
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const el = n.parentElement;
    if (!n.textContent.trim() || seen.has(el)) continue;
    seen.add(el);
    if (el.closest('[hidden], [inert], :disabled, [aria-disabled="true"], script, style, noscript, iframe')) continue;
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    if (cs.visibility !== 'visible' || r.width < 1 || r.height < 1 || opacity(el) === 0) continue;
    const bg = background(el);
    if (!bg) continue;
    const fg = rgba(cs.color);
    fg.a *= opacity(el);
    const size = parseFloat(cs.fontSize);
    const large = size >= 24 || (size >= 18.66 && Number(cs.fontWeight) >= 700);
    const need = large ? 3 : 4.5;
    const got = ratio(over(fg, bg), bg);
    if (got < need) {
      const cls = typeof el.className === 'string' && el.className.trim() ? `.${el.className.trim().split(/\s+/).join('.')}` : '';
      failures.push(`${el.tagName.toLowerCase()}${cls} "${n.textContent.trim().slice(0, 30)}": ${got.toFixed(2)} < ${need} (${cs.color} on rgb(${Math.round(bg.r)}, ${Math.round(bg.g)}, ${Math.round(bg.b)}))`);
    }
  }
  return failures;
}

export function motion() {
  const seconds = (v) => v.split(',').map((s) => (s.trim().endsWith('ms') ? parseFloat(s) / 1000 : parseFloat(s)));
  const moving = [];
  for (const el of document.querySelectorAll('*')) {
    for (const pseudo of [null, '::before', '::after']) {
      const cs = getComputedStyle(el, pseudo);
      const t = seconds(cs.transitionDuration).some((s) => s > 0);
      const a = cs.animationName !== 'none' && seconds(cs.animationDuration).some((s) => s > 0);
      if (t || a) {
        const cls = typeof el.className === 'string' && el.className.trim() ? `.${el.className.trim().split(/\s+/).join('.')}` : '';
        moving.push(`${el.tagName.toLowerCase()}${cls}${pseudo || ''}: transition ${cs.transitionDuration}, animation ${cs.animationName} ${cs.animationDuration}`);
      }
    }
  }
  const running = document.getAnimations().filter((x) => x.playState === 'running').length;
  return { moving, running };
}

export function tabTargets(scopeSelector) {
  const scope = scopeSelector ? document.querySelector(scopeSelector) : document;
  const sel = 'a[href], button, input, textarea, select, [tabindex]:not([tabindex="-1"])';
  const list = [...scope.querySelectorAll(sel)].filter((el) => {
    if (el.disabled || el.closest('[hidden], [inert]') || el.getAttribute('tabindex') === '-1') return false;
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return cs.visibility === 'visible' && cs.display !== 'none' && r.width > 0 && r.height > 0;
  });
  list.forEach((el, i) => {
    const cs = getComputedStyle(el);
    el.setAttribute('data-tab-probe', String(i));
    el.dataset.tabBase = JSON.stringify([cs.outlineStyle, cs.outlineWidth, cs.outlineColor, cs.boxShadow]);
  });
  return list.length;
}

export function focusState() {
  const el = document.activeElement;
  if (!el || el === document.body) return null;
  const cs = getComputedStyle(el);
  const [baseStyle, baseWidth, baseColour, baseShadow] = JSON.parse(el.dataset.tabBase || '[]');
  const outline = cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0
    && (cs.outlineStyle !== baseStyle || cs.outlineWidth !== baseWidth || cs.outlineColor !== baseColour);
  const ring = cs.boxShadow !== 'none' && cs.boxShadow !== baseShadow;
  const cls = typeof el.className === 'string' && el.className.trim() ? `.${el.className.trim().split(/\s+/).join('.')}` : '';
  return { probe: el.getAttribute('data-tab-probe'), visible: outline || ring, what: `${el.tagName.toLowerCase()}${cls}` };
}
