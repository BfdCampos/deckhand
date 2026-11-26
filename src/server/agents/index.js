import claude from './claude.js';
import codex from './codex.js';
import { DETECT_TIMEOUT_MS, detectOne, searchDirs } from './detect.js';
import { HttpError } from '../security.js';

export const ADAPTERS = [claude, codex];
const byId = Object.fromEntries(ADAPTERS.map((a) => [a.id, a]));

export function createAgents({ config, store, broadcast = () => {}, env = process.env, timeoutMs = DETECT_TIMEOUT_MS, log = console.warn }) {
  let found = {};

  async function detect() {
    const dirs = searchDirs(env.PATH || '', config.extraBinDirs || []);
    const results = await Promise.all(ADAPTERS.map((a) => detectOne(a, { dirs, env, timeoutMs })));
    found = Object.fromEntries(results.filter((r) => r.found).map((r) => [r.id, r]));
    for (const r of results) {
      if (!r.found) continue;
      const blocked = byId[r.id].blocker(r.flags);
      if (blocked) {
        log(`[deckhand] ${blocked}`);
        continue;
      }
      const missing = byId[r.id].missingFlags(r.flags);
      if (missing.length) log(`[deckhand] ${byId[r.id].name} doesn't list ${missing.join(', ')}; running without ${missing.length > 1 ? 'them' : 'it'}.`);
    }
    const p = payload();
    broadcast({ type: 'agents', agents: p });
    return p;
  }

  function selectedId() {
    const chosen = store.get()?.agent;
    if (chosen && found[chosen]) return chosen;
    return ADAPTERS.find((a) => found[a.id])?.id ?? null;
  }

  function payload() {
    return {
      selected: selectedId(),
      list: ADAPTERS.map((a) => ({
        id: a.id,
        name: a.name,
        found: !!found[a.id],
        version: found[a.id]?.version ?? null,
        docsUrl: a.docsUrl,
      })),
    };
  }

  function selected() {
    const id = selectedId();
    if (!id) return null;
    const r = found[id];
    return { adapter: byId[id], path: r.path, version: r.version, flags: r.flags };
  }

  async function select(id) {
    if (!byId[id] || !found[id]) throw new HttpError(400, 'unknown_agent', "That agent isn't installed.");
    await store.update({ agent: id });
    const p = payload();
    broadcast({ type: 'agents', agents: p });
    return p;
  }

  function launchLine() {
    const id = selectedId();
    if (!id) return 'none found';
    const label = (a) => (found[a.id]?.version ? `${a.name} ${found[a.id].version}` : a.name);
    const others = ADAPTERS.filter((a) => a.id !== id).map((a) => (found[a.id] ? `${label(a)} also found` : `${a.name} not found`));
    return `${label(byId[id])} (${others.join(', ')})`;
  }

  function routes({ isBusy = () => false } = {}) {
    return {
      'POST /api/agents/detect': async () => ({ agents: await detect() }),
      'POST /api/agents/select': async ({ body }) => {
        if (isBusy()) throw new HttpError(409, 'busy', 'Wait for the current run to finish first.');
        return { agents: await select(body?.id) };
      },
    };
  }

  return { detect, payload, selected, select, launchLine, routes };
}
