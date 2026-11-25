import { h } from '../dom.js';
import { api, onEvent } from '../api.js';
import { store } from '../store.js';
import { icon } from '../ui/icons.js';
import { toast } from '../ui/toast.js';
import { openModal } from '../ui/modal.js';
import { openMenu } from '../ui/popover.js';
import { createActivityCard } from '../ui/activity.js';
import { createAgentChip, setAgents, selectAgent, foundAgents, selectedAgent } from '../ui/agent-chip.js';
import { formatElapsed } from '../ui/util.js';

const ERROR_COPY = {
  busy: 'Busy with another run. Try again when it finishes.',
  no_agent: 'No agent found. Install Claude Code or Codex, then check again.',
  nothing_to_do: 'Add a note first.',
  read_only: "This file is read-only, so the agent can't edit it.",
  run_active: 'Busy with another run. Try again when it finishes.',
  cannot_revert: "This run can't be reverted any more.",
  not_running: 'That run has already finished.',
  deck_closed: 'This deck was closed in another tab.',
  deck_missing: "Can't find the deck file any more.",
  no_note: 'That note no longer exists.',
};
const errorText = (err) => ERROR_COPY[err?.code] || err?.message || 'Something went wrong.';
const MAX_ERROR = 400;

function trimError(text) {
  const t = String(text || '').trim();
  return t.length > MAX_ERROR ? `${t.slice(0, MAX_ERROR - 1)}…` : t;
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

function middleTruncate(text, max = 64) {
  if (!text || text.length <= max) return text;
  const tail = Math.ceil(max * 0.7);
  return `${text.slice(0, max - tail - 1)}…${text.slice(-tail)}`;
}

export function mountRuns(ctx) {

  const card = createActivityCard();
  const activitySlot = ctx.slots.activity;
  activitySlot.classList.add('runs-activity');
  activitySlot.hidden = true;
  activitySlot.append(h('div', { class: 'runs-activity-title t-label' }, 'Activity'), card.el);

  const chip = createAgentChip();
  const group = h('div', { class: 'btn-group runs-actions' });

  const handoffBtn = h('button', { type: 'button', class: 'btn btn-primary btn-lg runs-main runs-handoff', onclick: handoff });
  const copyBtn = h('button', { type: 'button', class: 'btn btn-primary btn-lg runs-main runs-copy', onclick: () => copyPrompt({ noAgent: true }) },
    icon('copy'), 'Copy prompt for your AI');
  const stopTime = h('span', { class: 'runs-stop-time tnum' });
  const stopLabel = h('span', null, 'Stop');
  const stopBtn = h('button', { type: 'button', class: 'btn btn-secondary btn-lg runs-main runs-stop', onclick: stop },
    icon('stop'), stopLabel, stopTime);
  const caret = h('button', {
    type: 'button',
    class: 'btn btn-primary btn-lg btn-icon runs-caret',
    'aria-label': 'More hand-off options',
    'aria-haspopup': 'menu',
    onclick: openCaretMenu,
  }, icon('chevron-down'));

  ctx.slots.footer.classList.add('runs-footer');
  ctx.slots.agent.append(chip.el);
  ctx.slots.footer.append(h('div', { class: 'runs-foot' }, group));

  let run = null;
  let lines = new Map();
  let maxSeq = -Infinity;
  let busyOther = false;
  let stopping = false;
  let starting = false;
  let locked = false;
  let startNotes = [];
  let stopTick = null;
  let deckPath = null;

  const revertedIds = new Set();
  const currentDeck = () => ctx.deck || store.get().deck;
  const sameDeck = (p) => !!(p && currentDeck() && p === currentDeck().path);
  const isOurs = (r) => !!r && sameDeck(r.targetPath) && (r.kind === 'edit' || r.status !== 'running');
  const ourRunning = () => !!run && run.status === 'running';
  const agentName = () => selectedAgent(store.get().agents)?.name;
  const openNotes = () => (ctx.notes || []).filter((n) => (n.status || 'open') !== 'done');

  const tweakCount = () => Object.keys(ctx.layoutTweaks || {}).length;

  function noteLabel(id) {
    const i = (ctx.notes || []).findIndex((n) => n.id === id);
    return i >= 0 ? `Note ${i + 1}` : 'One note';
  }

  function runLabel(r) {
    if (r.kind === 'create') return 'New deck';
    if (r.scope === 'note') return noteLabel(r.noteIds?.[0]);
    return r.label || 'All notes';
  }

  function lock(on) {
    if (on === locked && !on) return;
    locked = on;
    if (on) ctx.setLocked(true, lockText());
    else ctx.setLocked(false);
  }

  function lockText() {
    return `${run?.agentName || agentName() || 'Your agent'} is editing your deck…`;
  }

  function sortedLines() {
    return [...lines.values()].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
  }

  function mergeLines(list = []) {
    let older = false;
    for (const line of list) {
      const key = line.seq ?? `x${lines.size}`;
      if (lines.has(key)) continue;
      lines.set(key, line);
      if (typeof line.seq === 'number' && line.seq < maxSeq) older = true;
      if (typeof line.seq === 'number') maxSeq = Math.max(maxSeq, line.seq);
    }
    return older;
  }

  function renderCard() {
    if (!run) return;
    activitySlot.hidden = false;
    const status = run.reverted ? 'reverted' : run.status;
    const tone = { running: stopping ? 'stopping' : 'working', succeeded: 'done', failed: 'error', stopped: 'stopped', reverted: 'reverted' }[status] || 'working';
    card.setHeader(runLabel(run), tone);
    card.setTimer(run.startedAt, run.endedAt);

    let summary = null;
    if (run.reverted) summary = run.kind === 'create' ? 'Deleted. The deck is gone and your description is back on Home.' : 'Reverted. The deck and notes are back how they were before this run.';
    else if (run.status === 'succeeded') {
      if (run.summary && typeof run.summary.total === 'number') summary = `Applied ${run.summary.applied} of ${plural(run.summary.total, 'note', 'notes')}.`;
      else summary = run.kind === 'create' ? 'Deck created.' : 'Done.';
    } else if (run.status === 'stopped') summary = 'Stopped. Any edits it already made are still in the file.';
    card.setSummary(summary);
    card.setError(run.status === 'failed' ? trimError(run.error || 'The agent stopped without saying why.') : null);

    const actions = [];
    if (run.status !== 'running' && run.canRevert && !run.reverted) {
      actions.push(run.kind === 'create'
        ? { label: 'Delete this deck', icon: 'trash', onClick: confirmRevert }
        : { label: 'Revert changes', icon: 'undo', onClick: confirmRevert });
    }
    if (run.status === 'failed') actions.push({ label: 'Copy prompt', icon: 'copy', onClick: () => copyPrompt({}) });
    card.setActions(actions);
  }

  function renderFooter() {
    const { agents } = store.get();
    const agent = selectedAgent(agents);
    const noAgent = !!agents && !agent;
    const count = openNotes().length;
    const tweaks = tweakCount();

    clearInterval(stopTick);
    if (ourRunning()) {
      stopBtn.disabled = stopping;
      stopLabel.textContent = stopping ? 'Stopping…' : 'Stop';
      const tickStop = () => { stopTime.textContent = run?.startedAt ? formatElapsed(Date.now() - Date.parse(run.startedAt)) : ''; };
      tickStop();
      stopTick = setInterval(tickStop, 1000);
      group.replaceChildren(stopBtn);
      return;
    }
    if (noAgent) {
      copyBtn.disabled = false;
      caret.className = 'btn btn-primary btn-lg btn-icon runs-caret';
      group.replaceChildren(copyBtn, caret);
      return;
    }

    const total = count + tweaks;
    const readOnly = !!currentDeck()?.readOnly;
    let label = `Hand off to ${agent?.name || 'your agent'}`;
    let title = '';
    if (busyOther) { label = 'Busy with another run'; title = 'Busy with another run'; }
    else if (readOnly) title = "This file is read-only, so the agent can't edit it.";
    else if (!total) title = 'Add a note first';
    handoffBtn.disabled = busyOther || readOnly || !total || starting;
    handoffBtn.title = title;
    handoffBtn.replaceChildren(...[
      busyOther ? icon('clock') : null,
      h('span', { class: 'truncate' }, starting ? 'Starting…' : label),
      total && !busyOther ? h('span', { class: 'pill-count' }, String(total)) : null,
    ].filter(Boolean));
    caret.className = `btn ${handoffBtn.disabled ? 'btn-secondary' : 'btn-primary'} btn-lg btn-icon runs-caret`;
    if (title) handoffBtn.setAttribute('title', title); else handoffBtn.removeAttribute('title');
    group.replaceChildren(handoffBtn, caret);
  }

  function inScope() {
    if (!run) return [];
    return run.noteIds?.length ? run.noteIds : startNotes;
  }

  function noteTag(id) {
    if (!run || run.status === 'running' || run.reverted || !run.summary) return null;
    if (!inScope().includes(id)) return null;
    const note = (ctx.notes || []).find((n) => n.id === id);
    return note && (note.status || 'open') !== 'done' ? 'Still open' : null;
  }

  let queued = false;
  ctx.notesChanged = () => {
    if (queued) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      renderFooter();
    });
  };

  async function backfill(id) {
    try {
      const cur = await api.get('/api/runs/current');
      if (!cur || !run || cur.id !== id) return;
      const { activity = [], ...state } = cur;
      if (mergeLines(activity) || activity.length) card.setLines(sortedLines());
      applyRun(state);
    } catch {
      /* the live events still arrive */
    }
  }

  function applyRun(given, { activity } = {}) {
    const next = given && revertedIds.has(given.id) ? { ...given, reverted: true, canRevert: false } : given;
    store.set({ run: next || null });
    if (!next || !isOurs(next)) {
      busyOther = !!next && next.status === 'running' && !isOurs(next);
      if (run && next && run.id === next.id) run = null;
      if (!run) lock(false);
      renderFooter();
      return;
    }
    busyOther = false;
    const fresh = !run || run.id !== next.id;
    if (fresh) {
      lines = new Map();
      maxSeq = -Infinity;
      stopping = false;
      startNotes = openNotes().map((n) => n.id);
      mergeLines(activity || []);
      card.setLines(sortedLines());
    } else if (activity) {
      const before = lines.size;
      if (mergeLines(activity) || lines.size !== before) card.setLines(sortedLines());
    }
    const regressed = !fresh && run.status !== 'running' && next.status === 'running';
    run = regressed ? { ...next, status: run.status, endedAt: run.endedAt, error: run.error, summary: run.summary, canRevert: run.canRevert } : next;
    if (run.status !== 'running') stopping = false;
    lock(run.status === 'running');
    renderCard();
    renderFooter();
    ctx.notesApi.render();
    if (fresh && !activity && run.status === 'running') backfill(run.id);
  }

  function onLine(m) {
    if (!run || m.runId !== run.id || !m.line) return;
    const before = lines.size;
    const older = mergeLines([m.line]);
    if (lines.size === before) return;
    if (older) card.setLines(sortedLines());
    else card.append(m.line);
  }

  async function refresh() {
    try {
      const s = await api.get('/api/state');
      if (s && 'agents' in s) setAgents(s.agents);
      if (!s || !('run' in s)) { renderFooter(); return; }
      if (!s.run) { applyRun(null); return; }
      let cur = null;
      try { cur = await api.get('/api/runs/current'); } catch { cur = null; }
      if (cur && cur.id === s.run.id) {
        const { activity = [], ...state } = cur;
        applyRun(state, { activity });
      } else {
        applyRun(s.run, { activity: [] });
      }
    } catch {
      renderFooter();
    }
  }

  async function startRun(body) {
    if (ourRunning() || busyOther) { toast(ERROR_COPY.busy); return; }
    if (starting) return;
    starting = true;
    renderFooter();
    try {
      await ctx.flushSaves();
      const next = await api.post('/api/runs', body);
      starting = false;
      applyRun(next, { activity: [] });
      backfill(next.id);
    } catch (err) {
      starting = false;
      renderFooter();
      toast(errorText(err), { tone: err.code === 'busy' ? 'info' : 'error' });
    }
  }

  function handoff() {
    startRun({ kind: 'edit', scope: 'all' });
  }

  function runNote(n) {
    startRun({ kind: 'edit', scope: 'note', noteId: n.id });
  }

  async function stop() {
    if (!ourRunning() || stopping) return;
    stopping = true;
    renderCard();
    renderFooter();
    try {
      applyRun(await api.post(`/api/runs/${encodeURIComponent(run.id)}/stop`, {}));
    } catch (err) {
      stopping = false;
      if (err.code === 'not_running') refresh();
      else { renderCard(); renderFooter(); toast(errorText(err), { tone: 'error' }); }
    }
  }

  function confirmRevert() {
    if (!run) return;
    const target = run;
    const who = target.agentName || agentName() || 'the agent';
    const deckName = currentDeck()?.name || 'the deck';
    const body = h('div', { class: 'runs-confirm' },
      h('p', null, target.kind === 'create'
        ? `Deckhand will delete ${deckName}, the deck ${who} just made, and take you back Home with your description.`
        : `Deckhand will put ${deckName} and its notes back exactly as they were before ${who} started.`),
      h('p', { class: 'text-muted' }, target.kind === 'create' ? "You can't undo this." : "Any edits made since the run finished will be lost too. You can't undo this."));
    openModal({
      title: target.kind === 'create' ? 'Delete this deck?' : 'Revert this run?',
      body,
      width: 440,
      actions: [
        { label: 'Cancel' },
        target.kind === 'create'
          ? { label: 'Delete this deck', danger: true, icon: 'trash', onClick: ({ close }) => { close(); revert(target); } }
          : { label: 'Revert changes', danger: true, icon: 'undo', onClick: ({ close }) => { close(); revert(target); } },
      ],
    });
  }

  async function revert(target) {
    try {
      const next = await api.post(`/api/runs/${encodeURIComponent(target.id)}/revert`, {});
      revertedIds.add(target.id);
      applyRun(next);
      const name = currentDeck()?.name || 'the deck';
      toast(target.kind === 'create' ? `Deleted ${name}. Your description is back on Home.` : 'Reverted. The deck is back how it was before the run.', { tone: 'success' });
      if (target.kind === 'create') {
        if (target.description) localStorage.setItem('deckhand.draft', target.description);
        ctx.goHome();
      }
    } catch (err) {
      toast(errorText(err), { tone: 'error' });
    }
  }

  async function fetchPrompt(scope = 'all', noteId) {
    const q = new URLSearchParams({ scope });
    if (noteId) q.set('noteId', noteId);
    return api.get(`/api/prompt?${q}`);
  }

  async function copyPrompt({ noAgent = false } = {}) {
    let data;
    try { data = await fetchPrompt(); } catch (err) { toast(errorText(err), { tone: 'error' }); return; }
    try {
      await navigator.clipboard.writeText(data.prompt);
      toast(noAgent ? 'Prompt copied. Paste it into your AI to apply the notes.' : 'Prompt copied', { tone: 'success' });
    } catch {
      showPrompt(data);
      toast("Couldn't reach the clipboard. Copy the prompt from here.");
    }
  }

  async function showPrompt(given) {
    let data = given;
    if (!data) {
      try { data = await fetchPrompt(); } catch (err) { toast(errorText(err), { tone: 'error' }); return; }
    }
    const pre = h('pre', { class: 'prompt-text', tabindex: '0' }, data.prompt);
    const row = (label, value) => (value ? h('div', { class: 'prompt-meta-row' }, h('span', { class: 't-label' }, label), h('span', { class: 'mono', title: value }, middleTruncate(value))) : null);
    openModal({
      title: 'The prompt for your AI',
      width: 640,
      body: h('div', { class: 'prompt-body' },
        h('p', { class: 'text-muted t-small' }, 'Deckhand sends this to your agent on hand-off. You can also paste it into Claude Code or Codex yourself.'),
        h('div', { class: 'prompt-meta' }, row('Deck', data.deckPath), row('Work order', data.workOrderPath)),
        pre),
      actions: [
        { label: 'Close' },
        {
          label: 'Copy prompt',
          primary: true,
          icon: 'copy',
          onClick: ({ close }) => navigator.clipboard.writeText(data.prompt)
            .then(() => { close(); toast('Prompt copied', { tone: 'success' }); })
            .catch(() => toast("Couldn't reach the clipboard. Select the text and copy it.", { tone: 'error' })),
        },
      ],
    });
  }

  function openCaretMenu() {
    const { agents } = store.get();
    const found = foundAgents(agents);
    const items = [];
    if (found.length > 1) {
      items.push({ heading: 'Run with' });
      for (const a of found) items.push({ label: a.name, checked: a.id === agents.selected, onSelect: () => { if (a.id !== agents.selected) selectAgent(a.id); } });
      items.push({ separator: true });
    }
    if (found.length) items.push({ label: 'Copy prompt', icon: 'copy', onSelect: () => copyPrompt({}) });
    items.push({ label: 'Show prompt', icon: 'eye', onSelect: () => showPrompt() });
    openMenu({ anchor: caret, align: 'end', label: 'Hand-off options', items });
  }

  onEvent((m) => {
    if (m.type === 'run') applyRun(m.run);
    else if (m.type === 'run-activity') onLine(m);
    else if (m.type === 'hello') refresh();
  });

  store.subscribe((s, patch) => {
    if ('agents' in patch) { renderFooter(); if (ourRunning()) lock(true); }
    if ('deck' in patch && s.deck?.path !== deckPath) {
      deckPath = s.deck?.path || null;
      run = null;
      lines = new Map();
      activitySlot.hidden = true;
      lock(false);
      if (deckPath) refresh();
    }
  });

  renderFooter();

  return {
    stateOf: (noteId) => (ourRunning() && (run.scope !== 'note' || run.noteIds?.includes(noteId)) ? 'running' : undefined),
    runNote,
    noteTag,
    isBusy: () => ourRunning() || busyOther,
    refresh,
  };
}
