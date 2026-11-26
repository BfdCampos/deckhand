import { test as base, expect } from './fixtures.js';

let kitBase;
const test = base.extend({
  kitServer: [async ({ deckhand }, use) => {
    kitBase = deckhand.url;
    await use(deckhand.url);
  }, { auto: true }],
});

async function openKit(page) {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(`${kitBase}/test-kit.html`);
  await page.waitForFunction(() => window.kitReady === true);
  return errors;
}

test.describe('escape stack', () => {
  test('latest handler wins and falls through when it declines', async ({ page }) => {
    await openKit(page);
    await page.evaluate(() => {
      window.calls = [];
      const { pushEscape } = window.kit;
      window.popA = pushEscape(() => { window.calls.push('A'); return true; });
      window.popB = pushEscape(() => { window.calls.push('B'); return false; });
      window.popC = pushEscape(() => { window.calls.push('C'); return true; });
    });
    await page.keyboard.press('Escape');
    expect(await page.evaluate(() => window.calls)).toEqual(['C']);

    await page.evaluate(() => { window.calls = []; window.popC(); });
    await page.keyboard.press('Escape');
    expect(await page.evaluate(() => window.calls)).toEqual(['B', 'A']);

    await page.evaluate(() => { window.calls = []; window.popB(); window.popB(); window.popA(); });
    await page.keyboard.press('Escape');
    expect(await page.evaluate(() => window.calls)).toEqual([]);
  });

  test('popping from the middle keeps the rest in order', async ({ page }) => {
    await openKit(page);
    await page.evaluate(() => {
      window.calls = [];
      const { pushEscape } = window.kit;
      pushEscape(() => { window.calls.push('A'); return true; });
      const popB = pushEscape(() => { window.calls.push('B'); return true; });
      pushEscape(() => { window.calls.push('C'); return false; });
      popB();
    });
    await page.keyboard.press('Escape');
    expect(await page.evaluate(() => window.calls)).toEqual(['C', 'A']);
  });

  test('popover closes before modal, modal before the base handler', async ({ page }) => {
    await openKit(page);
    await page.evaluate(() => {
      window.calls = [];
      const { pushEscape, openModal, openPopover } = window.kit;
      pushEscape(() => { window.calls.push('base'); return true; });
      const body = document.createElement('p');
      body.textContent = 'Modal body';
      openModal({ title: 'Choose a deck', body, actions: [{ label: 'Cancel' }], onClose: () => window.calls.push('modal') });
      const content = document.createElement('p');
      content.textContent = 'Popover body';
      openPopover({ x: 200, y: 200, content, onClose: () => window.calls.push('popover') });
    });
    await expect(page.locator('.dialog')).toBeVisible();
    await expect(page.locator('.popover')).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(page.locator('.popover')).toHaveCount(0);
    await expect(page.locator('.dialog')).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(page.locator('.dialog')).toHaveCount(0);
    expect(await page.evaluate(() => window.calls)).toEqual(['popover', 'modal']);

    await page.keyboard.press('Escape');
    expect(await page.evaluate(() => window.calls)).toEqual(['popover', 'modal', 'base']);
  });

  test('escape from an attached iframe document reaches the stack', async ({ page }) => {
    await openKit(page);
    await page.evaluate(async () => {
      window.calls = [];
      const frame = document.createElement('iframe');
      frame.id = 'kit-frame';
      frame.srcdoc = '<p tabindex="0" id="t">Frame</p>';
      document.body.append(frame);
      await new Promise((r) => frame.addEventListener('load', r, { once: true }));
      window.kit.attachEscape(frame.contentDocument);
      window.kit.pushEscape(() => { window.calls.push('frame'); return true; });
    });
    await page.frameLocator('#kit-frame').locator('#t').focus();
    await page.keyboard.press('Escape');
    expect(await page.evaluate(() => window.calls)).toEqual(['frame']);
  });
});

