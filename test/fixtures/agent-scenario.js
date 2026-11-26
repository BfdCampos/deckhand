// Engine behind the fake `claude` and `codex` CLIs in test/fixtures/bin.
// Scenario: test/fixtures/scenarios/<name>.json as { steps } or { edit, create } (picked by whether the
// prompt says "Write exactly one file, `<name>.html`"). Chosen by [[fake:<name>]] in stdin, else
// $FAKE_AGENT_SCENARIO (a name or an absolute path), else "default".
// Steps: { emit: init|thinking|read|edit|write|search|blocked|text|result, file?, tool?, text?, isError?,
//          content?, contentFrom?, replace?: [from, to], regex? }, { write: file, content?, contentFrom?, replace? },
//        { tick: [noteId] | 'all' | 'first' }, { hang: true, ignoreTerm?, child? }, { exit: n }, { stderr: text },
//        and any step may carry delay (ms). File placeholders: $deck, $workorder, $target.
// Env: FAKE_AGENT_LOG, FAKE_AGENT_SCENARIO, FAKE_{AGENT|CLAUDE|CODEX}_{VERSION,VERSION_DELAY,HELP_OMIT}.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const SCENARIO_DIR = path.join(HERE, 'scenarios');
export const DECK_DIR = path.join(HERE, 'decks');

export const VERSIONS = { claude: '2.1.331 (Claude Code)', codex: 'codex-cli 0.130.0' };
const MODEL = 'claude-opus-5-5';

const CLAUDE_OPTIONS = [
  ['-p, --print', false, 'Print response and exit (useful for pipes)'],
  ['--output-format <format>', true, 'Output format (only works with --print): "text" (default), "json" (single result), or "stream-json" (realtime streaming)'],
  ['--input-format <format>', true, 'Input format (only works with --print): "text" (default) or "stream-json"'],
  ['--verbose', false, 'Override verbose mode setting from config'],
  ['--tools <tools...>', 'list', 'Specify the list of available tools from the built-in set'],
  ['--allowed-tools, --allowedTools <tools...>', 'list', 'Comma or space-separated list of tool names to allow'],
  ['--disallowed-tools, --disallowedTools <tools...>', 'list', 'Comma or space-separated list of tool names to deny'],
  ['--restricted', false, 'Confine the file tools to the working directory'],
  ['--strict-mcp-config', false, 'Only use MCP servers from --mcp-config, ignoring all other MCP configurations'],
  ['--mcp-config <configs...>', 'list', 'Load MCP servers from JSON files or strings'],
  ['--permission-mode <mode>', true, 'Permission mode to use for the session (choices: "acceptEdits", "bypassPermissions", "default", "plan")'],
  ['--permission-prompts <mode>', true, 'How to handle permission prompts in print mode (choices: "none", "stdio")'],
  ['--no-session-persistence', false, 'Disable session persistence (only works with --print)'],
  ['--disable-slash-commands', false, 'Disable all slash commands'],
  ['--append-system-prompt <prompt>', true, 'Append a system prompt to the default system prompt'],
  ['--system-prompt <prompt>', true, 'System prompt to use for the session'],
  ['--model <model>', true, 'Model for the current session'],
  ['--add-dir <directories...>', 'list', 'Additional directories to allow tool access to'],
  ['-v, --version', false, 'Output the version number'],
  ['-h, --help', false, 'Display help for command'],
];

