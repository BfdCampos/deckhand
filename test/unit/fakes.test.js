import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  FIXTURES, STREAMS, agentBinDir, makeStaging, readAgentLog, readStream, runFake, spawnFake, tempDir,
} from '../helpers/fakes.js';

const CLAUDE_ARGS = [
  '-p', '--output-format', 'stream-json', '--verbose',
  '--tools', 'Read,Edit,Write,Glob,Grep',
  '--restricted', '--strict-mcp-config',
  '--permission-mode', 'acceptEdits', '--permission-prompts', 'none',
  '--no-session-persistence', '--disable-slash-commands',
  '--append-system-prompt', 'Only edit deck.html.',
];

const codexArgs = (cwd) => [
  'exec', '--json', '--sandbox', 'workspace-write', '--cd', cwd, '--skip-git-repo-check', '--ephemeral',
  '--config', 'approval_policy="never"',
  '--config', 'sandbox_workspace_write.network_access=false',
  '--config', 'web_search="disabled"',
  '-',
];

const EDIT_PROMPT = 'Apply the notes in deck.deckhand.md to deck.html.';
const createPrompt = (name) => `You're creating a new slide deck for Deckhand. Write exactly one file, \`${name}\`, in the current folder, and nothing else.\n\nA deck about tea.`;

const kinds = (lines) => lines.map((l) => (l.subtype ? `${l.type}/${l.subtype}` : l.type));
const toolUses = (lines) => lines.filter((l) => l.type === 'assistant').flatMap((l) => l.message.content).filter((c) => c.type === 'tool_use');
const items = (lines) => lines.filter((l) => l.type === 'item.completed').map((l) => l.item);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

async function waitFor(fn, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return true; await sleep(25); }
  return false;
}

describe('fake CLI basics', () => {
  test('--version prints the real formats', async () => {
    const claude = await runFake('claude', ['--version']);
    assert.equal(claude.stdout, '2.1.331 (Claude Code)\n');
    const codex = await runFake('codex', ['--version']);
    assert.equal(codex.stdout, 'codex-cli 0.130.0\n');
  });

  test('version can be delayed or replaced per tool', async () => {
    const started = Date.now();
    const slow = await runFake('claude', ['--version'], { env: { FAKE_CLAUDE_VERSION_DELAY: '300' } });
    assert.ok(Date.now() - started >= 300);
    assert.equal(slow.stdout, '2.1.331 (Claude Code)\n');
    const odd = await runFake('codex', ['--version'], { env: { FAKE_AGENT_VERSION: 'garbled' } });
    assert.equal(odd.stdout, 'garbled\n');
  });

  test('claude --help lists the probed flags', async () => {
    const { stdout, code } = await runFake('claude', ['--help']);
    assert.equal(code, 0);
    for (const flag of ['--restricted', '--tools', '--permission-prompts', '--append-system-prompt', '--strict-mcp-config']) {
      assert.match(stdout, new RegExp(`${flag}\\b`));
    }
  });

  test('omitted flags vanish from --help and become unknown options', async () => {
    const env = { FAKE_CLAUDE_HELP_OMIT: '--restricted,--permission-prompts' };
    const help = await runFake('claude', ['--help'], { env });
    assert.doesNotMatch(help.stdout, /--restricted\b/);
    assert.doesNotMatch(help.stdout, /--permission-prompts\b/);
    assert.match(help.stdout, /--tools\b/);
    const run = await runFake('claude', CLAUDE_ARGS, { stdin: EDIT_PROMPT, cwd: makeStaging(), env });
    assert.equal(run.code, 1);
    assert.match(run.stderr, /unknown option '--restricted'/);
  });

  test('codex exec --help lists the SDK flags', async () => {
    const { stdout } = await runFake('codex', ['exec', '--help']);
    for (const flag of ['--json', '--sandbox', '--cd', '--skip-git-repo-check', '--ephemeral', '--config']) {
      assert.match(stdout, new RegExp(`${flag}\\b`));
    }
  });

  test('PATH dirs hold the right fakes', () => {
    const list = (agents) => fs.readdirSync(agentBinDir(agents)).filter((f) => !f.startsWith('.')).sort();
    assert.deepEqual(list(['claude', 'codex']), ['claude', 'codex']);
    assert.deepEqual(list(['claude']), ['claude']);
    assert.deepEqual(list([]), []);
    for (const tool of ['claude', 'codex']) {
      const mode = fs.statSync(path.join(FIXTURES, 'bin', tool)).mode;
      assert.ok(mode & 0o100, `${tool} is executable`);
    }
  });
});