test.describe('toast', () => {
  test.use({ contextOptions: { reducedMotion: 'reduce' } });

  test('shows one at a time and works through the queue', async ({ page }) => {
    await page.clock.install();
    await openKit(page);
    await page.evaluate(() => {
      window.kit.toast('First');
      window.kit.toast('Second');
      window.kit.toast('Third');
    });
    const toasts = page.locator('.toast');
    await expect(toasts).toHaveCount(1);
    await expect(toasts).toHaveText(/First/);

    await page.locator('.toast .toast-close').click();
    await page.mouse.move(5, 700);
    await expect(toasts).toHaveCount(1);
    await expect(toasts).toHaveText(/Second/);

    await page.clock.runFor(3100);
    await expect(toasts).toHaveText(/Third/);

    await page.clock.runFor(3100);
    await expect(toasts).toHaveCount(0);
  });

  test('identical consecutive toasts are not repeated', async ({ page }) => {
    await page.clock.install();
    await openKit(page);
    await page.evaluate(() => {
      window.kit.toast('Updated from disk');
      window.kit.toast('Updated from disk');
    });
    await page.clock.runFor(3100);
    await expect(page.locator('.toast')).toHaveCount(0);
  });

  test('action runs its handler and dismisses the toast', async ({ page }) => {
    await openKit(page);
    await page.evaluate(() => {
      window.clicked = 0;
      window.kit.toast("Couldn't save", { tone: 'error', action: { label: 'Retry', onClick: () => { window.clicked++; } } });
    });
    const t = page.locator('.toast');
    await expect(t).toHaveClass(/toast-error/);
    await t.getByRole('button', { name: 'Retry' }).click();
    expect(await page.evaluate(() => window.clicked)).toBe(1);
    await expect(t).toHaveCount(0);
  });

  test('text is never interpreted as HTML', async ({ page }) => {
    await openKit(page);
    await page.evaluate(() => { window.kit.toast('<img src=x onerror="window.pwned=1">.html'); });
    await expect(page.locator('.toast')).toContainText('<img src=x');
    await expect(page.locator('.toast img')).toHaveCount(0);
    expect(await page.evaluate(() => window.pwned)).toBeUndefined();
  });
});

test.describe('modal', () => {
  test('traps focus, restores it on close and wires actions', async ({ page }) => {
    await openKit(page);
    await page.locator('#open-modal').focus();
    await page.evaluate(() => {
      window.picked = null;
      const body = document.createElement('input');
      body.className = 'input';
      body.id = 'modal-input';
      window.m = window.kit.openModal({
        title: 'Choose a deck',
        body,
        actions: [
          { label: 'Cancel' },
          { label: 'Open', primary: true, onClick: ({ close }) => { window.picked = 'open'; close(); } },
        ],
      });
    });
    const modal = page.locator('.dialog');
    await expect(modal).toHaveAttribute('role', 'dialog');
    await expect(modal).toHaveAttribute('aria-modal', 'true');
    await expect(page.getByRole('dialog', { name: 'Choose a deck' })).toBeVisible();
    await expect(page.locator('#modal-input')).toBeFocused();

    for (let i = 0; i < 6; i++) await page.keyboard.press('Tab');
    const inside = await page.evaluate(() => document.querySelector('.dialog').contains(document.activeElement));
    expect(inside).toBe(true);

    await modal.getByRole('button', { name: 'Open' }).click();
    expect(await page.evaluate(() => window.picked)).toBe('open');
    await expect(modal).toHaveCount(0);
    await expect(page.locator('#open-modal')).toBeFocused();
  });

  test('an action without a handler closes the modal', async ({ page }) => {
    await openKit(page);
    await page.evaluate(() => {
      window.kit.openModal({ title: 'Hello', body: document.createTextNode('Body'), actions: [{ label: 'Cancel' }] });
    });
    await page.locator('.dialog').getByRole('button', { name: 'Cancel' }).click();
    await expect(page.locator('.dialog')).toHaveCount(0);
  });
});

