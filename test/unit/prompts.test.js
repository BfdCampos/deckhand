import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BUILD_CONTRACT, createPrompt, editPrompt, guardrail } from '../../src/server/prompts.js';

test('the build contract keeps the product wording and names the file', () => {
  const p = createPrompt({ name: 'tea-deck.html', description: 'A deck about tea' });
  assert.ok(p.startsWith("You're creating a new slide deck for Deckhand, a local HTML presentation editor. Write exactly one file, `tea-deck.html`, in the current folder, and nothing else."));
  assert.match(p, /<section class="slide">/);
  assert.match(p, /Don't run shell commands or touch the network\. The person's request follows\.\n\nA deck about tea$/);
  assert.match(BUILD_CONTRACT, /<name>\.html/);
});

test('an edit prompt names the deck and the work order and asks for ticks', () => {
  const p = editPrompt({ deck: '/d/deck.html', workOrder: '/d/deck.deckhand.md', notes: [{ id: 'n_a', text: 'Bigger' }] });
  assert.match(p, /\/d\/deck\.deckhand\.md/);
  assert.match(p, /\/d\/deck\.html/);
  assert.match(p, /tick its box/);
  assert.match(p, /- n_a: Bigger/);
  assert.doesNotMatch(p, /one note only/);
});

test('a single-note prompt says so', () => {
  const p = editPrompt({ deck: 'deck.html', workOrder: 'deck.deckhand.md', notes: [{ id: 'n_b', text: 'x' }], noteId: 'n_b' });
  assert.match(p, /This run is for one note only: n_b\./);
});

test('guardrails confine the agent', () => {
  const edit = guardrail({ kind: 'edit', deck: 'deck.html', workOrder: 'deck.deckhand.md' });
  assert.match(edit, /Never create, edit, move or delete any other file/);
  assert.match(edit, /Never run shell commands/);
  assert.match(edit, /data-ai-id/);
  const create = guardrail({ kind: 'create', target: 'tea.html' });
  assert.match(create, /Write exactly one file, tea\.html, and nothing else/);
  for (const g of [edit, create]) assert.doesNotMatch(g, /—/);
});