describe('fake claude', () => {
  test('default edit scenario reads, edits, ticks and succeeds', async () => {
    const cwd = makeStaging({ notes: [{ id: 'n_one', text: 'a' }, { id: 'n_two', text: 'b' }] });
    const log = path.join(tempDir(), 'agent.log');
    const run = await runFake('claude', CLAUDE_ARGS, { stdin: EDIT_PROMPT, cwd, env: { FAKE_AGENT_LOG: log } });
    assert.equal(run.code, 0, run.stderr);
    assert.deepEqual(kinds(run.lines), [
      'system/init', 'system/thinking_tokens', 'assistant', 'assistant', 'user', 'assistant', 'user', 'assistant', 'result/success',
    ]);
    const init = run.lines[0];
    assert.equal(init.cwd, fs.realpathSync(cwd));
    assert.deepEqual(init.tools, ['Read', 'Edit', 'Write', 'Glob', 'Grep']);
    assert.equal(init.permissionMode, 'acceptEdits');
    assert.deepEqual(toolUses(run.lines).map((t) => [t.name, path.basename(t.input.file_path)]), [['Read', 'deck.html'], ['Edit', 'deck.html']]);
    const result = run.lines.at(-1);
    assert.equal(result.is_error, false);
    assert.equal(result.result, 'I applied the notes and ticked them off.');

    assert.match(fs.readFileSync(path.join(cwd, 'deck.html'), 'utf8'), /<h1>Edited: Basic deck<\/h1>/);
    const md = fs.readFileSync(path.join(cwd, 'deck.deckhand.md'), 'utf8');
    assert.match(md, /^- \[x\] n_one:/m);
    assert.match(md, /^- \[x\] n_two:/m);

    const [entry] = readAgentLog(log, { mode: 'run' });
    assert.deepEqual(entry.argv, CLAUDE_ARGS);
    assert.equal(fs.realpathSync(entry.cwd), fs.realpathSync(cwd));
    assert.equal(entry.stdin, EDIT_PROMPT);
    assert.equal(typeof entry.pid, 'number');
    assert.equal(typeof entry.ppid, 'number');
    assert.ok(entry.env.PATH.includes(agentBinDir()));
    assert.equal(entry.scenario, 'default');
  });

  test('stream-json without --verbose fails like the real CLI', async () => {
    const run = await runFake('claude', ['-p', '--output-format', 'stream-json'], { stdin: EDIT_PROMPT, cwd: makeStaging() });
    assert.equal(run.code, 1);
    assert.match(run.stderr, /requires --verbose/);
  });

  test('without stream-json it prints only the result text', async () => {
    const run = await runFake('claude', ['-p'], { stdin: EDIT_PROMPT, cwd: makeStaging() });
    assert.equal(run.code, 0);
    assert.equal(run.stdout, 'I applied the notes and ticked them off.\n');
  });

  test('scenario comes from the marker, then the env var, then default', async () => {
    const cwd = makeStaging();
    const env = { FAKE_AGENT_SCENARIO: 'fail' };
    const marked = await runFake('claude', CLAUDE_ARGS, { stdin: `[[fake:no-tick]] ${EDIT_PROMPT}`, cwd, env });
    assert.equal(marked.code, 0);
    assert.match(fs.readFileSync(path.join(cwd, 'deck.deckhand.md'), 'utf8'), /^- \[ \] n_one:/m);

    const fromEnv = await runFake('claude', CLAUDE_ARGS, { stdin: EDIT_PROMPT, cwd: makeStaging(), env });
    assert.equal(fromEnv.code, 1);
    assert.equal(fromEnv.lines.at(-1).is_error, true);
    assert.match(fromEnv.stderr, /the model returned an error/);

    const unknown = await runFake('claude', CLAUDE_ARGS, { stdin: `[[fake:nope]] ${EDIT_PROMPT}`, cwd });
    assert.equal(unknown.code, 2);
    assert.match(unknown.stderr, /unknown scenario "nope"/);
  });

  test('an absolute scenario path in the env var works', async () => {
    const file = path.join(tempDir(), 'custom.json');
    fs.writeFileSync(file, JSON.stringify({ steps: [{ emit: 'text', text: 'custom' }, { emit: 'result' }] }));
    const run = await runFake('claude', CLAUDE_ARGS, { stdin: EDIT_PROMPT, cwd: makeStaging(), env: { FAKE_AGENT_SCENARIO: file } });
    assert.equal(run.lines.at(-1).result, 'custom');
  });

  test('default create scenario writes the named file as a two-slide deck', async () => {
    const cwd = tempDir('deckhand-run-');
    const run = await runFake('claude', CLAUDE_ARGS, { stdin: createPrompt('tea-deck.html'), cwd });
    assert.equal(run.code, 0, run.stderr);
    const html = fs.readFileSync(path.join(cwd, 'tea-deck.html'), 'utf8');
    assert.equal(html.match(/<section class="slide">/g).length, 2);
    const [write] = toolUses(run.lines);
    assert.equal(write.name, 'Write');
    assert.equal(write.input.file_path, path.join(fs.realpathSync(cwd), 'tea-deck.html'));
    assert.deepEqual(fs.readdirSync(cwd), ['tea-deck.html']);
  });

  test('blocked scenario emits permission_denied for Bash and an outside Read', async () => {
    const run = await runFake('claude', CLAUDE_ARGS, { stdin: EDIT_PROMPT, cwd: makeStaging(), env: { FAKE_AGENT_SCENARIO: 'blocked' } });
    const denied = run.lines.filter((l) => l.subtype === 'permission_denied');
    assert.deepEqual(denied.map((d) => d.tool_name), ['Bash', 'Read']);
    assert.match(denied[1].decision_reason, /--restricted: path outside the working directory/);
    assert.equal(run.lines.at(-1).permission_denials.length, 2);
  });

  test('stray-write really writes other.txt in its cwd', async () => {
    const cwd = makeStaging();
    await runFake('claude', CLAUDE_ARGS, { stdin: `[[fake:stray-write]] ${EDIT_PROMPT}`, cwd });
    assert.equal(fs.readFileSync(path.join(cwd, 'other.txt'), 'utf8'), 'x');
  });

  test('hang exits 143 on SIGTERM', async () => {
    const child = spawnFake('claude', CLAUDE_ARGS, { stdin: `[[fake:hang]] ${EDIT_PROMPT}`, cwd: makeStaging() });
    const closed = new Promise((r) => child.on('close', (code, signal) => r({ code, signal })));
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    assert.ok(await waitFor(() => out.includes('thinking_tokens')));
    process.kill(-child.pid, 'SIGTERM');
    assert.deepEqual(await closed, { code: 143, signal: null });
    assert.doesNotMatch(out, /"type":"result"/);
  });

  test('hang-ignore-term survives SIGTERM and dies on SIGKILL', async () => {
    const child = spawnFake('claude', CLAUDE_ARGS, { stdin: `[[fake:hang-ignore-term]] ${EDIT_PROMPT}`, cwd: makeStaging() });
    const closed = new Promise((r) => child.on('close', (code, signal) => r({ code, signal })));
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    assert.ok(await waitFor(() => out.includes('"init"')));
    process.kill(-child.pid, 'SIGTERM');
    await sleep(300);
    assert.ok(alive(child.pid));
    process.kill(-child.pid, 'SIGKILL');
    assert.equal((await closed).signal, 'SIGKILL');
  });

  test('hang-with-child puts a grandchild in the group that a group kill removes', async () => {
    const log = path.join(tempDir(), 'agent.log');
    const child = spawnFake('claude', CLAUDE_ARGS, { stdin: `[[fake:hang-with-child]] ${EDIT_PROMPT}`, cwd: makeStaging(), env: { FAKE_AGENT_LOG: log } });
    const closed = new Promise((r) => child.on('close', r));
    assert.ok(await waitFor(() => readAgentLog(log, { mode: 'child' }).length === 1));
    const { childPid } = readAgentLog(log, { mode: 'child' })[0];
    assert.ok(alive(childPid));
    process.kill(-child.pid, 'SIGTERM');
    await closed;
    assert.ok(await waitFor(() => !alive(childPid)), 'grandchild gone');
  });
});

