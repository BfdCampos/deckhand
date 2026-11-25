import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mockRuns } from './runs-mock.js';

// Stand-ins for the WP4.2 Home routes (recents, Browse listing, open
// validation) and WP3.1's create target, built on the real temp HOME. Opening
// a valid deck still goes to the real server. Swap for the real routes once
// feat/home-server and feat/agent-runs-server land.

const OPEN_STOP = new Set(['a', 'an', 'the', 'make', 'create', 'me']);

export function slugFor(description) {
  const words = String(description || '').toLowerCase().normalize('NFKD').replace(/[^\x00-\x7f]/g, '')
    .replace(/[^a-z0-9\s-]/g, ' ').split(/[\s-]+/).filter(Boolean);
  while (words.length && OPEN_STOP.has(words[0])) words.shift();
  let slug = '';
  for (const w of words.slice(0, 6)) {
    const next = slug ? `${slug}-${w}` : w;
    if (next.length > 48) break;
    slug = next;
  }
  return slug || 'untitled-deck';
}

function crumbsFor(p) {
  const crumbs = [{ name: '/', path: '/' }];
  let acc = '';
  for (const part of p.split(path.sep).filter(Boolean)) {
    acc += path.sep + part;
    crumbs.push({ name: part, path: acc });
  }
  return crumbs;
}

const tildify = (p, home) => (p === home ? '~' : p.startsWith(home + path.sep) ? `~${p.slice(home.length)}` : p);

export async function mockHome(page, deckhand, { recents = [], agents = ['claude'], selected = 'claude', run = null, activity = [] } = {}) {
  const home = fs.realpathSync(deckhand.home);
  const decksDir = path.join(home, 'Deckhand');
  const state = { recents: recents.map((r) => ({ openedAt: new Date().toISOString(), ...r })), removed: [], opened: [] };

  const target = (description) => {
    const slug = slugFor(description);
    for (let n = 1; ; n++) {
      const p = path.join(decksDir, n === 1 ? `${slug}.html` : `${slug}-${n}.html`);
      if (!fs.existsSync(p)) return p;
    }
  };

  const sampleDeck = path.join(home, 'checkout', 'samples', 'sample-deck.html');
  fs.mkdirSync(path.dirname(sampleDeck), { recursive: true });
  fs.copyFileSync(fileURLToPath(new URL('../../samples/sample-deck.html', import.meta.url)), sampleDeck);

  const runs = await mockRuns(page, {
    deckPath: null,
    agents,
    selected,
    run,
    activity,
    createTarget: target,
    extraState: () => ({ decksDir, decksDirLabel: tildify(decksDir, home), home, sampleDeck }),
  });

  const json = (route, status, body) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  const error = (route, status, code, message) => json(route, status, { error: { code, message } });

  const items = () => state.recents.map((r) => ({
    path: r.path,
    name: path.basename(r.path),
    dir: path.dirname(r.path),
    openedAt: r.openedAt,
    missing: !fs.existsSync(r.path),
  }));

  await page.route((url) => ['/api/recents', '/api/recents/remove', '/api/fs', '/api/open', '/api/create/target'].includes(url.pathname), async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const p = url.pathname;
    let body = null;
    if (req.method() === 'POST') { try { body = req.postDataJSON(); } catch { body = null; } }
    runs.calls.push({ method: req.method(), path: p, body, query: Object.fromEntries(url.searchParams) });

    if (p === '/api/recents') return json(route, 200, { items: items() });
    if (p === '/api/recents/remove') {
      state.recents = state.recents.filter((r) => r.path !== body?.path);
      state.removed.push(body?.path);
      return json(route, 200, { items: items() });
    }
    if (p === '/api/create/target') {
      const t = target(url.searchParams.get('description') || '');
      return json(route, 200, { path: t, display: tildify(t, home) });
    }
    if (p === '/api/fs') {
      const dir = url.searchParams.get('dir') || (fs.existsSync(decksDir) ? decksDir : home);
      let real;
      try { real = fs.realpathSync(dir); } catch { return error(route, 400, 'not_found', "Can't find that folder."); }
      const entries = fs.readdirSync(real, { withFileTypes: true })
        .filter((d) => !d.name.startsWith('.'))
        .map((d) => ({ name: d.name, kind: d.isDirectory() ? 'dir' : /\.html?$/i.test(d.name) ? 'deck' : null }))
        .filter((e) => e.kind)
        .sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'dir' ? -1 : 1))
        .map((e) => ({ ...e, path: path.join(real, e.name), isDir: e.kind === 'dir', isHtml: e.kind === 'deck' }));
      return json(route, 200, { path: real, parent: real === '/' ? null : path.dirname(real), home, crumbs: crumbsFor(real), entries });
    }
    if (p === '/api/open') {
      const raw = String(body?.path || '').trim();
      const abs = raw.startsWith('~/') ? path.join(home, raw.slice(2)) : path.resolve(home, raw);
      let st;
      try { st = fs.statSync(abs); } catch { return error(route, 400, 'not_found', 'not found'); }
      if (st.isDirectory()) return error(route, 400, 'is_dir', 'is dir');
      if (!/\.html?$/i.test(abs)) return error(route, 400, 'not_html', 'not html');
      try { fs.accessSync(abs, fs.constants.R_OK); } catch { return error(route, 400, 'unreadable', 'unreadable'); }
      if (!fs.readFileSync(abs, 'utf8').trim()) return error(route, 400, 'empty', 'empty');
      state.opened.push(abs);
      const real = state.recents.filter((r) => r.path !== abs);
      state.recents = [{ path: abs, openedAt: new Date().toISOString() }, ...real];
      const res = await route.fetch({ postData: JSON.stringify({ path: abs }) });
      return route.fulfill({ response: res });
    }
    return route.fallback();
  });

  return Object.assign(runs, { home, decksDir, sampleDeck, homeState: state, target });
}