const CODEX_EXEC_OPTIONS = [
  ['-c, --config <key=value>', 'repeat', 'Override a configuration value that would otherwise be loaded from config.toml'],
  ['-m, --model <MODEL>', true, 'Model the agent should use'],
  ['-p, --profile <CONFIG_PROFILE>', true, 'Configuration profile from config.toml to specify default options'],
  ['-s, --sandbox <SANDBOX_MODE>', true, 'Select the sandbox policy to use when executing model-generated shell commands [possible values: read-only, workspace-write, danger-full-access]'],
  ['-C, --cd <DIR>', true, 'Tell the agent to use the specified directory as its working root'],
  ['-i, --image <FILE>', 'repeat', 'Optional image(s) to attach to the initial prompt'],
  ['-o, --output-last-message <FILE>', true, 'Specifies file where the last message from the agent should be written'],
  ['--output-schema <FILE>', true, 'Path to a JSON Schema file describing the model\'s final response shape'],
  ['--color <COLOR>', true, 'Specifies color settings for use in the output [possible values: always, never, auto]'],
  ['--json, --experimental-json', false, 'Print events to stdout as JSONL'],
  ['--skip-git-repo-check', false, 'Allow running Codex outside a Git repository'],
  ['--ephemeral', false, 'Run without persisting session files'],
  ['--full-auto', false, 'Convenience alias for low-friction sandboxed automatic execution'],
  ['--dangerously-bypass-approvals-and-sandbox', false, 'Skip all confirmation prompts and execute commands without sandboxing'],
  ['-V, --version', false, 'Print version'],
  ['-h, --help', false, 'Print help'],
];

function envFor(tool, name, env = process.env) {
  return env[`FAKE_${tool.toUpperCase()}_${name}`] ?? env[`FAKE_AGENT_${name}`];
}

function omittedFlags(tool) {
  return new Set((envFor(tool, 'HELP_OMIT') || '').split(',').map((s) => s.trim()).filter(Boolean));
}

function optionTable(tool) {
  const omit = omittedFlags(tool);
  const rows = tool === 'claude' ? CLAUDE_OPTIONS : CODEX_EXEC_OPTIONS;
  return rows
    .map(([spec, takes, help]) => ({ spec, takes, help, names: spec.split(/[ ,]+/).filter((s) => s.startsWith('-')) }))
    .filter((o) => !o.names.some((n) => omit.has(n)));
}

export function helpText(tool, sub) {
  const rows = optionTable(tool).map((o) => `  ${o.spec.padEnd(50)}${o.help}`);
  if (tool === 'claude') {
    return [
      'Usage: claude [options] [command] [prompt]',
      '',
      'Claude Code - starts an interactive session by default, use -p/--print for',
      'non-interactive output',
      '',
      'Arguments:',
      '  prompt                                            Your prompt',
      '',
      'Options:',
      ...rows,
      '',
    ].join('\n');
  }
  if (sub === 'exec') {
    return [
      'Run Codex non-interactively',
      '',
      'Usage: codex exec [OPTIONS] [PROMPT]',
      '',
      'Arguments:',
      '  [PROMPT]  Initial instructions for the agent. If not provided as an argument (or if `-` is used), instructions are read from stdin',
      '',
      'Options:',
      ...rows,
      '',
    ].join('\n');
  }
  return [
    'Codex CLI',
    '',
    'Usage: codex [OPTIONS] [PROMPT]',
    '       codex [OPTIONS] <COMMAND> [ARGS]',
    '',
    'Commands:',
    '  exec        Run Codex non-interactively [aliases: e]',
    '  login       Manage login',
    '  help        Print this message or the help of the given subcommand(s)',
    '',
    'Options:',
    '  -h, --help     Print help',
    '  -V, --version  Print version',
    '',
  ].join('\n');
}

export function parseArgs(tool, args) {
  const table = optionTable(tool);
  const byName = new Map();
  for (const o of table) for (const n of o.names) byName.set(n, o);
  const flags = {};
  const positionals = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-' || !a.startsWith('-')) { positionals.push(a); continue; }
    const [name, inline] = a.includes('=') && a.startsWith('--') ? [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)] : [a, undefined];
    const opt = byName.get(name);
    if (!opt) {
      const message = tool === 'claude' ? `error: unknown option '${name}'` : `error: unexpected argument '${name}' found`;
      return { error: message };
    }
    const key = opt.names[opt.names.length - 1].replace(/^-+/, '');
    if (!opt.takes) { flags[key] = true; continue; }
    if (opt.takes === 'list') {
      const values = inline !== undefined ? [inline] : [];
      while (inline === undefined && i + 1 < args.length && !args[i + 1].startsWith('-')) values.push(args[++i]);
      flags[key] = values.flatMap((v) => v.split(',')).map((v) => v.trim()).filter(Boolean);
      continue;
    }
    const value = inline !== undefined ? inline : args[++i];
    if (value === undefined) return { error: `error: option '${opt.spec}' argument missing` };
    if (opt.takes === 'repeat') (flags[key] ||= []).push(value);
    else flags[key] = value;
  }
  return { flags, positionals };
}

