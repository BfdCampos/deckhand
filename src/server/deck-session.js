import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import chokidar from 'chokidar';
import { HttpError } from './security.js';
import { validateDeckPath } from './files.js';
import { anchorSource, indexSource, planOp, applySplices, invertSplices, rebaseRanges, mergeTweak } from './source-patch.js';

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const MAX_JOURNAL = 500;
const DEBOUNCE_MS = 100;

const closed = () => new HttpError(409, 'deck_closed', 'This deck is no longer open.');
const cannotUndo = () => new HttpError(409, 'cannot_undo', "That can't be undone any more.");

async function writable(p) {
  try { await fsp.access(p, fs.constants.W_OK); return true; } catch { return false; }
}

function stemOf(name) {
  return name.replace(/\.html?$/i, '');
}

export function createDeckSession({ hub, store = null, notes = null, home = os.homedir() }) {
  let deck = null;
  let watcher = null;
  let debounce = null;
  let locked = null;
  let mods = [];
  let journal = [];
  let chain = Promise.resolve();

  const broadcast = (event) => hub?.broadcast(event);

  function run(fn) {
    const next = chain.then(fn);
    chain = next.catch(() => {});
    return next;
  }

  function meta() {
    if (!deck) return null;
    const stem = stemOf(deck.name);
    return {
      deckId: deck.deckId,
      path: deck.path,
      dir: deck.dir,
      name: deck.name,
      url: '/deckroot/' + encodeURIComponent(deck.name),
      readOnly: deck.readOnly,
      hasSlides: deck.index.hasSlides,
      rev: deck.rev,
      missing: deck.missing,
      notesPath: path.join(deck.dir, `${stem}.deckhand.json`),
      workOrderPath: path.join(deck.dir, `${stem}.deckhand.md`),
    };
  }

  function load(buf) {
    const text = buf.toString('utf8');
    const roundTrips = Buffer.from(text, 'utf8').equals(buf);
    const anchored = anchorSource(text);
    return { text, roundTrips, source: anchored.source, index: indexSource(anchored.source), flushed: anchored.added === 0 && anchored.renamed === 0 };
  }

  function resetJournal() {
    mods = [];
    journal = [];
  }

  function adopt(buf, source) {
    const loaded = load(buf);
    deck.source = loaded.source;
    deck.index = loaded.index;
    deck.anchorsFlushed = loaded.flushed;
    deck.readOnly = deck.fileReadOnly || !loaded.roundTrips;
    deck.diskHash = sha(buf);
    deck.missing = false;
    deck.rev++;
    deck.lastExternalRev = deck.rev;
    resetJournal();
    broadcast({ type: 'deck-changed', deckId: deck.deckId, rev: deck.rev, source });
  }

  async function writeDisk(text) {
    const buf = Buffer.from(text, 'utf8');
    const tmp = `${deck.path}.deckhand-tmp`;
    deck.diskHash = sha(buf);
    try {
      await fsp.writeFile(tmp, buf, { mode: deck.mode });
      await fsp.chmod(tmp, deck.mode);
      await fsp.rename(tmp, deck.path);
    } catch (e) {
      await fsp.rm(tmp, { force: true }).catch(() => {});
      throw new HttpError(500, 'write_failed', "Couldn't save the deck.");
    }
  }

  function checkDisk() {
    const current = deck;
    return run(async () => {
      if (!deck || deck !== current) return;
      let buf;
      try {
        buf = await fsp.readFile(deck.path);
      } catch {
        if (!deck.missing) {
          deck.missing = true;
          broadcast({ type: 'deck-missing', deckId: deck.deckId });
        }
        return;
      }
      if (!deck.missing && sha(buf) === deck.diskHash) return;
      adopt(buf, 'external');
    });
  }

  async function stopWatching() {
    clearTimeout(debounce);
    if (watcher) await watcher.close().catch(() => {});
    watcher = null;
  }

  function startWatching() {
    const file = deck.path;
    const dir = deck.dir;
    watcher = chokidar.watch(dir, {
      ignoreInitial: true,
      depth: 0,
      ignored: (p) => p !== dir && p !== file,
    });
    const onEvent = (p) => {
      if (p !== file) return;
      clearTimeout(debounce);
      debounce = setTimeout(() => checkDisk().catch((e) => console.error('[deckhand] deck check failed:', e.message)), DEBOUNCE_MS);
    };
    watcher.on('add', onEvent).on('change', onEvent).on('unlink', onEvent).on('error', () => {});
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, 2000);
      watcher.once('ready', () => { clearTimeout(timer); resolve(); });
    });
  }

  function open(p) {
    return run(async () => {
      const { real, buf, mode } = await validateDeckPath(p, { home });
      await stopWatching();
      const dir = path.dirname(real);
      const fileReadOnly = !(await writable(real)) || !(await writable(dir));
      const loaded = load(buf);
      deck = {
        deckId: crypto.randomUUID(),
        path: real,
        dir,
        name: path.basename(real),
        mode,
        fileReadOnly,
        readOnly: fileReadOnly || !loaded.roundTrips,
        source: loaded.source,
        index: loaded.index,
        anchorsFlushed: loaded.flushed,
        diskHash: sha(buf),
        rev: 1,
        lastExternalRev: 1,
        missing: false,
      };
      locked = null;
      resetJournal();
      await startWatching();
      if (notes) await notes.bind(meta());
      try { await store?.addRecent?.(real); } catch {}
      broadcast({ type: 'deck', deck: meta() });
      if (notes) broadcast({ type: 'notes', ...notes.snapshot() });
      return meta();
    });
  }

  function close() {
    return run(async () => {
      await stopWatching();
      const had = !!deck;
      deck = null;
      locked = null;
      resetJournal();
      if (notes) await notes.bind(null);
      if (had) broadcast({ type: 'deck', deck: null });
    });
  }

  function guard(deckId, { write = true } = {}) {
    if (!deck || deckId !== deck.deckId) throw closed();
    if (locked) throw new HttpError(423, 'run_active', 'The agent is editing this deck.');
    if (write && deck.readOnly) throw new HttpError(403, 'read_only', 'This deck is read-only.');
    if (deck.missing) throw new HttpError(409, 'deck_missing', "Can't find the deck file.");
  }

  function pushJournal(entry) {
    journal.push(entry);
    if (journal.length > MAX_JOURNAL) journal.shift();
  }

  async function updateTweak(tweak, value) {
    if (!notes || !tweak) return;
    try { await notes.setTweak(tweak.aiId, value); } catch (e) { console.error('[deckhand] tweak update failed:', e.message); }
  }

  function applyOps(deckId, tabId, baseRev, ops) {
    return run(async () => {
      guard(deckId);
      if (!Number.isInteger(baseRev)) throw new HttpError(400, 'bad_op', 'Missing baseRev.');
      if (!Array.isArray(ops) || !ops.length || ops.length > 200) throw new HttpError(400, 'bad_op', 'Send between 1 and 200 changes.');
      if (deck.lastExternalRev > baseRev) throw new HttpError(409, 'deck_changed', 'The deck changed on disk. Reloading.');
      let source = deck.source;
      let index = deck.index;
      let maxN = index.maxN;
      const entries = [];
      const results = [];
      for (const op of ops) {
        const opId = typeof op?.opId === 'string' && op.opId.length <= 80 ? op.opId : crypto.randomUUID();
        const plan = planOp(index, op, { nextId: () => `dh${++maxN}` });
        if (!plan.splices.length) {
          results.push({ opId, ...plan.result });
          continue;
        }
        const next = applySplices(source, plan.splices);
        const nextIndex = indexSource(next.source);
        plan.verify(nextIndex);
        results.push({ opId, ...plan.result });
        source = next.source;
        index = nextIndex;
        maxN = Math.max(maxN, index.maxN);
        entries.push({ opId, tabId, applied: next.applied, tweak: plan.tweak || null });
      }
      if (!entries.length) return { rev: deck.rev, results };
      await writeDisk(source);
      deck.source = source;
      deck.index = index;
      deck.anchorsFlushed = true;
      deck.rev++;
      for (const e of entries) {
        mods.push({ splices: e.applied, inverseOf: null });
        const entry = { opId: e.opId, tabId: e.tabId, mod: mods.length - 1, undoMod: null, undone: false, tweak: e.tweak, tweakBefore: null, tweakAfter: null };
        if (e.tweak && notes) {
          entry.tweakBefore = notes.tweaks()[e.tweak.aiId] ?? null;
          entry.tweakAfter = mergeTweak(entry.tweakBefore, e.tweak);
          await updateTweak(e.tweak, entry.tweakAfter);
        }
        pushJournal(entry);
      }
      broadcast({ type: 'deck-changed', deckId: deck.deckId, rev: deck.rev, source: 'tab', byTab: tabId });
      return { rev: deck.rev, results };
    });
  }

  function effectiveMods(from) {
    const out = [];
    for (let i = from + 1; i < mods.length; i++) {
      const m = mods[i];
      if (m.inverseOf !== null && out.length && out.at(-1).index === m.inverseOf) out.pop();
      else out.push({ index: i, splices: m.splices });
    }
    return out.map((m) => m.splices);
  }

  function replay(deckId, tabId, opId, direction) {
    return run(async () => {
      guard(deckId);
      const entry = journal.find((e) => e.opId === opId && e.tabId === tabId);
      if (!entry) throw cannotUndo();
      const undoing = direction === 'undo';
      if (entry.undone === undoing) throw cannotUndo();
      const from = undoing ? entry.mod : entry.undoMod;
      if (from === null || from >= mods.length) throw cannotUndo();
      const ranges = rebaseRanges(invertSplices(mods[from].splices), effectiveMods(from));
      if (!ranges) throw cannotUndo();
      for (const r of ranges) if (deck.source.slice(r.start, r.end) !== r.old) throw cannotUndo();
      const next = applySplices(deck.source, ranges.map((r) => ({ start: r.start, end: r.end, text: r.text })));
      const nextIndex = indexSource(next.source);
      if (nextIndex.duplicates.length) throw cannotUndo();
      await writeDisk(next.source);
      deck.source = next.source;
      deck.index = nextIndex;
      deck.rev++;
      mods.push({ splices: next.applied, inverseOf: from });
      if (undoing) entry.undoMod = mods.length - 1;
      else entry.mod = mods.length - 1;
      entry.undone = undoing;
      await updateTweak(entry.tweak, undoing ? entry.tweakBefore : entry.tweakAfter);
      broadcast({ type: 'deck-changed', deckId: deck.deckId, rev: deck.rev, source: 'tab', byTab: tabId });
      return { rev: deck.rev };
    });
  }

  function flushAnchors() {
    return run(async () => {
      if (!deck || deck.anchorsFlushed || deck.readOnly) return;
      await writeDisk(deck.source);
      deck.anchorsFlushed = true;
    });
  }

  function writeExternal(buf, source = 'agent') {
    return run(async () => {
      if (!deck) throw closed();
      const data = Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf), 'utf8');
      const tmp = `${deck.path}.deckhand-tmp`;
      deck.diskHash = sha(data);
      await fsp.writeFile(tmp, data, { mode: deck.mode });
      await fsp.chmod(tmp, deck.mode);
      await fsp.rename(tmp, deck.path);
      adopt(data, source);
    });
  }

  function reloadFromDisk(source = 'external') {
    return run(async () => {
      if (!deck) throw closed();
      adopt(await fsp.readFile(deck.path), source);
    });
  }

  async function readDisk() {
    if (!deck) throw closed();
    return fsp.readFile(deck.path);
  }

  return {
    open,
    close,
    meta,
    servedSource: () => deck?.source ?? null,
    applyOps,
    undo: (deckId, tabId, opId) => replay(deckId, tabId, opId, 'undo'),
    redo: (deckId, tabId, opId) => replay(deckId, tabId, opId, 'redo'),
    flushAnchors,
    lock: (runId) => { locked = runId || true; },
    unlock: () => { locked = null; },
    isLocked: () => !!locked,
    readDisk,
    writeExternal,
    reloadFromDisk,
    dispose: stopWatching,
  };
}
