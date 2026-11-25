import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import claude from '../../src/server/agents/claude.js';
import codex from '../../src/server/agents/codex.js';
import { STREAMS, makeStaging, runFake } from '../helpers/fakes.js';

const CODEX_FLAGS = new Set(['--json', '--experimental-json', '--sandbox', '--cd', '--skip-git-repo-check', '--ephemeral', '--config']);
const CLAUDE_FLAGS = new Set(['--tools', '--restricted', '--strict-mcp-config', '--permission-mode', '--permission-prompts',
  '--no-session-persistence', '--disable-slash-commands', '--append-system-prompt']);

function parseLines(adapter, lines, cwd) {
  const parser = adapter.createParser({ cwd });
  const events = lines.flatMap((l) => parser.line(l));
  return { events, result: parser.finish() };
}

const recorded = (name) => fs.readFileSync(path.join(STREAMS, name), 'utf8').split('\n');
const brief = (events) => events.map((e) => [e.kind, e.text]);

test('identity and version parsing', () => {
  assert.equal(codex.id, 'codex');
  assert.equal(codex.name, 'Codex');
  assert.equal(codex.bin, 'codex');
  assert.equal(codex.parseVersion('codex-cli 0.130.0\n'), '0.130.0');
  assert.equal(codex.parseVersion(''), null);
});

test('AC-56 (D-14) edit invocation is sandboxed, offline and never asks for approval', () => {
  const inv = codex.invocation({ prompt: 'PROMPT', guardrail: 'GUARD', cwd: '/tmp/stage', kind: 'edit', flags: CODEX_FLAGS });
  assert.deepEqual(inv.args, [
    'exec', '--json', '--sandbox', 'workspace-write', '--cd', '/tmp/stage', '--skip-git-repo-check', '--ephemeral',
    '--config', 'approval_policy="never"',
    '--config', 'sandbox_workspace_write.network_access=false',
    '--config', 'web_search="disabled"',
    '-',
  ]);
  assert.equal(inv.stdin, 'GUARD\n\nPROMPT');
});

test('older CLIs get --experimental-json and lose --ephemeral', () => {
  const flags = new Set([...CODEX_FLAGS].filter((f) => f !== '--json' && f !== '--ephemeral'));
  const inv = codex.invocation({ prompt: 'P', guardrail: 'G', cwd: '/tmp/stage', kind: 'edit', flags });
  assert.ok(inv.args.includes('--experimental-json'));
  assert.ok(!inv.args.includes('--json'));
  assert.ok(!inv.args.includes('--ephemeral'));
  assert.ok(inv.args.includes('--sandbox'));
});

test('hand-written edit stream maps to readable events', () => {
  const { events, result } = parseLines(codex, recorded('codex-edit.jsonl'), '/tmp/deckhand-run-Q7x2');
  assert.deepEqual(brief(events), [
    ['status', 'Starting Codex'],
    ['status', 'Thinking…'],
    ['read', 'Reading deck.html'],
    ['edit', 'Editing deck.html'],
    ['edit', 'Editing deck.deckhand.md'],
    ['text', 'I changed the heading to "Hi there" and ticked the note.'],
    ['result', 'Done.'],
  ]);
  assert.deepEqual(result, { ok: true, text: 'I changed the heading to "Hi there" and ticked the note.' });
});

test('declined commands, MCP calls and web searches are blocked lines', () => {
  const { events } = parseLines(codex, recorded('codex-blocked.jsonl'), '/tmp/deckhand-run-Q7x2');
  assert.deepEqual(events.filter((e) => e.kind === 'blocked').map((e) => e.text), [
    'Blocked: curl -s https://example.com (not allowed)',
    'Blocked: cat /etc/hosts (not allowed)',
    'Blocked: search (not allowed)',
    'Blocked: web search (not allowed)',
  ]);
});

test('a failed turn is not ok and carries the message', () => {
  const { events, result } = parseLines(codex, recorded('codex-failed.jsonl'), '/tmp/x');
  assert.equal(events.at(-1).kind, 'error');
  assert.deepEqual(result, { ok: false, text: 'stream disconnected before completion: error sending request' });
});

test('a create stream reports the written file', () => {
  const { events } = parseLines(codex, recorded('codex-create.jsonl'), '/tmp/deckhand-run-Zp41');
  assert.ok(events.some((e) => e.kind === 'write' && e.text === 'Writing quarterly-review.html'));
});

async function eventsFor(adapter, scenario) {
  const cwd = makeStaging();
  const inv = adapter.invocation({
    prompt: `[[fake:${scenario}]] Apply the notes.`, guardrail: 'G', cwd, kind: 'edit',
    flags: adapter.id === 'claude' ? CLAUDE_FLAGS : CODEX_FLAGS,
  });
  const run = await runFake(adapter.bin, inv.args, { stdin: inv.stdin, cwd });
  assert.equal(run.code, 0, run.stderr);
  return parseLines(adapter, run.stdout.split('\n'), cwd);
}

test('AC-10 both adapters give the same activity for the same scenario', async () => {
  for (const scenario of ['default', 'no-tick', 'stray-write']) {
    const a = await eventsFor(claude, scenario);
    const b = await eventsFor(codex, scenario);
    const norm = (evs) => brief(evs).map(([k, t]) => [k, t.replace('Claude Code', 'AGENT').replace('Codex', 'AGENT')]);
    assert.deepEqual(norm(b.events), norm(a.events), scenario);
    assert.deepEqual(b.result, a.result, scenario);
  }
});
