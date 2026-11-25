import { h } from '../dom.js';
import { icon } from './icons.js';
import { ensureStylesheet, formatElapsed } from './util.js';

const KIND_ICON = {
  read: 'eye',
  edit: 'pencil',
  write: 'file',
  search: 'search',
  blocked: 'alert',
  result: 'check-circle',
  error: 'alert-circle',
};

const TONE_STATE = {
  working: 'Working',
  stopping: 'Stopping…',
  done: 'Done',
  error: "Didn't finish",
  stopped: 'Stopped',
  reverted: 'Reverted',
};

const FALLBACK_TEXT = {
  read: (l) => `Reading ${l.file || 'the deck'}`,
  edit: (l) => `Editing ${l.file || 'the deck'}`,
  write: (l) => `Writing ${l.file || 'the deck'}`,
  search: () => 'Searching the files',
  blocked: (l) => `Blocked: ${l.tool || 'a tool'}`,
  result: () => 'Finished',
  error: () => 'Something went wrong',
};

const STICK_PX = 24;

export function createActivityCard() {
  ensureStylesheet('/css/runs.css');

  const label = h('span', { class: 'activity-label truncate' });
  const state = h('span', { class: 'activity-state' });
  const timer = h('span', { class: 'activity-timer tnum', hidden: true });
  const progress = h('div', { class: 'activity-progress progress-line', hidden: true });
  const list = h('ol', { class: 'activity-lines', 'aria-live': 'polite', 'aria-label': 'Agent activity' });
  const summary = h('p', { class: 'activity-summary', hidden: true });
  const errorBox = h('pre', { class: 'activity-error', hidden: true });
  const actions = h('div', { class: 'activity-actions', hidden: true });

  const el = h('section', { class: 'activity-card tone-idle', 'aria-label': 'Activity' },
    h('header', { class: 'activity-head' },
      h('span', { class: 'activity-mark', 'aria-hidden': 'true' }),
      label,
      h('span', { class: 'grow' }),
      state,
      timer),
    progress,
    list,
    errorBox,
    summary,
    actions);

  let lastSeq = -Infinity;
  let lastRow = null;
  let lastKey = null;
  let tick = null;
  let tone = 'idle';

  function nearBottom() {
    return list.scrollHeight - list.scrollTop - list.clientHeight < STICK_PX;
  }

  function row(line, animate) {
    const kind = line.kind || 'status';
    const text = line.text || (FALLBACK_TEXT[kind] ? FALLBACK_TEXT[kind](line) : '');
    const glyph = KIND_ICON[kind] ? icon(KIND_ICON[kind], { size: 14 }) : h('span', { class: 'activity-bullet' });
    return h('li', { class: ['activity-line', `kind-${kind}`, animate && 'rise-in'] },
      kind === 'text' ? null : h('span', { class: 'activity-glyph', 'aria-hidden': 'true' }, glyph),
      h('span', { class: 'activity-text' }, text));
  }

  function add(line, animate) {
    if (typeof line.seq === 'number') {
      if (line.seq <= lastSeq) return;
      lastSeq = line.seq;
    }
    const kind = line.kind || 'status';
    const key = kind === 'status' ? `status:${line.text}` : null;
    if (key && key === lastKey) return;
    const stick = nearBottom();
    lastRow?.classList.remove('is-live');
    lastRow = row(line, animate);
    lastKey = key;
    list.append(lastRow);
    if (tone === 'working') lastRow.classList.add('is-live');
    if (stick) list.scrollTop = list.scrollHeight;
  }

  function stopTick() {
    clearInterval(tick);
    tick = null;
  }

  return {
    el,
    setHeader(text, nextTone = 'working', stateText) {
      tone = nextTone;
      label.textContent = text || '';
      state.textContent = stateText ?? TONE_STATE[nextTone] ?? '';
      el.className = `activity-card tone-${nextTone}`;
      progress.hidden = nextTone !== 'working' && nextTone !== 'stopping';
      if (lastRow) lastRow.classList.toggle('is-live', nextTone === 'working');
    },
    setLines(lines = []) {
      list.replaceChildren();
      lastSeq = -Infinity;
      lastRow = null;
      lastKey = null;
      for (const line of lines) add(line, false);
      list.scrollTop = list.scrollHeight;
    },
    append(line) {
      add(line, true);
    },
    setSummary(text) {
      summary.textContent = text || '';
      summary.hidden = !text;
    },
    setError(text) {
      errorBox.textContent = text || '';
      errorBox.hidden = !text;
    },
    setActions(items = []) {
      actions.replaceChildren(...items.map((a) => h('button', {
        type: 'button',
        class: ['btn', 'btn-sm', a.primary ? 'btn-primary' : 'btn-secondary'],
        onclick: a.onClick,
      }, a.icon ? icon(a.icon, { size: 14 }) : null, a.label)));
      actions.hidden = !items.length;
    },
    setTimer(startedAt, endedAt) {
      stopTick();
      if (!startedAt) { timer.hidden = true; return; }
      const start = Date.parse(startedAt);
      const render = () => { timer.textContent = formatElapsed((endedAt ? Date.parse(endedAt) : Date.now()) - start); };
      render();
      timer.hidden = false;
      if (!endedAt) tick = setInterval(render, 1000);
    },
    destroy() {
      stopTick();
      el.remove();
    },
  };
}
