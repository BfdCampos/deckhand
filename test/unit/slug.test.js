import { test } from 'node:test';
import assert from 'node:assert/strict';
import { slugify, uniqueDeckName } from '../../src/shared/slug.js';

test('slugs are lowercase, hyphenated and skip leading filler', () => {
  assert.equal(slugify('Make me a 6-slide pitch for our new coffee subscription, warm and minimal'), 'pitch-new-coffee-subscription-warm-minimal');
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

test('meta phrases about the deck itself are left out of the name', () => {
  assert.equal(slugify('a 3-slide deck introducing a community vegetable garden'), 'community-vegetable-garden');
  assert.equal(slugify('A presentation about the history of tea'), 'history-tea');
  assert.equal(slugify('slides on quarterly results'), 'quarterly-results');
  assert.equal(slugify('10 slides about our Q3 roadmap'), 'q3-roadmap');
  assert.equal(slugify('six-slide talk on solar power for schools'), 'solar-power-schools');
  assert.equal(slugify('Create an onboarding deck'), 'onboarding-deck');
  assert.equal(slugify('a 5 slide deck'), 'deck');
});

test('only the start of a very long description is used', () => {
  assert.equal(slugify('Tea ' + 'x'.repeat(100000)), 'tea');
});

test('names never end on a pronoun or a little joining word', () => {
  assert.equal(slugify('Team offsite agenda: three themes we want to cover'), 'team-offsite-agenda-three-themes');
  assert.equal(slugify('Plan the launch so that we can'), 'plan-launch');
  assert.equal(slugify('Quarterly review numbers and what they mean'), 'quarterly-review-numbers');
  const endings = new Set(['we', 'our', 'us', 'to', 'and', 'the', 'for', 'of', 'that', 'this', 'they', 'it', 'is', 'can', 'so', 'what', 'with', 'or', 'i', 'you']);
  for (const d of ['Why we moved to the cloud and what it cost us', 'Five things I wish I knew about hiring for', 'How you and I can work with them so that', 'Results from the test that we ran with']) {
    const last = slugify(d).split('-').at(-1);
    assert.ok(!endings.has(last), `${d} -> ${slugify(d)}`);
  }
});

test('the subject survives leading meta phrases', () => {
  const table = [
    ['A 3-slide deck that explains how our book club works', 'how-book-club-works'],
    ['Make me a 6-slide pitch for our new coffee subscription, warm and minimal, for the leadership team', 'pitch-new-coffee-subscription-warm-minimal'],
    ['A weekly team update for the platform squad: wins, risks and next steps', 'weekly-team-update-platform-squad-wins'],
    ['A 20-minute talk on observability for frontend engineers', '20-minute-observability-frontend-engineers'],
    ['Onboarding deck for new joiners in the data team', 'onboarding-deck-new-joiners-data-team'],
    ['Q3 quarterly review for the board, with revenue, churn and hiring', 'q3-quarterly-review-board-revenue-churn'],
    ['Slides for a half-day workshop on writing good SQL', 'half-day-workshop-writing-good-sql'],
    ['A presentation introducing our new design system', 'new-design-system'],
    ['Five slides explaining why we switched to Postgres', 'why-we-switched-postgres'],
    ['Create a deck about our 2027 hiring plan', '2027-hiring-plan'],
    ['Talk for a meetup: lessons from running Kafka in production', 'meetup-lessons-from-running-kafka-production'],
    ['An all-hands update on the product roadmap', 'all-hands-update-product-roadmap'],
    ['Customer case study deck for Acme Corp', 'customer-case-study-deck-acme-corp'],
    ['A short deck showing the results of our pricing experiment', 'results-pricing-experiment'],
    ['Investor pitch for a seed round, 10 slides', 'investor-pitch-seed-round'],
    ['Please build a 4-slide deck that covers our Q4 OKRs', 'q4-okrs'],
    ['Team update', 'team-update'],
    ['Quarterly business review for Q1 2027', 'quarterly-business-review-q1-2027'],
  ];
  for (const [description, expected] of table) assert.equal(slugify(description), expected, description);
});

test('a description that is only about the deck itself is named deck', () => {
  for (const d of ['A presentation', 'a 5 slide deck', 'Slides', 'A short deck that explains']) assert.equal(slugify(d), 'deck', d);
  assert.equal(uniqueDeckName(slugify('A presentation'), (n) => n === 'deck.html'), 'deck-2.html');
});
