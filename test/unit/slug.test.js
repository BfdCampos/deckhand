import { test } from 'node:test';
import assert from 'node:assert/strict';
import { slugify, uniqueDeckName } from '../../src/shared/slug.js';

test('slugs are lowercase, hyphenated and skip leading filler', () => {
  assert.equal(slugify('Make me a 6-slide pitch for our new coffee subscription, warm and minimal'), '6-slide-pitch-new-coffee-subscription');
  assert.equal(slugify('The Quarterly Review'), 'quarterly-review');
  assert.equal(slugify('Create an onboarding deck'), 'onboarding-deck');
});

test('slugs keep at most six meaningful words and digits-only words', () => {
  assert.equal(slugify('one two three four five six seven eight'), 'one-two-three-four-five-six');
  assert.equal(slugify('2026 roadmap'), '2026-roadmap');
});

test('slugs are ASCII and fold accents', () => {
  assert.equal(slugify('Café crème über naïve'), 'cafe-creme-uber-naive');
  assert.equal(slugify('日本語 deck'), 'deck');
});

test('slugs are at most 48 characters and never end in a hyphen', () => {
  const s = slugify('internationalisation localisation decentralisation institutionalisation characterisation');
  assert.ok(s.length <= 48, s);
  assert.doesNotMatch(s, /-$/);
  assert.match(s, /^[a-z0-9]+(-[a-z0-9]+)*$/);
});

test('empty or meaningless descriptions fall back to untitled-deck', () => {
  assert.equal(slugify(''), 'untitled-deck');
  assert.equal(slugify('   '), 'untitled-deck');
  assert.equal(slugify('make me a'), 'untitled-deck');
  assert.equal(slugify('!!! ???'), 'untitled-deck');
});

test('uniqueDeckName appends -2, -3 when the name is taken', () => {
  const taken = new Set(['tea.html', 'tea-2.html']);
  assert.equal(uniqueDeckName('tea', (n) => taken.has(n)), 'tea-3.html');
  assert.equal(uniqueDeckName('coffee', (n) => taken.has(n)), 'coffee.html');
});