describe('fake codex', () => {
  test('default edit scenario renders Codex JSONL and edits the deck', async () => {
    const cwd = makeStaging();
    const log = path.join(tempDir(), 'agent.log');
    const run = await runFake('codex', codexArgs(cwd), { stdin: `Only edit deck.html.\n\n${EDIT_PROMPT}`, cwd: tempDir(), env: { FAKE_AGENT_LOG: log } });
    assert.equal(run.code, 0, run.stderr);
    assert.deepEqual(kinds(run.lines), [
      'thread.started', 'turn.started', 'item.completed', 'item.started', 'item.completed', 'item.completed', 'item.completed', 'turn.completed',
    ]);
    assert.deepEqual(items(run.lines).map((i) => i.type), ['reasoning', 'command_execution', 'file_change', 'agent_message']);
    const change = items(run.lines)[2];
    assert.deepEqual(change.changes, [{ path: path.join(cwd, 'deck.html'), kind: 'update' }]);
    assert.match(fs.readFileSync(path.join(cwd, 'deck.html'), 'utf8'), /<h1>Edited: Basic deck<\/h1>/);
    assert.match(fs.readFileSync(path.join(cwd, 'deck.deckhand.md'), 'utf8'), /^- \[x\] n_one:/m);
    const [entry] = readAgentLog(log, { mode: 'run' });
    assert.deepEqual(entry.argv, codexArgs(cwd));
    assert.match(entry.stdin, /^Only edit deck\.html\./);
  });

  test('refuses to run outside git without --skip-git-repo-check', async () => {
    const cwd = makeStaging();
    const args = codexArgs(cwd).filter((a) => a !== '--skip-git-repo-check');
    const run = await runFake('codex', args, { stdin: EDIT_PROMPT, cwd });
    assert.equal(run.code, 1);
    assert.match(run.stderr, /--skip-git-repo-check was not specified/);
  });

  test('unknown flags fail like clap', async () => {
    const run = await runFake('codex', ['exec', '--tools', 'Read', '-'], { stdin: EDIT_PROMPT, cwd: makeStaging() });
    assert.equal(run.code, 2);
    assert.match(run.stderr, /unexpected argument '--tools'/);
  });

  test('failed result renders turn.failed and exits 1', async () => {
    const cwd = makeStaging();
    const run = await runFake('codex', codexArgs(cwd), { stdin: `[[fake:fail]] ${EDIT_PROMPT}` });
    assert.equal(run.code, 1);
    assert.deepEqual(run.lines.at(-1), { type: 'turn.failed', error: { message: 'Something went wrong.' } });
  });

  test('blocked scenario renders declined commands', async () => {
    const cwd = makeStaging();
    const run = await runFake('codex', codexArgs(cwd), { stdin: `[[fake:blocked]] ${EDIT_PROMPT}` });
    const declined = items(run.lines).filter((i) => i.status === 'declined');
    assert.deepEqual(declined.map((i) => i.command), ["bash -lc 'ls'", "bash -lc 'cat /etc/hosts'"]);
  });

  test('default create scenario adds the named file', async () => {
    const cwd = tempDir('deckhand-run-');
    const run = await runFake('codex', codexArgs(cwd), { stdin: createPrompt('tea.html') });
    assert.equal(run.code, 0, run.stderr);
    assert.ok(fs.existsSync(path.join(cwd, 'tea.html')));
    assert.deepEqual(items(run.lines).find((i) => i.type === 'file_change').changes, [{ path: path.join(cwd, 'tea.html'), kind: 'add' }]);
  });

  test('hang dies by SIGTERM because codex only handles SIGINT', async () => {
    const cwd = makeStaging();
    const child = spawnFake('codex', codexArgs(cwd), { stdin: `[[fake:hang]] ${EDIT_PROMPT}` });
    const closed = new Promise((r) => child.on('close', (code, signal) => r({ code, signal })));
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    assert.ok(await waitFor(() => out.includes('reasoning')));
    process.kill(-child.pid, 'SIGTERM');
    assert.deepEqual(await closed, { code: null, signal: 'SIGTERM' });
  });
});

