import path from 'node:path';
import { capture, flagsIn } from './detect.js';
import { cwdRoots, displayPath } from './claude.js';

const OPTIONAL = ['--json', '--experimental-json', '--sandbox', '--cd', '--skip-git-repo-check', '--ephemeral', '--config'];
const FILE_TOKEN = /[\w.@-]+\.(?:html?|md|css|js|json|txt|svg|png|jpe?g|gif|webp)$/i;
const THINKING = 'Thinking…';
const CHANGE = { update: ['edit', 'Editing'], add: ['write', 'Writing'], delete: ['write', 'Deleting'] };

function unwrap(command) {
  const c = Array.isArray(command) ? command.join(' ') : String(command || '');
  const m = /^(?:\/\S*\/)?(?:ba|z)?sh\s+-l?c\s+(['"]?)([\s\S]*)\1$/.exec(c.trim());
  return (m ? m[2] : c).trim();
}

function fileIn(command) {
  for (const raw of command.split(/\s+/)) {
    const token = raw.replace(/^['"]|['"]$/g, '');
    if (token.startsWith('-') || !FILE_TOKEN.test(token)) continue;
    return token;
  }
  return null;
}

function createParser({ cwd }) {
  const roots = cwdRoots(cwd);
  const seen = new Set();
  let last = null;
  let lastMessage = null;
  let errorText = null;
  let outcome = { ok: null, text: null };

  function itemEvents(item, out) {
    if (item.type === 'reasoning') {
      if (!(last?.kind === 'status' && last.text === THINKING)) out.push({ kind: 'status', text: THINKING });
      return;
    }
    if (item.type === 'agent_message') {
      if (item.text?.trim()) {
        lastMessage = item.text.trim();
        out.push({ kind: 'text', text: lastMessage });
      }
      return;
    }
    if (item.type === 'command_execution') {
      const command = unwrap(item.command);
      if (item.status === 'declined') {
        out.push({ kind: 'blocked', text: `Blocked: ${command} (not allowed)`, tool: 'shell' });
        return;
      }
      const file = fileIn(command);
      if (file) {
        const { name } = displayPath(path.resolve(roots[0], file), roots);
        out.push({ kind: 'read', text: `Reading ${name}`, file: name, tool: 'shell' });
      } else {
        out.push({ kind: 'search', text: 'Looking through the files', tool: 'shell' });
      }
      return;
    }
    if (item.type === 'file_change') {
      for (const change of item.changes || []) {
        const [kind, verb] = CHANGE[change.kind] || CHANGE.update;
        const { name } = displayPath(change.path, roots);
        out.push({ kind, text: `${verb} ${name}`, file: name, tool: 'apply_patch' });
      }
      return;
    }
    if (item.type === 'mcp_tool_call') {
      const tool = item.tool || 'MCP tool';
      out.push({ kind: 'blocked', text: `Blocked: ${tool} (not allowed)`, tool });
      return;
    }
    if (item.type === 'web_search') {
      out.push({ kind: 'blocked', text: 'Blocked: web search (not allowed)', tool: 'web_search' });
    }
  }

  function line(text) {
    const trimmed = String(text || '').trim();
    if (!trimmed) return [];
    let o;
    try { o = JSON.parse(trimmed); } catch { return []; }
    const out = [];
    if (o.type === 'thread.started') {
      out.push({ kind: 'status', text: 'Starting Codex' });
    } else if (/^item\.(started|updated|completed)$/.test(o.type) && o.item) {
      const id = o.item.id;
      const once = o.item.type !== 'reasoning' && o.item.type !== 'agent_message';
      if (once && seen.has(id)) return [];
      if (o.item.type === 'agent_message' && o.type !== 'item.completed') return [];
      if (o.item.type === 'file_change' && o.type !== 'item.completed') return [];
      if (once) seen.add(id);
      itemEvents(o.item, out);
    } else if (o.type === 'error') {
      errorText = String(o.message || 'The run failed.');
    } else if (o.type === 'turn.failed') {
      const message = String(o.error?.message || errorText || 'The run failed.');
      outcome = { ok: false, text: message };
      out.push({ kind: 'error', text: message });
    } else if (o.type === 'turn.completed') {
      outcome = { ok: true, text: lastMessage };
      out.push({ kind: 'result', text: 'Done.' });
    }
    if (out.length) last = out.at(-1);
    return out;
  }

  return {
    line,
    finish: () => (outcome.ok === null && errorText ? { ok: false, text: errorText } : { ...outcome }),
  };
}

export default {
  id: 'codex',
  name: 'Codex',
  bin: 'codex',
  docsUrl: 'https://developers.openai.com/codex/cli',

  parseVersion(stdout) {
    const m = /(\d+\.\d+\.\d+[\w.-]*)/.exec(String(stdout || ''));
    return m ? m[1] : null;
  },

  async probe(binPath, { timeoutMs, env } = {}) {
    const help = await capture(binPath, ['exec', '--help'], { timeoutMs, env });
    return { flags: help.code === 0 ? flagsIn(help.stdout, OPTIONAL) : null };
  },

  invocation({ prompt, guardrail, cwd, flags }) {
    const has = (f) => !flags || flags.has(f);
    const json = has('--json') ? '--json' : '--experimental-json';
    const args = ['exec', json, '--sandbox', 'workspace-write', '--cd', cwd, '--skip-git-repo-check'];
    if (has('--ephemeral')) args.push('--ephemeral');
    args.push(
      '--config', 'approval_policy="never"',
      '--config', 'sandbox_workspace_write.network_access=false',
      '--config', 'web_search="disabled"',
      '-',
    );
    return { args, stdin: `${guardrail}\n\n${prompt}` };
  },

  blocker(flags) {
    if (flags && (!flags.has('--sandbox') || !flags.has('--cd') || (!flags.has('--json') && !flags.has('--experimental-json')))) {
      return 'This version of Codex is too old for Deckhand. Update it, then click Check again.';
    }
    return null;
  },

  missingFlags(flags) {
    if (!flags) return [];
    const missing = ['--sandbox', '--cd', '--skip-git-repo-check', '--ephemeral', '--config'].filter((f) => !flags.has(f));
    if (!flags.has('--json') && !flags.has('--experimental-json')) missing.push('--json');
    return missing;
  },

  createParser,
};
