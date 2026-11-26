import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { HttpError } from './security.js';

const ID_RE = /^n_[a-z0-9]+$/;
const TICK_RE = /^- \[( |x|X)\] (n_[a-z0-9]+):/gm;

const LABELS = {
  h1: ['heading', 'headings'], h2: ['heading', 'headings'], h3: ['heading', 'headings'],
  h4: ['heading', 'headings'], h5: ['heading', 'headings'], h6: ['heading', 'headings'],
  p: ['paragraph', 'paragraphs'], li: ['list item', 'list items'], img: ['image', 'images'],
  blockquote: ['quote', 'quotes'], figcaption: ['caption', 'captions'], section: ['slide', 'slides'],
};

export function truncate(s, n) {
  s = String(s).replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n) + '…' : s;
}

const newId = () => 'n_' + crypto.randomBytes(4).toString('hex');
const now = () => new Date().toISOString();
const closed = () => new HttpError(409, 'deck_closed', 'No deck is open.');

function label(tag, plural = false) {
  const l = LABELS[String(tag || '').toLowerCase()];
  if (l) return l[plural ? 1 : 0];
  return tag ? `<${tag}> element${plural ? 's' : ''}` : plural ? 'elements' : 'element';
}

function describe(n) {
  const where = n.slide != null ? ` on slide ${n.slide}` : '';
  const current = n.targetText ? `, currently "${truncate(n.targetText, 80)}"` : '';
  if (n.scope === 'global') {
    return `all similar ${label(n.targetTag, true)} across the deck (for example data-ai-id="${n.aiId}"${where}${current})`;
  }
  return `${label(n.targetTag)}${where} (data-ai-id="${n.aiId}")${current}`;
}

function describeTweak(aiId, t) {
  const parts = [];
  if (t.dx !== undefined) parts.push(`moved by (${t.dx}, ${t.dy ?? 0}) px`);
  if (t.w !== undefined || t.h !== undefined) parts.push(`resized to ${t.w ?? 'auto'}×${t.h ?? 'auto'} px`);
  return `- ${aiId} (${t.tag || 'element'}): ${parts.join(', ')}`;
}

function str(v, max) {
  return typeof v === 'string' ? v.slice(0, max) : null;
}

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function cleanNote(input, existing) {
  const text = typeof input.text === 'string' ? input.text.trim() : '';
  if (!text) throw new HttpError(400, 'empty_note', 'Write something for the AI first.');
  if (text.length > 5000) throw new HttpError(400, 'note_too_long', 'That note is too long.');
  const t = now();
  return {
    id: existing.has(input.id) || !ID_RE.test(input.id || '') ? uniqueId(existing) : input.id,
    aiId: str(input.aiId, 64),
    targetTag: str(input.targetTag, 32)?.toLowerCase() ?? null,
    targetText: str(input.targetText, 500),
    scope: input.scope === 'global' ? 'global' : 'element',
    text,
    slide: Number.isInteger(input.slide) ? input.slide : null,
    docX: num(input.docX),
    docY: num(input.docY),
    status: 'open',
    createdAt: t,
    updatedAt: t,
    doneAt: null,
    doneBy: null,
  };
}

function uniqueId(existing) {
  for (;;) {
    const id = newId();
    if (!existing.has(id)) return id;
  }
}

function migrate(data) {
  const notes = [];
  const seen = new Set();
  for (const n of Array.isArray(data?.notes) ? data.notes : []) {
    if (!n || typeof n !== 'object' || typeof n.text !== 'string' || !n.text.trim()) continue;
    const id = ID_RE.test(n.id || '') && !seen.has(n.id) ? n.id : uniqueId(seen);
    seen.add(id);
    notes.push({
      id,
      aiId: str(n.aiId, 64),
      targetTag: str(n.targetTag, 32),
      targetText: str(n.targetText, 500),
      scope: n.scope === 'global' ? 'global' : 'element',
      text: n.text,
      slide: Number.isInteger(n.slide) ? n.slide : null,
      docX: num(n.docX),
      docY: num(n.docY),
      status: n.status === 'done' ? 'done' : 'open',
      createdAt: n.createdAt || null,
      updatedAt: n.updatedAt || null,
      doneAt: n.status === 'done' ? n.doneAt || null : null,
      doneBy: n.status === 'done' ? n.doneBy || null : null,
    });
  }
  const tweaks = {};
  const raw = data?.layoutTweaks;
  const entries = Array.isArray(raw) ? raw.map((t) => [t?.aiId, t]) : raw && typeof raw === 'object' ? Object.entries(raw) : [];
  for (const [aiId, t] of entries) {
    if (typeof aiId !== 'string' || !t || typeof t !== 'object') continue;
    const tweak = { kind: t.kind, tag: t.tag || (t.kind === 'resize' ? 'img' : undefined) };
    if (num(t.dx) !== null) { tweak.dx = Math.round(t.dx); tweak.dy = Math.round(num(t.dy) ?? 0); }
    if (num(t.w) !== null) tweak.w = Math.round(t.w);
    if (num(t.h) !== null) tweak.h = Math.round(t.h);
    if (tweak.tag === undefined) delete tweak.tag;
    if (tweak.kind === 'move' || tweak.kind === 'resize') tweaks[aiId] = tweak;
  }
  return { notes, tweaks };
}

async function writeAtomic(file, text) {
  const tmp = `${file}.deckhand-tmp`;
  await fsp.writeFile(tmp, text, 'utf8');
  await fsp.rename(tmp, file);
}