export function pickScenario(prompt, env = process.env) {
  const m = /\[\[fake:([\w.-]+)\]\]/.exec(prompt || '');
  if (m) return m[1];
  return env.FAKE_AGENT_SCENARIO || 'default';
}

export function loadScenario(name) {
  const file = path.isAbsolute(name) ? name : path.join(SCENARIO_DIR, `${name}.json`);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export function stepsFor(scenario, kind) {
  if (Array.isArray(scenario)) return scenario;
  return scenario[kind] || scenario.steps || [];
}

export function createTarget(prompt) {
  const m = /Write exactly one file, `([^`]+)`/.exec(prompt || '');
  return m ? m[1] : null;
}

function findWorkOrder(cwd) {
  try {
    return fs.readdirSync(cwd).find((f) => f.endsWith('.deckhand.md')) || null;
  } catch {
    return null;
  }
}

function findDeck(cwd, prompt, workorder) {
  let entries = [];
  try { entries = fs.readdirSync(cwd); } catch { /* empty */ }
  if (workorder) {
    const header = /work order: (\S+\.html?)/.exec(fs.readFileSync(path.join(cwd, workorder), 'utf8'));
    if (header && entries.includes(header[1])) return header[1];
  }
  const html = entries.filter((f) => /\.html?$/i.test(f));
  if (html.length === 1) return html[0];
  const named = (prompt.match(/[\w.-]+\.html?\b/g) || []).find((f) => html.includes(f));
  return named || html[0] || 'deck.html';
}

async function readStdin() {
  if (process.stdin.isTTY) return '';
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

function appendLog(entry) {
  const log = process.env.FAKE_AGENT_LOG;
  if (log) fs.appendFileSync(log, JSON.stringify(entry) + '\n');
}

function baseEntry(tool, mode, argv, stdin, extra = {}) {
  return {
    tool, mode, argv, cwd: process.cwd(), stdin, pid: process.pid, ppid: process.ppid,
    env: { PATH: process.env.PATH, HOME: process.env.HOME }, ...extra,
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const writeOut = (s) => new Promise((r) => process.stdout.write(s, r));
const writeErr = (s) => new Promise((r) => process.stderr.write(s, r));

async function fail(message, code) {
  await writeErr(message.endsWith('\n') ? message : message + '\n');
  process.exit(code);
}

function resolveFile(ctx, file, fallback) {
  const f = file ?? fallback;
  if (f === '$deck' || f === undefined) return ctx.deck;
  if (f === '$workorder') return ctx.workorder || 'deck.deckhand.md';
  if (f === '$target') return ctx.target || 'deck.html';
  return f;
}

function absIn(dir, file) {
  return path.isAbsolute(file) ? file : path.join(dir, file);
}

function readText(ctx, file) {
  try { return fs.readFileSync(absIn(ctx.cwd, file), 'utf8'); } catch { return null; }
}

function contentFor(step) {
  if (step.contentFrom) return fs.readFileSync(path.join(DECK_DIR, step.contentFrom), 'utf8');
  return step.content;
}

function applyChange(ctx, file, step) {
  const abs = absIn(ctx.cwd, file);
  const content = contentFor(step);
  if (content !== undefined) {
    const existed = fs.existsSync(abs);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
    return { before: '', after: content, existed };
  }
  if (step.replace) {
    const [from, to] = step.replace;
    const original = fs.readFileSync(abs, 'utf8');
    const re = step.regex ? new RegExp(from) : null;
    const match = re ? re.exec(original) : (original.includes(from) ? [from] : null);
    if (!match) return { before: from, after: to, existed: true, missed: true };
    const replaced = re ? match[0].replace(re, to) : to;
    const at = re ? match.index : original.indexOf(from);
    fs.writeFileSync(abs, original.slice(0, at) + replaced + original.slice(at + match[0].length));
    return { before: match[0], after: replaced, existed: true };
  }
  return { before: '', after: '', existed: fs.existsSync(abs) };
}

function tick(ctx, which) {
  if (!ctx.workorder) return false;
  const abs = path.join(ctx.cwd, ctx.workorder);
  let md = fs.readFileSync(abs, 'utf8');
  if (which === 'all') md = md.replace(/^- \[ \] (n_[a-z0-9]+):/gm, '- [x] $1:');
  else if (which === 'first') md = md.replace(/^- \[ \] (n_[a-z0-9]+):/m, '- [x] $1:');
  else for (const id of [].concat(which)) md = md.replace(new RegExp(`^- \\[ \\] (${id}):`, 'm'), '- [x] $1:');
  fs.writeFileSync(abs, md);
  return true;
}

function numbered(text) {
  return text.split('\n').map((l, i) => `${i + 1}\t${l}`).join('\n');
}

const claudeWire = {
  assistant(ctx, content) {
    ctx.n += 1;
    return {
      type: 'assistant',
      message: { id: `msg_fake${String(ctx.n).padStart(4, '0')}`, type: 'message', role: 'assistant', content, model: MODEL, stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } },
      parent_tool_use_id: null, session_id: ctx.sessionId, uuid: randomUUID(),
    };
  },
  toolUse(ctx, name, input) {
    const id = `toolu_fake${String(ctx.n + 1).padStart(4, '0')}`;
    return { id, line: this.assistant(ctx, [{ type: 'tool_use', id, name, input }]) };
  },
  toolResult(ctx, id, content, isError) {
    const block = { tool_use_id: id, type: 'tool_result', content };
    if (isError) block.is_error = true;
    return { type: 'user', message: { role: 'user', content: [block] }, parent_tool_use_id: null, session_id: ctx.sessionId, uuid: randomUUID() };
  },
  init(ctx) {
    return [{
      type: 'system', subtype: 'init', cwd: ctx.realCwd, session_id: ctx.sessionId,
      tools: ctx.flags.tools || ['Bash', 'Edit', 'Glob', 'Grep', 'Read', 'Write'],
      mcp_servers: [], model: MODEL, permissionMode: ctx.flags['permission-mode'] || 'default',
      slash_commands: [], apiKeySource: 'none', claude_code_version: VERSIONS.claude.split(' ')[0],
      output_style: 'default', agents: ['general-purpose', 'Explore', 'Plan'], skills: [], plugins: [], uuid: randomUUID(),
    }];
  },
  thinking(ctx, step) {
    return [
      { type: 'system', subtype: 'thinking_tokens', estimated_tokens: 12, estimated_tokens_delta: 12, session_id: ctx.sessionId, uuid: randomUUID() },
      this.assistant(ctx, [{ type: 'thinking', thinking: step.text || 'Let me read the deck and the work order first.', signature: 'fake-signature' }]),
    ];
  },
  read(ctx, step, file) {
    const abs = absIn(ctx.realCwd, file);
    const { id, line } = this.toolUse(ctx, 'Read', { file_path: abs });
    const text = readText(ctx, file);
    return [line, this.toolResult(ctx, id, text === null ? 'File does not exist.' : numbered(text), text === null)];
  },
  edit(ctx, step, file, change) {
    const abs = absIn(ctx.realCwd, file);
    const { id, line } = this.toolUse(ctx, 'Edit', { replace_all: false, file_path: abs, old_string: change.before, new_string: change.after });
    const result = change.missed ? 'String to replace not found in file.' : `The file ${abs} has been updated successfully.`;
    return [line, this.toolResult(ctx, id, result, !!change.missed)];
  },
  write(ctx, step, file, change) {
    const abs = absIn(ctx.realCwd, file);
    const { id, line } = this.toolUse(ctx, 'Write', { file_path: abs, content: change.after });
    const result = change.existed ? `The file ${abs} has been updated successfully.` : `File created successfully at: ${abs}`;
    return [line, this.toolResult(ctx, id, result)];
  },
  search(ctx, step) {
    const tool = step.tool || 'Glob';
    const pattern = step.text || '**/*.html';
    const { id, line } = this.toolUse(ctx, tool, tool === 'Grep' ? { pattern, path: ctx.realCwd } : { pattern });
    const found = fs.readdirSync(ctx.cwd).map((f) => path.join(ctx.realCwd, f)).join('\n');
    return [line, this.toolResult(ctx, id, found || 'No files found')];
  },
  blocked(ctx, step) {
    const tool = step.tool || 'Bash';
    const outside = step.file && path.isAbsolute(step.file);
    const input = tool === 'Bash' ? { command: step.text || 'ls', description: 'List files' } : { file_path: step.file || absIn(ctx.realCwd, ctx.deck) };
    const { id, line } = this.toolUse(ctx, tool, input);
    const reason = outside ? '--restricted: path outside the working directory' : `${tool} is not allowed in this session`;
    const message = outside ? `${step.file} is outside ${ctx.realCwd}; --restricted confines the file tools to the working directory.` : `Permission to use ${tool} has been denied.`;
    ctx.denials.push({ tool_name: tool, tool_use_id: id, tool_input: input });
    return [
      line,
      { type: 'system', subtype: 'permission_denied', tool_name: tool, tool_use_id: id, decision_reason_type: 'other', decision_reason: reason, message, uuid: randomUUID(), session_id: ctx.sessionId },
      this.toolResult(ctx, id, message, true),
    ];
  },
  text(ctx, step) {
    return [this.assistant(ctx, [{ type: 'text', text: step.text }])];
  },
  result(ctx, step) {
    const isError = !!step.isError;
    return [{
      type: 'result', subtype: isError ? 'error_during_execution' : 'success', is_error: isError,
      duration_ms: Date.now() - ctx.started, duration_api_ms: 0, num_turns: ctx.n || 1,
      result: step.text ?? ctx.lastText ?? 'Done.', stop_reason: 'end_turn', session_id: ctx.sessionId,
      total_cost_usd: 0, usage: { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 },
      permission_denials: ctx.denials, uuid: randomUUID(),
    }];
  },
};

const codexWire = {
  item(ctx, phase, body, id) {
    return { type: `item.${phase}`, item: { id: id || `item_${ctx.items++}`, ...body } };
  },
  command(ctx, command, output, exitCode) {
    const id = `item_${ctx.items++}`;
    const ok = exitCode === 0;
    return [
      this.item(ctx, 'started', { type: 'command_execution', command, aggregated_output: '', exit_code: null, status: 'in_progress' }, id),
      this.item(ctx, 'completed', { type: 'command_execution', command, aggregated_output: output, exit_code: exitCode, status: ok ? 'completed' : 'failed' }, id),
    ];
  },
  init(ctx) {
    return [{ type: 'thread.started', thread_id: ctx.sessionId }, { type: 'turn.started' }];
  },
  thinking(ctx, step) {
    return [this.item(ctx, 'completed', { type: 'reasoning', text: step.text || '**Reading the work order**' })];
  },
  read(ctx, step, file) {
    const text = readText(ctx, file);
    if (text === null) return this.command(ctx, `bash -lc 'cat ${file}'`, `cat: ${file}: No such file or directory\n`, 1);
    return this.command(ctx, `bash -lc 'cat ${file}'`, text, 0);
  },
  change(ctx, file, kind, status = 'completed') {
    return [this.item(ctx, 'completed', { type: 'file_change', changes: [{ path: absIn(ctx.cwd, file), kind }], status })];
  },
  edit(ctx, step, file, change) {
    return this.change(ctx, file, 'update', change.missed ? 'failed' : 'completed');
  },
  write(ctx, step, file, change) {
    return this.change(ctx, file, change.existed ? 'update' : 'add');
  },
  search(ctx, step) {
    const found = fs.readdirSync(ctx.cwd).join('\n');
    return this.command(ctx, `bash -lc 'rg --files -g ${JSON.stringify(step.text || '*.html')}'`, found ? found + '\n' : '', found ? 0 : 1);
  },
  blocked(ctx, step) {
    const tool = step.tool || 'Bash';
    if (tool === 'web_search') {
      return [this.item(ctx, 'completed', { type: 'web_search', query: step.text || 'slide deck design ideas' })];
    }
    if (tool.startsWith('mcp')) {
      return [this.item(ctx, 'completed', {
        type: 'mcp_tool_call', server: 'docs', tool: 'search', arguments: { query: step.text || 'deck' },
        result: null, error: { message: 'user cancelled MCP tool call' }, status: 'failed',
      })];
    }
    const command = step.file ? `bash -lc 'cat ${step.file}'` : `bash -lc '${step.text || 'ls'}'`;
    return [this.item(ctx, 'completed', { type: 'command_execution', command, aggregated_output: '', exit_code: null, status: 'declined' })];
  },
  text(ctx, step) {
    return [this.item(ctx, 'completed', { type: 'agent_message', text: step.text })];
  },
  result(ctx, step) {
    if (step.isError) return [{ type: 'turn.failed', error: { message: step.text || 'The turn failed.' } }];
    return [{ type: 'turn.completed', usage: { input_tokens: 1200, cached_input_tokens: 0, output_tokens: 80 } }];
  },
};

function streaming(ctx) {
  if (ctx.tool === 'claude') return ctx.flags['output-format'] === 'stream-json';
  return !!ctx.flags['experimental-json'];
}

async function emitLines(ctx, lines) {
  if (!streaming(ctx)) return;
  for (const l of lines) await writeOut(JSON.stringify(l) + '\n');
}

async function finalPlain(ctx, step) {
  if (streaming(ctx)) return;
  const text = step.text ?? ctx.lastText ?? 'Done.';
  if (ctx.tool === 'claude' && ctx.flags['output-format'] === 'json') {
    await writeOut(JSON.stringify(claudeWire.result(ctx, step)[0]) + '\n');
  } else {
    await writeOut(text + '\n');
  }
}

function ignoreTerm() {
  process.removeAllListeners('SIGTERM');
  process.on('SIGTERM', () => {});
}

async function hang(ctx, step) {
  if (step.ignoreTerm) ignoreTerm();
  if (step.child) {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    appendLog({ tool: ctx.tool, mode: 'child', pid: process.pid, childPid: child.pid });
  }
  setInterval(() => {}, 1000);
  await new Promise(() => {});
}

export async function runSteps(ctx, steps) {
  const wire = ctx.tool === 'claude' ? claudeWire : codexWire;
  let lastResultError = false;
  for (const step of steps) {
    if (step.delay) await sleep(step.delay);
    if (step.stderr !== undefined) { await writeErr(step.stderr.endsWith('\n') ? step.stderr : step.stderr + '\n'); continue; }
    if (step.exit !== undefined) process.exit(step.exit);
    if (step.hang) await hang(ctx, step);
    if (step.write !== undefined) { applyChange(ctx, resolveFile(ctx, step.write), step); continue; }
    if (step.tick !== undefined) {
      if (!tick(ctx, step.tick)) await writeErr('fake agent: no work order to tick\n');
      continue;
    }
    if (!step.emit) continue;
    const fallback = ctx.kind === 'create' ? '$target' : '$deck';
    let lines;
    if (step.emit === 'read') lines = wire.read(ctx, step, resolveFile(ctx, step.file, fallback));
    else if (step.emit === 'edit' || step.emit === 'write') {
      const file = resolveFile(ctx, step.file, fallback);
      lines = wire[step.emit](ctx, step, file, applyChange(ctx, file, step));
    } else if (step.emit === 'text') {
      ctx.lastText = step.text;
      lines = wire.text(ctx, step);
    } else if (step.emit === 'result') {
      lastResultError = !!step.isError;
      lines = wire.result(ctx, step);
      await finalPlain(ctx, step);
    } else if (wire[step.emit]) lines = wire[step.emit](ctx, step);
    else { await writeErr(`fake agent: unknown emit "${step.emit}"\n`); continue; }
    await emitLines(ctx, lines);
  }
  process.exit(lastResultError ? 1 : 0);
}

function findGitRoot(dir) {
  let d = path.resolve(dir);
  for (;;) {
    if (fs.existsSync(path.join(d, '.git'))) return d;
    const up = path.dirname(d);
    if (up === d) return null;
    d = up;
  }
}

async function versionOrHelp(tool, args) {
  const short = tool === 'claude' ? '-v' : '-V';
  const isVersion = args.includes('--version') || args.includes(short);
  const isHelp = args.includes('--help') || args.includes('-h');
  if (!isVersion && !isHelp) return false;
  appendLog(baseEntry(tool, isVersion ? 'version' : 'help', args, null));
  if (isVersion) {
    const delay = Number(envFor(tool, 'VERSION_DELAY') || 0);
    if (delay) await sleep(delay);
    await writeOut((envFor(tool, 'VERSION') ?? VERSIONS[tool]) + '\n');
  } else {
    await writeOut(helpText(tool, args[0] === 'exec' || args[0] === 'e' ? 'exec' : undefined));
  }
  process.exit(0);
}

export async function main(tool) {
  if (tool === 'claude') process.on('SIGTERM', () => process.exit(143));
  const args = process.argv.slice(2);
  await versionOrHelp(tool, args);

  let rest = args;
  if (tool === 'codex') {
    if (args[0] !== 'exec' && args[0] !== 'e') {
      appendLog(baseEntry(tool, 'unsupported', args, null));
      return fail('fake codex: only `codex exec` is supported', 2);
    }
    rest = args.slice(1);
  }
  const parsed = parseArgs(tool, rest);
  if (parsed.error) {
    appendLog(baseEntry(tool, 'run', args, null, { error: parsed.error }));
    return fail(parsed.error, tool === 'claude' ? 1 : 2);
  }
  const { flags, positionals } = parsed;

  const stdinWanted = tool === 'claude' ? positionals.length === 0 : positionals.length === 0 || positionals[0] === '-';
  const stdin = stdinWanted ? await readStdin() : '';
  const prompt = stdinWanted ? stdin : positionals.join(' ');
  const cwd = tool === 'codex' && flags.cd ? path.resolve(flags.cd) : process.cwd();
  const scenarioName = pickScenario(prompt);
  const scenario = loadScenario(scenarioName);
  const target = createTarget(prompt);
  const kind = target ? 'create' : 'edit';
  const steps = scenario ? stepsFor(scenario, kind) : [];
  if (steps.some((s) => s.hang && s.ignoreTerm)) ignoreTerm();
  appendLog(baseEntry(tool, 'run', args, stdinWanted ? stdin : null, { scenario: scenarioName }));

  if (tool === 'claude') {
    if (!flags.print) return fail('fake claude: interactive mode is not supported, pass -p', 1);
    if (flags['output-format'] === 'stream-json' && !flags.verbose) {
      return fail('Error: When using --print, --output-format=stream-json requires --verbose', 1);
    }
    if (!prompt.trim()) return fail('Error: Input must be provided either through stdin or as a prompt argument when using --print', 1);
  } else {
    if (!fs.existsSync(cwd)) return fail(`Error: failed to change directory to ${cwd}`, 1);
    if (!flags['skip-git-repo-check'] && !findGitRoot(cwd)) {
      return fail('Not inside a trusted directory and --skip-git-repo-check was not specified.', 1);
    }
    if (!prompt.trim()) return fail('No prompt provided via stdin.', 1);
  }

  if (!scenario) return fail(`fake ${tool}: unknown scenario "${scenarioName}"`, 2);

  const workorder = findWorkOrder(cwd);
  const ctx = {
    tool, flags, prompt, kind, target, cwd, realCwd: fs.realpathSync(cwd), workorder,
    deck: kind === 'edit' ? findDeck(cwd, prompt, workorder) : target,
    sessionId: randomUUID(), started: Date.now(), denials: [], items: 0, n: 0, lastText: null,
  };
  await runSteps(ctx, steps);
}
