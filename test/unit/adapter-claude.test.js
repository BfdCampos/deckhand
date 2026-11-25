import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import claude from '../../src/server/agents/claude.js';
import { STREAMS, makeStaging, runFake } from '../helpers/fakes.js';
import fs from 'node:fs';

const ALL_FLAGS = new Set([
  '--tools', '--restricted', '--strict-mcp-config', '--permission-mode', '--permission-prompts',
  '--no-session-persistence', '--disable-slash-commands', '--append-system-prompt',
]);

function parseLines(lines, cwd) {
  const parser = claude.createParser({ cwd });
  const events = lines.flatMap((l) => parser.line(l));
  return { events, result: parser.finish() };
}

const recorded = (name) => fs.readFileSync(path.join(STREAMS, name), 'utf8').split('\n');
const brief = (events) => events.map((e) => [e.kind, e.text]);

test('identity and version parsing', () => {
  assert.equal(claude.id, 'claude');
  assert.equal(claude.name, 'Claude Code');
  assert.equal(claude.bin, 'claude');
  assert.match(claude.docsUrl, /^https:\/\//);
  assert.equal(claude.parseVersion('2.1.331 (Claude Code)\n'), '2.1.331');
  assert.equal(claude.parseVersion('garbled'), null);
});

test('AC-56 edit invocation restricts tools, confines files and appends the guardrail', () => {
  const inv = claude.invocation({ prompt: 'PROMPT', guardrail: 'GUARD', cwd: '/tmp/x', kind: 'edit', flags: ALL_FLAGS });
  assert.deepEqual(inv.args, [
    '-p', '--output-format', 'stream-json', '--verbose',
    '--tools', 'Read,Edit,Write,Glob,Grep',
    '--restricted', '--strict-mcp-config',
    '--permission-mode', 'acceptEdits', '--permission-prompts', 'none',
    '--no-session-persistence', '--disable-slash-commands',
    '--append-system-prompt', 'GUARD',
  ]);
  assert.equal(inv.stdin, 'PROMPT');
  assert.ok(!inv.args.includes('PROMPT'), 'prompt never goes in argv');
});

test('flags the installed CLI does not list are dropped', () => {
  const flags = new Set([...ALL_FLAGS].filter((f) => f !== '--restricted' && f !== '--append-system-prompt'));
  const inv = claude.invocation({ prompt: 'PROMPT', guardrail: 'GUARD', cwd: '/tmp/x', kind: 'edit', flags });
  assert.ok(!inv.args.includes('--restricted'));
  assert.ok(!inv.args.includes('--append-system-prompt'));
  assert.ok(inv.args.includes('--tools'));
  assert.equal(inv.stdin, 'GUARD\n\nPROMPT');
});

test('recorded --restricted stream maps to readable events in order', () => {
  const { events, result } = parseLines(recorded('claude-restricted.jsonl'), '/tmp/deckhand-run-F9Mp');
  assert.deepEqual(brief(events).slice(0, 5), [
    ['status', 'Starting Claude Code'],
    ['blocked', 'Blocked: Read (outside the deck folder)'],
    ['write', 'Writing other.txt'],
    ['read', 'Reading deck.html'],
    ['edit', 'Editing deck.html'],
  ]);
  assert.equal(events[5].kind, 'text');
  assert.equal(events[6].kind, 'result');
  assert.equal(events.length, 7);
  assert.equal(events[3].file, 'deck.html');
  assert.equal(events[1].tool, 'Read');
  assert.equal(result.ok, true);
  assert.match(result.text, /DONE/);
});

test('thinking collapses into one line and outside reads show their path', () => {
  const { events } = parseLines(recorded('claude-edit-unrestricted.jsonl'), '/tmp/deckhand-run-a0j8');
  assert.deepEqual(brief(events).map(([k, t]) => (k === 'text' || k === 'result' ? k : `${k}: ${t}`)), [
    'status: Starting Claude Code',
    'status: Thinking…',
    'read: Reading deck.html',
    'edit: Editing deck.html',
    'text',
    'read: Reading /etc/hosts',
    'status: Thinking…',
    'text',
    'result',
  ]);
});

test('a policy denial is shown with its reason', () => {
  const { events, result } = parseLines(recorded('claude-edit-sensitive-denied.jsonl'), '/Users/sam/.claude/scratch');
  const blocked = events.find((e) => e.kind === 'blocked');
  assert.equal(blocked.text, 'Blocked: Edit (no approval surface in this session; permission request denied automatically)');
  assert.ok(!events.some((e) => e.kind === 'edit'), 'a denied edit is not shown as an edit');
  assert.equal(result.ok, true);
});

test('unknown and malformed lines are ignored; no result means ok null', () => {
  const { events, result } = parseLines(['', 'not json', '{"type":"mystery"}', '{"type":"system","subtype":"hook_started"}'], '/tmp');
  assert.deepEqual(events, []);
  assert.deepEqual(result, { ok: null, text: null });
});

test('an error result is not ok', () => {
  const { events, result } = parseLines([JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'Not logged in' })], '/tmp');
  assert.deepEqual(brief(events), [['error', 'Not logged in']]);
  assert.deepEqual(result, { ok: false, text: 'Not logged in' });
});

test('the fake blocked scenario gives the AC-47 order', async () => {
  const cwd = makeStaging();
  const inv = claude.invocation({ prompt: '[[fake:blocked]] go', guardrail: 'G', cwd, kind: 'edit', flags: ALL_FLAGS });
  const run = await runFake('claude', inv.args, { stdin: inv.stdin, cwd });
  const { events } = parseLines(run.stdout.split('\n'), cwd);
  assert.deepEqual(events.map((e) => e.kind), ['status', 'read', 'blocked', 'blocked', 'edit', 'text', 'result']);
  assert.deepEqual(events.filter((e) => e.kind === 'blocked').map((e) => e.text), [
    'Blocked: Bash (not allowed)',
    'Blocked: Read (outside the deck folder)',
  ]);
});
