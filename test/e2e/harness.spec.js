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
