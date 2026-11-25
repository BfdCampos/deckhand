import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HttpError } from './security.js';

export const OPEN_COPY = {
  not_found: "Can't find that file.",
  not_html: "That's not an HTML file. Deckhand opens .html decks.",
  is_dir: "That's a folder. Pick an .html file inside it.",
  empty: 'That file is empty.',
  unreadable: "Deckhand can't read that file (permission denied).",
};

const FOLDER_COPY = {
  not_found: "Can't find that folder.",
  not_dir: "That's a file, not a folder.",
  unreadable: "Deckhand can't open that folder (permission denied).",
};

const MAX_ENTRIES = 5000;
const DECK_RE = /\.html?$/i;
const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

const openError = (code) => new HttpError(400, code, OPEN_COPY[code]);
const folderError = (code) => new HttpError(400, code, FOLDER_COPY[code]);

export function expandPath(input, home) {
  let p = String(input).trim();
  if (p.length > 1 && ((p.startsWith('"') && p.endsWith('"')) || (p.startsWith("'") && p.endsWith("'")))) p = p.slice(1, -1);
  if (/^file:\/\//i.test(p)) {
    try { p = fileURLToPath(p); } catch {}
  } else {
    p = p.replace(/\\([ ()'"&!$`;,[\]{}#])/g, '$1');
  }
  if (p === '~') p = home;
  else if (p.startsWith('~/')) p = path.join(home, p.slice(2));
  return path.resolve(home, p);
}

export function tildify(p, home) {
  if (p === home) return '~';
  return p.startsWith(home + path.sep) ? '~' + p.slice(home.length) : p;
}

export async function validateDeckPath(input, { home }) {
  if (typeof input !== 'string' || !input.trim()) throw openError('not_found');
  const abs = expandPath(input, home);
  let st;
  try {
    st = await fsp.stat(abs);
  } catch (e) {
    throw openError(e.code === 'EACCES' || e.code === 'EPERM' ? 'unreadable' : 'not_found');
  }
  if (st.isDirectory()) throw openError('is_dir');
  if (!DECK_RE.test(abs)) throw openError('not_html');
  if (!st.isFile()) throw openError('unreadable');
  let real;
  let buf;
  try {
    real = await fsp.realpath(abs);
    buf = await fsp.readFile(real);
  } catch (e) {
    throw openError(e.code === 'ENOENT' ? 'not_found' : 'unreadable');
  }
  if (!buf.toString('utf8').trim()) throw openError('empty');
  return { real, buf, mode: st.mode & 0o7777 };
}

async function kindOf(dir, dirent) {
  if (dirent.isDirectory()) return 'dir';
  if (dirent.isFile()) return DECK_RE.test(dirent.name) ? 'deck' : null;
  if (!dirent.isSymbolicLink()) return null;
  try {
    const st = await fsp.stat(path.join(dir, dirent.name));
    if (st.isDirectory()) return 'dir';
    return st.isFile() && DECK_RE.test(dirent.name) ? 'deck' : null;
  } catch {
    return null;
  }
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

export async function listDir(dir, { home }) {
  const abs = expandPath(dir || home, home);
  let real;
  try {
    const st = await fsp.stat(abs);
    if (!st.isDirectory()) throw folderError('not_dir');
    real = await fsp.realpath(abs);
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw folderError(e.code === 'EACCES' || e.code === 'EPERM' ? 'unreadable' : 'not_found');
  }
  let dirents;
  try {
    dirents = await fsp.readdir(real, { withFileTypes: true });
  } catch (e) {
    throw folderError(e.code === 'ENOENT' ? 'not_found' : 'unreadable');
  }
  const visible = dirents.filter((d) => !d.name.startsWith('.'));
  const kinds = await Promise.all(visible.map((d) => kindOf(real, d)));
  const entries = visible
    .map((d, i) => ({ name: d.name, kind: kinds[i] }))
    .filter((e) => e.kind)
    .sort((a, b) => (a.kind === b.kind ? collator.compare(a.name, b.name) : a.kind === 'dir' ? -1 : 1));
  return {
    path: real,
    parent: real === path.parse(real).root ? null : path.dirname(real),
    home,
    crumbs: crumbsFor(real),
    truncated: entries.length > MAX_ENTRIES,
    entries: entries.slice(0, MAX_ENTRIES).map((e) => ({
      name: e.name,
      path: path.join(real, e.name),
      kind: e.kind,
      isDir: e.kind === 'dir',
      isHtml: e.kind === 'deck',
    })),
  };
}

async function isDir(p) {
  try { return (await fsp.stat(p)).isDirectory(); } catch { return false; }
}

export async function startFolder({ store, decksDir, home }) {
  for (const r of await store.recents({ limit: 50 })) {
    if (!r.missing && (await isDir(r.dir))) return r.dir;
  }
  if (await isDir(decksDir)) return decksDir;
  return home;
}

export async function nextFreeName(dir, slug, { taken = new Set() } = {}) {
  for (let n = 1; ; n++) {
    const name = n === 1 ? `${slug}.html` : `${slug}-${n}.html`;
    const p = path.join(dir, name);
    if (taken.has(p)) continue;
    try {
      await fsp.lstat(p);
    } catch (e) {
      if (e.code === 'ENOENT') return { name, path: p };
      throw e;
    }
  }
}
