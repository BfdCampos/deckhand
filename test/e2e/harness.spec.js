import { test, expect } from './fixtures.js';

test('the app loads at / from a fresh server', async ({ page, deckhand }) => {
  const response = await page.goto(deckhand.url + '/');
  expect(response.status()).toBe(200);
  await expect(page).toHaveTitle(/Deckhand/);
});

test.describe('with a deck', () => {
  test.use({ deckhandOptions: { deck: 'test/fixtures/decks/basic.html' } });

  test('the deck is a temp copy, not the fixture', async ({ deckhand }) => {
    expect(deckhand.deckPath.startsWith(deckhand.home)).toBe(true);
  });
});

test.describe('console guard', () => {
  test('fails the test on console.error', async ({ page, deckhand }) => {
    test.fail();
    await page.goto(deckhand.url + '/');
    await page.evaluate(() => console.error('boom'));
  });

  test('fails the test on an uncaught page error', async ({ page, deckhand }) => {
    test.fail();
    await page.goto(deckhand.url + '/');
    await page.evaluate(() => setTimeout(() => { throw new Error('kaboom'); }));
    await page.waitForTimeout(100);
  });

  test('fails the test on a dialog', async ({ page, deckhand }) => {
    test.fail();
    await page.goto(deckhand.url + '/');
    await page.evaluate(() => alert('hello'));
  });

  test.describe('with an allowed message', () => {
    test.use({ allowedConsoleErrors: [/expected noise/] });

    test('lets allowed console errors through', async ({ page, deckhand }) => {
      await page.goto(deckhand.url + '/');
      await page.evaluate(() => console.error('some expected noise'));
    });
  });
});

test.describe('expected API errors', () => {
  test.use({ expectedApiErrors: [{ path: '/api/runs/run_nope/stop', status: 409 }] });

  test('a declared API 4xx does not fail the test', async ({ page, deckhand }) => {
    await page.goto(deckhand.url + '/');
    const status = await page.evaluate(() => fetch('/api/runs/run_nope/stop', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).then((r) => r.status));
    expect(status).toBe(409);
  });

  test('an undeclared API 4xx still fails it', async ({ page, deckhand }) => {
    test.fail();
    await page.goto(deckhand.url + '/');
    await page.evaluate(() => fetch('/api/runs/run_nope/revert', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }));
    await page.waitForTimeout(100);
  });
});

test.describe('option shapes', () => {
  test.describe('several allowed messages, wrapped once', () => {
    test.use({ allowedConsoleErrors: [[/first noise/, /second noise/]] });

    test('every pattern in the list is honoured', async ({ page, deckhand }) => {
      await page.goto(deckhand.url + '/');
      await page.evaluate(() => { console.error('the first noise'); console.error('the second noise'); });
    });
  });

  test.describe('a single bare pattern', () => {
    test.use({ allowedConsoleErrors: /lonely noise/ });

    test('is accepted too', async ({ page, deckhand }) => {
      await page.goto(deckhand.url + '/');
      await page.evaluate(() => console.error('some lonely noise'));
    });
  });

  test.describe('several expected API errors, wrapped once', () => {
    test.use({ expectedApiErrors: [[{ path: '/api/runs/run_a/stop', status: 409 }, { path: '/api/runs/run_b/revert', status: 409 }]] });

    test('every entry is honoured', async ({ page, deckhand }) => {
      await page.goto(deckhand.url + '/');
      await page.evaluate(async () => {
        const post = (p) => fetch(p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
        await post('/api/runs/run_a/stop');
        await post('/api/runs/run_b/revert');
      });
    });
  });
});