export function createNotes({ hub }) {
  let meta = null;
  let files = null;
  let notes = [];
  let tweaks = {};
  let rev = 0;
  let locked = false;
  let chain = Promise.resolve();

  const snapshot = () => ({ deckId: meta?.deckId ?? null, notes: notes.map((n) => ({ ...n })), layoutTweaks: { ...tweaks }, rev });
  const broadcast = () => hub?.broadcast({ type: 'notes', ...snapshot() });

  async function load() {
    let data = null;
    try {
      data = JSON.parse(await fsp.readFile(files.json, 'utf8'));
    } catch {}
    ({ notes, tweaks } = migrate(data));
  }

  async function bind(nextMeta) {
    await chain;
    meta = nextMeta || null;
    notes = [];
    tweaks = {};
    locked = false;
    if (!meta) { files = null; return; }
    const stem = meta.name.replace(/\.html?$/i, '');
    files = { json: path.join(meta.dir, `${stem}.deckhand.json`), md: path.join(meta.dir, `${stem}.deckhand.md`) };
    await load();
    rev++;
  }

  function renderWorkOrder({ noteIds } = {}) {
    const wanted = noteIds ? new Set(noteIds) : null;
    const open = notes.filter((n) => n.status === 'open' && (!wanted || wanted.has(n.id)));
    const L = [
      `# Deckhand work order: ${meta?.name ?? 'deck'}`,
      '',
      `A person is editing this deck in Deckhand and left these notes. Apply each one as a precise edit to ${meta?.name ?? 'the deck'}, keeping its structure and style system. Keep every data-ai-id attribute. When you have applied a note, tick its box by changing "- [ ]" to "- [x]". Don't edit anything else in this file.`,
      '',
      '## Notes',
      '',
    ];
    if (!open.length) L.push('No open notes.', '');
    for (const n of open) {
      L.push(`- [ ] ${n.id}: ${describe(n)}`);
      for (const line of n.text.split(/\r?\n/)) L.push(`  ${line}`);
      L.push('');
    }
    const tweakIds = wanted ? [] : Object.keys(tweaks);
    if (tweakIds.length) {
      L.push('## Layout tweaks', '');
      L.push("The person nudged these by hand. Treat them as intent and reconcile them with the layout; don't hard-code pixel offsets where a cleaner fix fits.", '');
      for (const id of tweakIds) L.push(describeTweak(id, tweaks[id]));
      L.push('');
    }
    return L.join('\n');
  }

  function persist() {
    rev++;
    const json = JSON.stringify({ version: 2, deck: meta.name, notes, layoutTweaks: tweaks }, null, 2) + '\n';
    const md = renderWorkOrder();
    const target = files;
    chain = chain.then(async () => {
      await writeAtomic(target.json, json);
      await writeAtomic(target.md, md);
    });
    const done = chain;
    chain = chain.catch((e) => console.error('[deckhand] notes write failed:', e.message));
    broadcast();
    return done;
  }

  function guard() {
    if (!meta) throw closed();
    if (meta.readOnly) throw new HttpError(403, 'read_only', 'This deck is read-only.');
  }

  async function apply(op) {
    guard();
    if (locked) throw new HttpError(423, 'run_active', 'Notes are locked while the agent is working.');
    const ids = new Set(notes.map((n) => n.id));
    const find = (id) => {
      const n = notes.find((x) => x.id === id);
      if (!n) throw new HttpError(404, 'no_note', 'That note no longer exists.');
      return n;
    };
    switch (op?.op) {
      case 'add':
        if (!op.note || typeof op.note !== 'object') throw new HttpError(400, 'bad_op', 'Missing note.');
        notes.push(cleanNote({ ...op.note, id: undefined }, ids));
        break;
      case 'edit': {
        const n = find(op.id);
        const text = typeof op.text === 'string' ? op.text.trim() : '';
        if (!text) throw new HttpError(400, 'empty_note', 'Write something for the AI first.');
        if (text.length > 5000) throw new HttpError(400, 'note_too_long', 'That note is too long.');
        Object.assign(n, { text, status: 'open', doneAt: null, doneBy: null, updatedAt: now() });
        break;
      }
      case 'delete':
        find(op.id);
        notes = notes.filter((n) => n.id !== op.id);
        break;
      default:
        throw new HttpError(400, 'bad_op', 'Unknown note change.');
    }
    await persist();
    return { notes: snapshot().notes, rev };
  }

  async function setTweak(aiId, tweak) {
    if (!meta) throw closed();
    if (tweak) tweaks[aiId] = { ...tweak };
    else if (aiId in tweaks) delete tweaks[aiId];
    else return;
    await persist();
  }

  async function clearTweaks() {
    if (!meta || !Object.keys(tweaks).length) return;
    tweaks = {};
    await persist();
  }

  function parseTicks(md) {
    const out = new Set();
    for (const m of String(md).matchAll(TICK_RE)) if (m[1] !== ' ') out.add(m[2]);
    return out;
  }

  async function markDone(ids, by) {
    if (!meta) throw closed();
    const wanted = new Set(ids);
    const changed = [];
    const t = now();
    for (const n of notes) {
      if (wanted.has(n.id) && n.status === 'open') {
        Object.assign(n, { status: 'done', doneAt: t, doneBy: by || null, updatedAt: t });
        changed.push(n.id);
      }
    }
    if (changed.length) await persist();
    return changed;
  }

  async function reloadFromDisk() {
    if (!meta) return;
    await chain;
    await load();
    rev++;
    broadcast();
  }

  async function write() {
    if (!meta) throw closed();
    await persist();
  }

  return {
    bind,
    list: () => snapshot().notes,
    tweaks: () => ({ ...tweaks }),
    snapshot,
    apply,
    setTweak,
    lock: () => { locked = true; },
    unlock: () => { locked = false; },
    isLocked: () => locked,
    renderWorkOrder,
    parseTicks,
    markDone,
    clearTweaks,
    reloadFromDisk,
    write,
    flush: () => chain,
    paths: () => (files ? { ...files } : null),
  };
}