describe('recorded streams', () => {
  const files = fs.readdirSync(STREAMS).filter((f) => f.endsWith('.jsonl'));

  test('every line parses and nothing personal is left', () => {
    assert.ok(files.length >= 7);
    for (const f of files) {
      const text = fs.readFileSync(path.join(STREAMS, f), 'utf8');
      assert.doesNotMatch(text, /commands_changed/, f);
      assert.doesNotMatch(text, /\/Users\/(?!sam\/)/, f);
      assert.doesNotMatch(text, /\.claude\/plugins|monzo|brunocampos/i, f);
      assert.doesNotMatch(text, /—/, f);
      readStream(f);
    }
  });

  test('claude init payloads carry no skills, plugins or MCP servers', () => {
    for (const f of files.filter((n) => n.startsWith('claude-'))) {
      const init = readStream(f).find((l) => l.subtype === 'init');
      assert.deepEqual([init.skills, init.plugins, init.mcp_servers, init.slash_commands], [[], [], [], []], f);
    }
  });

  test('fake claude events have the same shape the recordings have', async () => {
    const recorded = readStream('claude-restricted.jsonl');
    const run = await runFake('claude', CLAUDE_ARGS, { stdin: `[[fake:blocked]] ${EDIT_PROMPT}`, cwd: makeStaging() });
    const pick = (lines, pred) => lines.find(pred);
    const pairs = [
      (l) => l.subtype === 'init',
      (l) => l.subtype === 'permission_denied',
      (l) => l.type === 'assistant' && l.message.content[0].type === 'tool_use',
      (l) => l.type === 'user',
      (l) => l.type === 'assistant' && l.message.content[0].type === 'text',
      (l) => l.type === 'result',
    ];
    const keysUsed = {
      init: ['type', 'subtype', 'cwd', 'tools', 'claude_code_version', 'session_id'],
      permission_denied: ['type', 'subtype', 'tool_name', 'tool_use_id', 'decision_reason', 'message'],
      result: ['type', 'subtype', 'is_error', 'result', 'session_id', 'permission_denials'],
    };
    for (const pred of pairs) {
      const real = pick(recorded, pred);
      const fake = pick(run.lines, pred);
      assert.ok(real && fake, pred.toString());
      const keys = keysUsed[real.subtype] || keysUsed[real.type] || Object.keys(real).filter((k) => !['uuid', 'timestamp', 'tool_use_result', 'tool_result_meta', 'wire_tool_inputs'].includes(k));
      for (const k of keys) assert.ok(k in fake, `${pred} missing ${k}`);
      if (typeof real.message === 'object') {
        const [rc, fc] = [real.message.content[0], fake.message.content[0]];
        for (const k of Object.keys(rc)) if (k !== 'is_error') assert.ok(k in fc, `content missing ${k}`);
        if (rc.input?.file_path) assert.ok(path.isAbsolute(fc.input.file_path));
      }
    }
  });

  test('fake codex items have the same keys as the hand-written streams', async () => {
    const written = [...readStream('codex-edit.jsonl'), ...readStream('codex-blocked.jsonl')];
    const scenario = path.join(tempDir(), 'codex-tools.json');
    fs.writeFileSync(scenario, JSON.stringify({ steps: [
      { emit: 'init' }, { emit: 'blocked', tool: 'Bash' }, { emit: 'blocked', tool: 'web_search' }, { emit: 'blocked', tool: 'mcp' }, { emit: 'result' },
    ] }));
    const cwd = makeStaging();
    const run = [
      ...(await runFake('codex', codexArgs(cwd), { stdin: EDIT_PROMPT })).lines,
      ...(await runFake('codex', codexArgs(makeStaging()), { stdin: EDIT_PROMPT, env: { FAKE_AGENT_SCENARIO: scenario } })).lines,
    ];
    const keyset = (lines) => {
      const out = {};
      for (const l of lines) {
        const id = l.item ? `${l.type}:${l.item.type}` : l.type;
        out[id] = Object.keys(l.item || l).sort().join(',');
      }
      return out;
    };
    const real = keyset(written);
    const fake = keyset(run);
    for (const [id, keys] of Object.entries(real)) {
      if (id === 'item.completed:reasoning' || id in fake) assert.equal(fake[id], keys, id);
    }
    for (const id of ['thread.started', 'turn.started', 'turn.completed', 'item.completed:command_execution', 'item.completed:file_change', 'item.completed:agent_message', 'item.completed:mcp_tool_call', 'item.completed:web_search']) {
      assert.ok(id in real && id in fake, id);
    }
  });
});
