import { h } from '../dom.js';
import { api, ApiError, tabId } from '../api.js';
import { icon } from '../ui/icons.js';
import { toast } from '../ui/toast.js';
import { createHistory } from './history.js';

export const SCRIPT_OWNED = "This text is set by the deck's own script, so Deckhand can't save it. Leave a note instead.";

const messageOf = (err) => (err instanceof ApiError ? err.message : "Couldn't reach Deckhand. Is it still running?");

export function createSaver(ctx) {
  const history = createHistory();
  let chain = Promise.resolve();
  let pending = 0;
  let failure = null;

  const el = h('div', { class: 'save-status', role: 'status', 'aria-live': 'polite' });

  function render() {
    if (failure) {
      el.className = 'save-status is-error';
      el.title = failure.message;
      el.replaceChildren(
        icon('alert-circle', { size: 14 }),
        h('span', null, "Couldn't save"),
        h('button', { type: 'button', class: 'btn btn-ghost btn-sm save-retry', onclick: () => failure && failure.retry() }, 'Retry'),
      );
    } else if (pending) {
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

  function enqueue(task) {
    pending++;
    render();
    const run = chain.then(task).finally(() => { pending--; render(); });
    chain = run.catch(() => {});
    return run;
  }

  function deckBody(extra) {
    return { deckId: ctx.deck.deckId, tabId, ...extra };
  }

  function refused(err, rollback, retry) {
    switch (err.code) {
      case 'script_owned':
        rollback?.();
        toast(SCRIPT_OWNED, { tone: 'error' });
        break;
      case 'deck_changed':
        toast("The deck changed on disk, so your last change wasn't saved.", { tone: 'error' });
        ctx.reload();
        break;
      case 'anchor_missing':
      case 'anchor_mismatch':
        toast('That element changed on disk, so Deckhand reloaded the deck.', { tone: 'error' });
        ctx.reload();
        break;
      case 'run_active':
        rollback?.();
        toast("The agent is editing this deck, so your change wasn't saved.", { tone: 'error' });
        break;
      case 'deck_closed':
        rollback?.();
        ctx.showClosed();
        break;
      case 'deck_missing':
        rollback?.();
        ctx.showMissing();
        break;
      case 'read_only':
      case 'bad_op':
        rollback?.();
        toast(err.message, { tone: 'error' });
        break;
      default:
        failure = { message: messageOf(err), retry };
        render();
    }
  }

  function apply(build, { rollback, undo, redo, onResult } = {}) {
    const opId = crypto.randomUUID();
    const entry = undo ? { opId, gen: ctx.gen, undo, redo, settled: false, failed: false } : null;
    if (entry) history.push(entry);
    const attempt = () => enqueue(async () => {
      if (!ctx.deck) return null;
      const op = typeof build === 'function' ? build() : build;
      if (!op) return null;
      try {
        const res = await api.post('/api/deck/ops', deckBody({ baseRev: ctx.rev, ops: [{ ...op, opId }] }));
        ctx.rev = Math.max(ctx.rev, res.rev);
        const result = res.results[0] || { opId };
        failure = null;
        if (entry) {
          entry.opId = result.opId || opId;
          entry.settled = true;
          if (entry.failed) { entry.failed = false; history.push(entry); }
        }
        onResult?.(result);
        return result;
      } catch (err) {
        if (entry) {
          entry.settled = true;
          entry.failed = true;
          history.remove(entry);
        }
        refused(err, rollback, attempt);
        return null;
      }
    });
    return attempt();
  }

  function replay(direction) {
    const entry = direction === 'undo' ? history.takeUndo() : history.takeRedo();
    if (!entry || !ctx.deck) return;
    const live = () => entry.gen === ctx.gen;
    const forward = () => (direction === 'undo' ? entry.undo : entry.redo)?.();
    const back = () => (direction === 'undo' ? entry.redo : entry.undo)?.();
    const early = entry.settled && live();
    if (early) forward();
    if (direction === 'undo') history.putRedo(entry);
    else history.putUndo(entry);
    enqueue(async () => {
      if (entry.failed) { history.remove(entry); return; }
      if (!early && live()) forward();
      try {
        const res = await api.post(`/api/deck/${direction}`, deckBody({ opId: entry.opId }));
        ctx.rev = Math.max(ctx.rev, res.rev);
        failure = null;
        if (!live()) ctx.reload();
      } catch (err) {
        history.remove(entry);
        if (live()) back();
        if (err.code === 'cannot_undo') {
          history.clear();
          toast(`That can't be ${direction === 'undo' ? 'undone' : 'redone'} any more, so Deckhand reloaded the deck.`, { tone: 'error' });
          ctx.reload();
        } else {
          refused(err, null, () => {});
        }
      }
    });
  }

  return {
    el,
    apply,
    undo: () => replay('undo'),
    redo: () => replay('redo'),
    flush: () => chain,
    clearHistory: () => history.clear(),
    get busy() { return pending > 0; },
  };
}
