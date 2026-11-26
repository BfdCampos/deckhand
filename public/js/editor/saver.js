import { h } from '../dom.js';
import { api, ApiError, tabId } from '../api.js';
import { icon } from '../ui/icons.js';
import { toast } from '../ui/toast.js';
import { createHistory } from './history.js';
import { aiIdOf } from './frame.js';

export const SCRIPT_OWNED = "This text is set by the deck's own script, so Deckhand can't save it. Leave a note instead.";
const CHANGED_ON_DISK = 'This text changed on disk while you were editing it, so your version wasn\'t saved.';
const UNREACHABLE = "Couldn't reach Deckhand. Your changes are kept here and will save when it's back.";

const PRESERVED = new Set(['pre', 'pre-wrap', 'pre-line', 'break-spaces']);

function textOp(target, item) {
  if (!aiIdOf(target) || !target.isConnected) return null;
  const op = { type: 'setInner', aiId: aiIdOf(target), tag: target.tagName.toLowerCase(), before: item.text.before, after: item.text.after };
  const view = target.ownerDocument.defaultView;
  if (view && PRESERVED.has(view.getComputedStyle(target).whiteSpace)) op.whitespace = 'pre';
  return op;
}

const transient = (err) => !(err instanceof ApiError) || err.status >= 500 || err.code === 'write_failed' || err.code === 'internal';

