import { test as base, expect } from '@playwright/test';
import { startDeckhand } from '../helpers/deckhand.js';

export const test = base.extend({
  deckhandOptions: [{}, { option: true }],
  allowedConsoleErrors: [[], { option: true }],

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

  failOnConsoleErrors: [async ({ context, allowedConsoleErrors }, use) => {
    const problems = [];
    const allowed = (text) => allowedConsoleErrors.some((p) => (p instanceof RegExp ? p.test(text) : text.includes(p)));
    const watch = (page) => {
      page.on('console', (msg) => {
        if (msg.type() === 'error' && !allowed(msg.text())) problems.push(`console.error: ${msg.text()}`);
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
