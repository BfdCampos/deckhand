import { test as base, expect } from '@playwright/test';
import { startDeckhand } from '../helpers/deckhand.js';

// Playwright's own per-frame bootstrap is refused inside sandboxed frames (dock
// thumbnails), and Chrome logs that refusal. It never happens outside automation.
const HARNESS_NOISE = /^Blocked script execution in 'about:srcdoc' because the document's frame is sandboxed/;

export const test = base.extend({
  deckhandOptions: [{}, { option: true }],
  allowedConsoleErrors: [[], { option: true }],
  expectedApiErrors: [[], { option: true }],

  deckhand: async ({ deckhandOptions, context }, use, testInfo) => {
    const dh = await startDeckhand(deckhandOptions);
    try {
      await use(dh);
    } finally {
      for (const page of context.pages()) await page.close().catch(() => {});
      await dh.stop();
      if (testInfo.status !== testInfo.expectedStatus) {
        await testInfo.attach('deckhand-output.txt', { body: dh.output(), contentType: 'text/plain' });
        const log = dh.agentLog();
        if (log.length) await testInfo.attach('fake-agent-log.json', { body: JSON.stringify(log, null, 2), contentType: 'application/json' });
      }
      await dh.dispose();
    }
  },

  failOnConsoleErrors: [async ({ context, allowedConsoleErrors, expectedApiErrors }, use) => {
    const problems = [];
    const expectedApi = (msg) => {
      const m = /^Failed to load resource: the server responded with a status of (\d{3})/.exec(msg.text());
      if (!m) return false;
      const { pathname } = new URL(msg.location().url || 'http://x/');
      return expectedApiErrors.some(({ path: p, status }) => Number(m[1]) === status
        && pathname.startsWith('/api/') && (p instanceof RegExp ? p.test(pathname) : pathname === p));
    };
    const matches = (text) => HARNESS_NOISE.test(text) || allowedConsoleErrors.some((p) => (p instanceof RegExp ? p.test(text) : text.includes(p)));
    const allowed = (...texts) => texts.some((t) => t && matches(t));
    const watch = (page) => {
      page.on('console', (msg) => {
        if (msg.type() === 'error' && !expectedApi(msg) && !allowed(msg.text(), msg.location().url)) problems.push(`console.error: ${msg.text()} (${msg.location().url})`);
      });
      page.on('pageerror', (err) => {
        if (!allowed(err.message)) problems.push(`pageerror: ${err.message}`);
      });
      page.on('dialog', (dialog) => {
        problems.push(`dialog (${dialog.type()}): ${dialog.message()}`);
        dialog.dismiss().catch(() => {});
      });
    };
    context.pages().forEach(watch);
    context.on('page', watch);
    await use(problems);
    expect(problems, 'console errors, page errors or dialogs').toEqual([]);
  }, { auto: true }],
});

export { expect };
