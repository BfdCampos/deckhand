import { h } from '../dom.js';
import { api, onEvent } from '../api.js';
import { store } from '../store.js';
import { icon } from '../ui/icons.js';
import { toast } from '../ui/toast.js';
import { createActivityCard } from '../ui/activity.js';
import { createAgentChip, selectedAgent, setAgents } from '../ui/agent-chip.js';
import { formatElapsed } from '../ui/util.js';
import { DRAFT_KEY } from '../home/create-card.js';
import { homeOf, tildify } from '../home/paths.js';

const MAX_ERROR = 400;
const NO_FILE = 'The agent finished without writing the deck.';
const CREATED = 'Deck created. Double-click text to edit, or right-click anything to leave a note.';

function trimError(text) {
  const t = String(text || '').trim();
  return t.length > MAX_ERROR ? `${t.slice(0, MAX_ERROR - 1)}…` : t;
}

export function createGeneration({ openDeck, goHome, showRun }) {
  const chip = createAgentChip();
  const card = createActivityCard();
  const head = card.el.querySelector('.activity-head');

  const title = h('h1', { class: 't-headline gen-title' }, 'Building your deck');
  const eyebrow = h('span', { class: 'gen-eyebrow t-label' }, 'New deck');
  const quote = h('blockquote', { class: 'gen-quote' });
  const more = h('button', { type: 'button', class: 'link gen-more', hidden: true }, 'Show more');
  const agentName = h('span', null);
  const agent = h('span', { class: 'chip chip-quiet gen-agent' }, h('span', { class: 'dot dot-working' }), agentName);
  const timer = h('span', { class: 'gen-timer tnum' }, '0:00');
  const targetText = h('span', { class: 'gen-target mono truncate' });
  const meta = h('div', { class: 'gen-meta' },
    agent,
    h('span', { class: 'chip chip-quiet gen-clock' }, icon('clock', { size: 14 }), timer),
    h('span', { class: 'chip chip-quiet gen-file' }, icon('deck', { size: 14 }), targetText));

  const errorBox = h('pre', { class: 'gen-error', hidden: true });
  const failure = h('div', { class: 'gen-failure', hidden: true }, errorBox);
  const actions = h('div', { class: 'gen-actions' });
  const hint = h('p', { class: 'gen-hint t-meta' }, "You can close this tab. The run keeps going and the deck will be in Recent when it's done.");

  const el = h('main', { class: 'generation', hidden: true },
    h('div', { class: 'gen-inner' },
      h('header', { class: 'home-top' },
        h('button', { type: 'button', class: 'brand-lockup gen-brand', title: 'Back to Home', onclick: () => goHome({ description: run?.description }) },
          h('span', { class: 'brand-mark' }, icon('anchor')), 'Deckhand'),
        chip.el),
      h('section', { class: 'gen-head' },
        eyebrow,
        title,
        h('div', { class: 'gen-quote-wrap' }, quote, more),
        meta),
      failure,
      card.el,
      h('footer', { class: 'gen-foot' }, actions, hint)));

  let run = null;
  let wantedId = null;
  let tick = null;
  let stopping = false;
  let finishing = false;
  let expanded = false;

  more.addEventListener('click', () => {
    expanded = !expanded;
    quote.classList.toggle('is-open', expanded);
    more.textContent = expanded ? 'Show less' : 'Show more';
  });

  function displayPath(p) {
    const s = store.get();
    return tildify(p, homeOf(s.info) || guessHome(p));
  }

  function guessHome(p) {
    const m = /^(\/Users\/[^/]+|\/home\/[^/]+)/.exec(p || '');
    return m ? m[1] : null;
  }

  function startTick() {
    clearInterval(tick);
    const render = () => {
      if (!run?.startedAt) { timer.textContent = '0:00'; return; }
      const end = run.endedAt ? Date.parse(run.endedAt) : Date.now();
      timer.textContent = formatElapsed(end - Date.parse(run.startedAt));
    };
    render();
    if (run && run.status === 'running') tick = setInterval(render, 1000);
  }

  function button(label, { primary, iconName, onClick, cls } = {}) {
    return h('button', { type: 'button', class: ['btn', primary ? 'btn-primary' : 'btn-secondary', cls], onclick: onClick },
      iconName ? icon(iconName, { size: 16 }) : null, label);
  }

  function renderQuote(text) {
    quote.textContent = text || '';
    expanded = false;
    quote.classList.remove('is-open');
    more.textContent = 'Show more';
    requestAnimationFrame(() => { more.hidden = quote.scrollHeight <= quote.clientHeight + 2; });
  }

  function render() {
    if (!run) return;
    const working = run.status === 'running';
    const name = run.agentName || selectedAgent(store.get().agents)?.name || 'Your agent';
    agentName.textContent = name;
    agent.querySelector('.dot').className = working ? 'dot dot-working' : run.status === 'succeeded' ? 'dot dot-success' : 'dot dot-error';
    targetText.textContent = run.targetPath ? displayPath(run.targetPath) : '~/Deckhand';
    targetText.title = run.targetPath || '';
    startTick();

    el.classList.toggle('is-failed', run.status === 'failed');
    head.classList.toggle('shimmer', working);
    card.setTimer(null);

    if (working) {
      eyebrow.textContent = 'New deck';
      title.textContent = 'Building your deck';
      card.setHeader('Activity', stopping ? 'stopping' : 'working', stopping ? 'Stopping…' : `${name} is working`);
      failure.hidden = true;
      hint.hidden = false;
      const stop = button(stopping ? 'Stopping…' : 'Stop', { iconName: 'stop', onClick: onStop, cls: 'gen-stop' });
      stop.disabled = stopping;
      actions.replaceChildren(stop);
      return;
    }

    hint.hidden = true;
    if (run.status === 'failed') {
      eyebrow.textContent = 'New deck';
      title.textContent = "That didn't work";
      card.setHeader('Activity', 'error');
      errorBox.textContent = trimError(run.error) || NO_FILE;
      errorBox.hidden = false;
      failure.hidden = false;
      const buttons = [
        button('Try again', { primary: true, iconName: 'refresh', onClick: tryAgain }),
        button('Edit description', { iconName: 'pencil', onClick: () => goHome({ description: run.description }) }),
        button('Copy prompt', { iconName: 'copy', onClick: copyPrompt }),
      ];
      if (run.outputUsable) buttons.push(button('Open what it made', { iconName: 'external', onClick: () => openMade(run.targetPath) }));
      actions.replaceChildren(...buttons);
      return;
    }
    if (run.status === 'succeeded') {
      title.textContent = 'Your deck is ready';
      card.setHeader('Activity', 'done');
      actions.replaceChildren();
      finish();
      return;
    }
    if (run.status === 'stopped') {
      actions.replaceChildren();
      goHome({ description: run.description, message: 'Stopped. Nothing was saved.' });
    }
  }

  async function finish() {
    if (finishing || !run) return;
    finishing = true;
    try { localStorage.removeItem(DRAFT_KEY); } catch { /* private mode */ }
    try {
      await openDeck(run.targetPath);
      toast(CREATED, { tone: 'success' });
    } catch (err) {
      finishing = false;
      title.textContent = "That didn't work";
      errorBox.textContent = err.message;
      errorBox.hidden = false;
      failure.hidden = false;
    }
  }

  async function openMade(p) {
    try { await openDeck(p); } catch (err) { toast(err.message, { tone: 'error' }); }
  }

  async function onStop() {
    if (!run || stopping) return;
    stopping = true;
    render();
    try {
      const next = await api.post(`/api/runs/${encodeURIComponent(run.id)}/stop`, {});
      apply(next);
    } catch (err) {
      stopping = false;
      if (err.code === 'not_running') load(run.id);
      else { render(); toast(err.message, { tone: 'error' }); }
    }
  }

  async function tryAgain() {
    if (!run) return;
    try {
      const next = await api.post('/api/runs', { kind: 'create', description: run.description });
      showRun(next.id, { replace: true });
    } catch (err) {
      toast(err.code === 'busy' ? 'Busy with another run. Try again when it finishes.' : err.message, { tone: 'error' });
    }
  }

  async function copyPrompt() {
    try {
      const res = await api.get(`/api/prompt?${new URLSearchParams({ kind: 'create', description: run?.description || '' })}`);
      await navigator.clipboard.writeText(res.prompt);
      toast('Prompt copied', { tone: 'success' });
    } catch (err) {
      toast(err.message || "Couldn't copy the prompt.", { tone: 'error' });
    }
  }

  function apply(next, { activity } = {}) {
    if (!next || next.id !== wantedId) return;
    const fresh = !run || run.id !== next.id;
    if (!fresh && run.status !== 'running' && next.status === 'running') return;
    if (fresh) renderQuote(next.description);
    else if (next.description !== run.description) renderQuote(next.description);
    run = next;
    if (run.status !== 'running') stopping = false;
    if (activity) card.setLines(activity);
    store.set({ run });
    render();
  }

  async function load(id) {
    if (!store.get().info) {
      try {
        const info = await api.get('/api/state');
        store.set({ info });
        if (info && 'agents' in info) setAgents(info.agents);
      } catch { /* the run state below still loads */ }
    }
    let cur = null;
    try { cur = await api.get('/api/runs/current'); } catch { cur = null; }
    if (id !== wantedId) return;
    if (cur && cur.id === id) {
      const { activity = [], ...state } = cur;
      apply(state, { activity });
      return;
    }
    goHome({});
  }

  onEvent((m) => {
    if (el.hidden) return;
    if (m.type === 'run') apply(m.run);
    else if (m.type === 'run-activity' && run && m.runId === run.id && m.line) card.append(m.line);
    else if (m.type === 'hello' && wantedId) load(wantedId);
  });

  return {
    el,
    get visible() { return !el.hidden; },
    show(id) {
      wantedId = id;
      run = null;
      stopping = false;
      finishing = false;
      card.setLines([]);
      card.setHeader('Activity', 'working', 'Starting…');
      actions.replaceChildren();
      failure.hidden = true;
      el.hidden = false;
      load(id);
    },
    hide() {
      el.hidden = true;
      wantedId = null;
      clearInterval(tick);
    },
  };
}