export function createSaver(ctx) {
  const history = createHistory();
  const queue = [];
  const dirty = new Map();
  let running = false;
  let halted = null;
  let waiters = [];

  const el = h('div', { class: 'save-status', role: 'status', 'aria-live': 'polite' });

  function problem() {
    if (halted) return halted.message;
    const first = dirty.values().next().value;
    return first ? first.message : null;
  }

  function render() {
    const message = problem();
    if (message) {
      el.className = 'save-status is-error';
      el.title = message;
      el.replaceChildren(
        icon('alert-circle', { size: 14 }),
        h('span', null, "Couldn't save"),
        h('button', { type: 'button', class: 'btn btn-ghost btn-sm save-retry', title: message, onclick: retry }, 'Retry'),
      );
    } else if (running || queue.length) {
      el.className = 'save-status is-saving';
      el.removeAttribute('title');
      el.replaceChildren(h('span', { class: 'spin' }), h('span', null, 'Saving…'));
    } else {
      el.className = 'save-status is-saved';
      el.removeAttribute('title');
      el.replaceChildren(icon('check', { size: 14 }), h('span', null, 'Saved'));
    }
  }
  render();

  const hasUnsaved = () => running || queue.length > 0 || !!halted || dirty.size > 0;

  function settle() {
    render();
    if (running || (queue.length && !halted)) return;
    const done = waiters;
    waiters = [];
    for (const w of done) w();
    if (!hasUnsaved()) ctx.onAllSaved?.();
  }

  function deckBody(extra) {
    return { deckId: ctx.deck.deckId, tabId, ...extra };
  }

  async function pump() {
    if (running || halted) return;
    running = true;
    render();
    while (queue.length && !halted) {
      const item = queue[0];
      item.inFlight = true;
      const outcome = await send(item);
      item.inFlight = false;
      if (outcome === 'halt') break;
      queue.shift();
    }
    running = false;
    settle();
  }

  function enqueue(item) {
    queue.push(item);
    render();
    pump();
  }

  async function send(item) {
    if (!ctx.deck) return 'done';
    if (item.kind === 'replay') return replaySend(item);
    const built = item.build();
    if (!built) return 'done';
    const ops = Array.isArray(built) ? built : [built];
    if (!item.opIds || item.opIds.length !== ops.length) item.opIds = ops.map((_, i) => (i === 0 ? item.opId : crypto.randomUUID()));
    const text = item.kind === 'text';
    try {
      const res = await api.post('/api/deck/ops', deckBody({ baseRev: item.baseRev, ops: ops.map((op, i) => ({ ...op, opId: item.opIds[i] })) }));
      ctx.rev = Math.max(ctx.rev, res.rev);
      const results = ops.map((_, i) => res.results[i] || { opId: item.opIds[i] });
      const result = Array.isArray(built) ? results : results[0];
      if (item.entry) {
        item.entry.opIds = results.map((r, i) => r.opId || item.opIds[i]);
        item.entry.opId = item.entry.opIds[0];
        item.entry.settled = true;
      }
      if (text && result.changed === false && item.text.after !== item.text.before) {
        item.rollback?.();
        dropEntry(item);
        toast('That change was only spacing the slide collapses, so there was nothing to save.');
      }
      item.onResult?.(result);
      return 'done';
    } catch (err) {
      return refused(item, err);
    }
  }

  function dropEntry(item) {
    if (!item.entry) return;
    item.entry.settled = true;
    item.entry.failed = true;
    history.remove(item.entry);
  }

  function refused(item, err) {
    const text = item.kind === 'text';
    const blocked = err.code === 'deck_closed' || err.code === 'deck_missing' || err.code === 'read_only';
    if (transient(err) || blocked) {
      halted = { message: transient(err) ? (err instanceof ApiError ? err.message : UNREACHABLE) : err.message };
      if (err.code === 'deck_closed') ctx.showClosed();
      if (err.code === 'deck_missing') ctx.showMissing();
      if (err.code === 'read_only') ctx.showReadOnly?.();
      render();
      return 'halt';
    }
    dropEntry(item);
    if (text) {
      if (err.code === 'script_owned') {
        item.rollback?.();
        toast(SCRIPT_OWNED, { tone: 'error' });
        return 'done';
      }
      const conflict = err.code === 'edit_conflict' || err.code === 'deck_changed';
      const message = err.code === 'deck_changed' ? CHANGED_ON_DISK : err.message;
      dirty.set(item.el, { base: item.text.before, baseRev: item.baseRev, message, conflict });
      render();
      if (conflict) conflictsChanged();
      return 'done';
    }
    switch (err.code) {
      case 'deck_changed':
        item.rollback?.();
        toast("The deck changed on disk, so your last change wasn't saved.", { tone: 'error' });
        ctx.reload('external');
        break;
      case 'anchor_missing':
      case 'anchor_mismatch':
        item.rollback?.();
        toast('That element changed on disk, so Deckhand reloaded the deck.', { tone: 'error' });
        ctx.reload('external');
        break;
      case 'run_active':
        item.rollback?.();
        toast("The agent is editing this deck, so your change wasn't saved.", { tone: 'error' });
        break;
      default:
        item.rollback?.();
        toast(err.message, { tone: 'error' });
    }
    return 'done';
  }

  function makeEntry(undo, redo) {
    if (!undo) return null;
    const entry = { opId: null, gen: ctx.gen, undo, redo, settled: false, failed: false };
    history.push(entry);
    return entry;
  }

  function apply(build, { rollback, undo, redo, onResult } = {}) {
    const opId = crypto.randomUUID();
    const entry = makeEntry(undo, redo);
    if (entry) entry.opId = opId;
    enqueue({ kind: 'op', opId, baseRev: ctx.rev, build: typeof build === 'function' ? build : () => build, rollback, onResult, entry });
  }

  function applyText(target, { before, after, baseRev = ctx.rev, rollback, undo, redo }) {
    const stale = dirty.get(target);
    if (stale) {
      dirty.delete(target);
      before = stale.base;
    }
    const pending = [...queue].reverse().find((i) => i.kind === 'text' && i.el === target);
    if (pending && !pending.inFlight) {
      pending.text.after = after;
      if (pending.entry) pending.entry.redo = redo;
      render();
      pump();
      return;
    }
    const opId = crypto.randomUUID();
    const entry = makeEntry(undo, redo);
    if (entry) entry.opId = opId;
    const item = {
      kind: 'text',
      el: target,
      opId,
      text: { before, after },
      baseRev,
      rollback,
      entry,
    };
    item.build = () => textOp(target, item);
    enqueue(item);
  }

  async function replaySend(item) {
    const { entry, direction } = item;
    if (entry.failed) { history.remove(entry); return 'done'; }
    const live = () => entry.gen === ctx.gen;
    if (!item.early && live()) item.forward();
    try {
      const ids = entry.opIds || [entry.opId];
      for (const opId of direction === 'undo' ? [...ids].reverse() : ids) {
        const res = await api.post(`/api/deck/${direction}`, deckBody({ opId }));
        ctx.rev = Math.max(ctx.rev, res.rev);
      }
      if (!live()) ctx.reload();
    } catch (err) {
      history.remove(entry);
      if (live()) item.back();
      if (err.code === 'cannot_undo') {
        history.clear();
        toast(`That can't be ${direction === 'undo' ? 'undone' : 'redone'} any more, so Deckhand reloaded the deck.`, { tone: 'error' });
        ctx.reload();
      } else {
        toast(err instanceof ApiError ? err.message : UNREACHABLE, { tone: 'error' });
      }
    }
    return 'done';
  }

  function replay(direction) {
    if (halted || dirty.size) {
      toast('Deckhand is still trying to save your last change. Try again once it has saved.');
      return;
    }
    const entry = direction === 'undo' ? history.takeUndo() : history.takeRedo();
    if (!entry || !ctx.deck) return;
    const forward = () => (direction === 'undo' ? entry.undo : entry.redo)?.();
    const back = () => (direction === 'undo' ? entry.redo : entry.undo)?.();
    const early = entry.settled && entry.gen === ctx.gen;
    if (early) forward();
    if (direction === 'undo') history.putRedo(entry);
    else history.putUndo(entry);
    enqueue({ kind: 'replay', direction, entry, early, forward, back });
  }

  const conflictCount = () => [...dirty.values()].filter((d) => d.conflict).length;

  function conflictsChanged() {
    ctx.onConflicts?.(conflictCount());
  }

  function queueText(target, before, baseRev, { undoable = false } = {}) {
    const opId = crypto.randomUUID();
    const after = ctx.innerOf(target);
    const entry = undoable ? makeEntry(() => ctx.setInner(target, before), () => ctx.setInner(target, after)) : null;
    if (entry) entry.opId = opId;
    const item = { kind: 'text', el: target, opId, text: { before, after }, baseRev, entry };
    item.build = () => textOp(target, item);
    queue.push(item);
  }

  async function keepMine() {
    const clashes = [...dirty].filter(([, d]) => d.conflict);
    for (const [target] of clashes) {
      let server = null;
      try { server = await ctx.serverInnerOf(target); } catch { /* handled below */ }
      if (!server) {
        dirty.set(target, { ...dirty.get(target), message: "Deckhand couldn't read the version on disk. Try again." });
        continue;
      }
      dirty.delete(target);
      queueText(target, server.inner, server.rev, { undoable: true });
    }
    conflictsChanged();
    render();
    pump();
  }

  function useTheirs() {
    for (const [target, d] of [...dirty]) if (d.conflict) dirty.delete(target);
    conflictsChanged();
    render();
    ctx.reload('tab');
    settle();
  }

  function retry() {
    halted = null;
    for (const [target, stale] of [...dirty]) {
      if (stale.conflict) continue;
      dirty.delete(target);
      queueText(target, stale.base, stale.baseRev ?? ctx.rev);
    }
    render();
    if (conflictCount()) keepMine();
    else pump();
  }

  function flush() {
    if (!running && (!queue.length || halted)) return Promise.resolve();
    return new Promise((resolve) => waiters.push(resolve));
  }

  return {
    el,
    apply,
    applyText,
    undo: () => replay('undo'),
    redo: () => replay('redo'),
    flush,
    retry,
    keepMine,
    useTheirs,
    hasUnsaved,
    clearHistory: () => history.clear(),
    reset() {
      queue.length = 0;
      dirty.clear();
      halted = null;
      conflictsChanged();
      render();
    },
    get busy() { return running || queue.length > 0; },
  };
}
