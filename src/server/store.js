import fsp from 'node:fs/promises';
import path from 'node:path';

const STORED = 50;
const SHOWN = 8;

const empty = () => ({ version: 1, agent: null, recents: [] });

async function realOrResolved(p) {
  try { return await fsp.realpath(p); } catch { return path.resolve(p); }
}

async function isFile(p) {
  try { return (await fsp.stat(p)).isFile(); } catch { return false; }
}

function sanitise(raw) {
  const data = empty();
  if (!raw || typeof raw !== 'object') return data;
  if (typeof raw.agent === 'string' && raw.agent) data.agent = raw.agent;
  const seen = new Set();
  for (const r of Array.isArray(raw.recents) ? raw.recents : []) {
    if (!r || typeof r.path !== 'string' || !path.isAbsolute(r.path) || seen.has(r.path)) continue;
    seen.add(r.path);
    const openedAt = Number.isNaN(Date.parse(r.openedAt)) ? new Date(0).toISOString() : r.openedAt;
    data.recents.push({ path: r.path, openedAt });
    if (data.recents.length >= STORED) break;
  }
  return data;
}

export function createStore({ stateDir }) {
  const file = path.join(stateDir, 'state.json');
  let data = empty();
  let chain = Promise.resolve();

  async function load() {
    let text;
    try {
      text = await fsp.readFile(file, 'utf8');
    } catch {
      data = empty();
      return data;
    }
    try {
      data = sanitise(JSON.parse(text));
    } catch {
      data = empty();
      const backup = `${file}.corrupt-${Date.now()}`;
      await fsp.rename(file, backup).catch(() => {});
      console.error('[deckhand] state file was unreadable; started fresh and kept a copy next to it.');
    }
    return data;
  }

  async function write() {
    await fsp.mkdir(stateDir, { recursive: true, mode: 0o700 });
    await fsp.chmod(stateDir, 0o700).catch(() => {});
    const tmp = `${file}.${process.pid}.deckhand-tmp`;
    await fsp.writeFile(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
    await fsp.rename(tmp, file);
  }

  function mutate(fn) {
    const next = chain.then(async () => {
      await fn();
      await write();
    });
    chain = next.catch((e) => console.error('[deckhand] could not save state:', e.message));
    return next;
  }

  async function recents({ limit = SHOWN } = {}) {
    await chain;
    const items = data.recents.slice(0, limit);
    return Promise.all(items.map(async (r) => ({
      path: r.path,
      name: path.basename(r.path),
      dir: path.dirname(r.path),
      openedAt: r.openedAt,
      missing: !(await isFile(r.path)),
    })));
  }

  async function addRecent(p) {
    const real = await realOrResolved(p);
    await mutate(async () => {
      const keep = [];
      for (const r of data.recents) if ((await realOrResolved(r.path)) !== real && r.path !== real) keep.push(r);
      data.recents = [{ path: real, openedAt: new Date().toISOString() }, ...keep].slice(0, STORED);
    });
  }

  async function removeRecent(p, { limit = SHOWN } = {}) {
    if (typeof p === 'string' && p) {
      const real = await realOrResolved(p);
      await mutate(async () => {
        const keep = [];
        for (const r of data.recents) if (r.path !== p && r.path !== real && (await realOrResolved(r.path)) !== real) keep.push(r);
        data.recents = keep;
      });
    }
    return recents({ limit });
  }

  return {
    load,
    recents,
    addRecent,
    removeRecent,
    getAgent: () => data.agent,
    setAgent: (id) => mutate(async () => { data.agent = id || null; }),
    get: () => ({ ...data, recents: data.recents.map((r) => ({ ...r })) }),
    path: file,
  };
}
