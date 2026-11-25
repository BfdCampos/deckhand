import fs from 'node:fs';
import path from 'node:path';
import { capture, flagsIn } from './detect.js';

const TOOLS = 'Read,Edit,Write,Glob,Grep';
const OPTIONAL = [
  '--tools', '--restricted', '--strict-mcp-config', '--permission-mode', '--permission-prompts',
  '--no-session-persistence', '--disable-slash-commands', '--append-system-prompt', '--disallowed-tools',
];
const DISALLOWED = 'Bash,WebFetch,WebSearch';
const FILE_TOOLS = { Read: ['read', 'Reading'], Edit: ['edit', 'Editing'], Write: ['write', 'Writing'] };
const THINKING = 'Thinking…';

export function cwdRoots(cwd) {
  const roots = new Set([path.resolve(cwd)]);
  try { roots.add(fs.realpathSync(cwd)); } catch { /* not there */ }
  if (/^\/(tmp|var)\//.test(cwd)) roots.add(`/private${path.resolve(cwd)}`);
  return [...roots];
}

export function displayPath(file, roots) {
  const abs = String(file || '');
  for (const root of roots) {
    const rel = path.relative(root, abs);
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return { name: rel, inside: true };
  }
  return { name: abs, inside: false };
}

function blockedReason(reason) {
  const r = String(reason || '');
  if (/restricted|outside the working directory/i.test(r)) return 'outside the deck folder';
  if (!r || /not allowed|not available/i.test(r)) return 'not allowed';
  return r.length > 160 ? `${r.slice(0, 159)}…` : r;
}

function createParser({ cwd }) {
  const roots = cwdRoots(cwd);
  const pending = new Map();
  let last = null;
  let outcome = { ok: null, text: null };

  const status = (text, out) => {
    if (last?.kind === 'status' && last.text === text) return;
    out.push({ kind: 'status', text });
  };

  function toolEvent(block) {
    const input = block.input || {};
    const fileTool = FILE_TOOLS[block.name];
    if (fileTool) {
      const { name } = displayPath(input.file_path, roots);
      return { kind: fileTool[0], text: `${fileTool[1]} ${name}`, file: name, tool: block.name };
    }
    if (block.name === 'Glob' || block.name === 'Grep') {
      return { kind: 'search', text: `Searching for ${input.pattern || 'files'}`, tool: block.name };
    }
    return null;
  }

  function line(text) {
    const trimmed = String(text || '').trim();
    if (!trimmed) return [];
    let o;
    try { o = JSON.parse(trimmed); } catch { return []; }
    const out = [];
    if (o.type === 'system' && o.subtype === 'init') {
      out.push({ kind: 'status', text: 'Starting Claude Code' });
    } else if (o.type === 'system' && o.subtype === 'thinking_tokens') {
      status(THINKING, out);
    } else if (o.type === 'system' && o.subtype === 'permission_denied') {
      pending.delete(o.tool_use_id);
      const tool = o.tool_name || 'a tool';
      out.push({ kind: 'blocked', text: `Blocked: ${tool} (${blockedReason(o.decision_reason)})`, tool });
    } else if (o.type === 'assistant') {
      for (const block of o.message?.content || []) {
        if (block.type === 'thinking') status(THINKING, out);
        else if (block.type === 'text' && block.text?.trim()) out.push({ kind: 'text', text: block.text.trim() });
        else if (block.type === 'tool_use') {
          const event = toolEvent(block);
          if (event) pending.set(block.id, event);
        }
      }
    } else if (o.type === 'user') {
      for (const block of o.message?.content || []) {
        if (block.type !== 'tool_result' || !pending.has(block.tool_use_id)) continue;
        out.push(pending.get(block.tool_use_id));
        pending.delete(block.tool_use_id);
      }
    } else if (o.type === 'result') {
      const ok = o.subtype === 'success' && !o.is_error;
      const resultText = typeof o.result === 'string' ? o.result.trim() : '';
      outcome = { ok, text: resultText || null };
      const repeat = ok && resultText && last?.kind === 'text' && last.text === resultText;
      if (!repeat) out.push({ kind: ok ? 'result' : 'error', text: resultText || (ok ? 'Done.' : 'The run failed.') });
    }
    if (out.length) last = out.at(-1);
    return out;
  }

  return { line, finish: () => ({ ...outcome }) };
}

export default {
  id: 'claude',
  name: 'Claude Code',
  bin: 'claude',
  docsUrl: 'https://docs.claude.com/en/docs/claude-code/setup',

  parseVersion(stdout) {
    const m = /(\d+\.\d+\.\d+[\w.-]*)/.exec(String(stdout || ''));
    return m ? m[1] : null;
  },

  async probe(binPath, { timeoutMs, env } = {}) {
    const help = await capture(binPath, ['--help'], { timeoutMs, env });
    return { flags: help.code === 0 ? flagsIn(help.stdout, OPTIONAL) : null };
  },

  invocation({ prompt, guardrail, flags }) {
    const has = (f) => !flags || flags.has(f);
    const args = ['-p', '--output-format', 'stream-json', '--verbose'];
    args.push('--tools', TOOLS);
    if (has('--restricted')) args.push('--restricted');
    else if (has('--disallowed-tools')) args.push('--disallowed-tools', DISALLOWED);
    if (has('--strict-mcp-config')) args.push('--strict-mcp-config');
    if (has('--permission-mode')) args.push('--permission-mode', 'acceptEdits');
    if (has('--permission-prompts')) args.push('--permission-prompts', 'none');
    if (has('--no-session-persistence')) args.push('--no-session-persistence');
    if (has('--disable-slash-commands')) args.push('--disable-slash-commands');
    if (has('--append-system-prompt')) {
      args.push('--append-system-prompt', guardrail);
      return { args, stdin: prompt };
    }
    return { args, stdin: `${guardrail}\n\n${prompt}` };
  },

  blocker(flags) {
    if (flags && !flags.has('--tools')) {
      return 'This version of Claude Code is too old for Deckhand. Update it with `claude update`, then click Check again.';
    }
    return null;
  },

  missingFlags(flags) {
    return flags ? OPTIONAL.filter((f) => !flags.has(f) && f !== '--disallowed-tools' && f !== '--tools') : [];
  },

  createParser,
};