test.describe('popover', () => {
  test('outside click closes only when canDismiss allows it', async ({ page }) => {
    await openKit(page);
    await page.evaluate(() => {
      window.closedCount = 0;
      window.allow = false;
      const content = document.createElement('textarea');
      content.id = 'pop-text';
      window.kit.openPopover({ x: 120, y: 120, content, canDismiss: () => window.allow, onClose: () => { window.closedCount++; } });
    });
    await expect(page.locator('.popover')).toBeVisible();
    await page.mouse.click(900, 600);
    await expect(page.locator('.popover')).toBeVisible();
    expect(await page.evaluate(() => window.closedCount)).toBe(0);

    await page.evaluate(() => { window.allow = true; });
    await page.mouse.click(900, 600);
    await expect(page.locator('.popover')).toHaveCount(0);
    expect(await page.evaluate(() => window.closedCount)).toBe(1);
  });

  test('clicks inside do not close it', async ({ page }) => {
    await openKit(page);
    await page.evaluate(() => {
      const content = document.createElement('button');
      content.textContent = 'Inside';
      content.id = 'pop-inside';
      window.kit.openPopover({ x: 120, y: 120, content });
    });
    await page.locator('#pop-inside').click();
    await expect(page.locator('.popover')).toBeVisible();
  });

  test('stays inside the viewport near the edges', async ({ page }) => {
    await page.setViewportSize({ width: 1000, height: 700 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await openKit(page);
    await page.evaluate(() => {
      const content = document.createElement('div');
      content.style.width = '300px';
      content.style.height = '160px';
      window.kit.openPopover({ x: 990, y: 690, content });
    });
    const box = await page.locator('.popover').boundingBox();
    expect(box.x).toBeGreaterThanOrEqual(8);
    expect(box.y).toBeGreaterThanOrEqual(8);
    expect(box.x + box.width).toBeLessThanOrEqual(992);
    expect(box.y + box.height).toBeLessThanOrEqual(692);
  });

  test('menu selects with the keyboard', async ({ page }) => {
    await openKit(page);
    await page.evaluate(() => {
      window.chosen = null;
      const anchor = document.querySelector('#open-menu');
      window.kit.openMenu({
        anchor,
        items: [
          { label: 'Claude Code', checked: true, onSelect: () => { window.chosen = 'claude'; } },
          { label: 'Codex', onSelect: () => { window.chosen = 'codex'; } },
        ],
      });
    });
    await expect(page.getByRole('menu')).toBeVisible();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    expect(await page.evaluate(() => window.chosen)).toBe('codex');
    await expect(page.getByRole('menu')).toHaveCount(0);
  });
});

test.describe('icons', () => {
  test('every icon is a consistent inline SVG and unknown names throw', async ({ page }) => {
    await openKit(page);
    const result = await page.evaluate(() => {
      const { icon, iconNames } = window.kit;
      const bad = [];
      for (const name of iconNames) {
        const svg = icon(name, { size: 20 });
        const ok = svg instanceof SVGElement
          && svg.getAttribute('viewBox') === '0 0 24 24'
          && svg.getAttribute('width') === '20'
          && svg.getAttribute('aria-hidden') === 'true'
          && svg.childElementCount > 0;
        if (!ok) bad.push(name);
      }
      let threw = false;
      try { icon('definitely-not-an-icon'); } catch { threw = true; }
      return { count: iconNames.length, bad, threw, def: icon('home').getAttribute('width') };
    });
    expect(result.bad).toEqual([]);
    expect(result.threw).toBe(true);
    expect(result.def).toBe('16');
    expect(result.count).toBeGreaterThanOrEqual(30);
  });

  test('the icon set covers what the spec needs', async ({ page }) => {
    await openKit(page);
    const names = await page.evaluate(() => window.kit.iconNames);
    for (const n of ['home', 'folder', 'file', 'upload', 'image', 'text', 'plus', 'trash', 'undo', 'redo',
      'play', 'stop', 'check', 'x', 'chevron-down', 'sparkle', 'note', 'pin', 'copy', 'eye', 'alert',
      'refresh', 'external', 'anchor', 'arrow-left', 'caret', 'close', 'warning']) {
      expect(names).toContain(n);
    }
  });
});

test.describe('reduced motion', () => {
  async function durations(page) {
    return page.evaluate(() => {
      const out = new Set();
      for (const el of document.querySelectorAll('*')) {
        const cs = getComputedStyle(el);
        for (const v of cs.transitionDuration.split(',')) out.add(v.trim());
        for (const v of cs.animationDuration.split(',')) out.add(v.trim());
      }
      return [...out];
    });
  }

  test('motion tokens are real by default', async ({ page }) => {
    await openKit(page);
    const fast = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--dur-fast').trim());
    expect(fast).toBe('120ms');
    const btn = await page.evaluate(() => getComputedStyle(document.querySelector('.btn')).transitionDuration);
    expect(btn).toContain('0.12s');
  });

  test.describe('with prefers-reduced-motion', () => {
    test.use({ contextOptions: { reducedMotion: 'reduce' } });

    test('every transition and animation is zero', async ({ page }) => {
      await openKit(page);
      await page.evaluate(() => {
        window.kit.toast('Saved');
        window.kit.openModal({ title: 'Motion', body: document.createTextNode('Still'), actions: [{ label: 'Close' }] });
      });
      await expect(page.locator('.toast')).toBeVisible();
      for (const token of ['--dur-fast', '--dur-pop', '--dur-screen', '--dur-shimmer']) {
        const v = await page.evaluate((t) => getComputedStyle(document.documentElement).getPropertyValue(t).trim(), token);
        expect(v, token).toBe('0ms');
      }
      const all = await durations(page);
      expect(all.every((d) => d === '0s')).toBe(true);
    });

    test('closing a modal removes it straight away', async ({ page }) => {
      await page.clock.install();
      await openKit(page);
      await page.evaluate(() => {
        window.mm = window.kit.openModal({ title: 'Quick', body: document.createTextNode('x'), actions: [] });
        window.mm.close();
      });
      await page.clock.runFor(1);
      await expect(page.locator('.dialog')).toHaveCount(0);
    });
  });
});

test('the kit page has no console errors', async ({ page }) => {
  const errors = await openKit(page);
  await page.waitForTimeout(100);
  expect(errors).toEqual([]);
});
