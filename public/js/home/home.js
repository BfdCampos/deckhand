import { h } from '../dom.js';
import { api } from '../api.js';
import { store } from '../store.js';
import { icon } from '../ui/icons.js';
import { createAgentChip, setAgents } from '../ui/agent-chip.js';
import { createCreateCard, readDraft } from './create-card.js';
import { createOpenCard } from './open-card.js';

export function createHome({ openDeck, onCreateStarted, onWatchRun }) {
  let info = null;
  const getInfo = () => info;

  const chip = createAgentChip();
  const create = createCreateCard({ getInfo, onStarted: (run) => onCreateStarted(run) });
  const open = createOpenCard({ openDeck, getInfo });

  const runningText = h('span', { class: 'home-running-text' });
  const watch = h('button', { type: 'button', class: 'btn btn-secondary btn-sm' }, 'Watch it', icon('arrow-right', { size: 14 }));
  const running = h('div', { class: 'banner banner-info home-running', role: 'status', hidden: true },
    h('span', { class: 'dot dot-working' }), runningText, h('span', { class: 'grow' }), watch);

  const el = h('main', { class: 'home', hidden: true },
    h('div', { class: 'home-inner' },
      h('header', { class: 'home-top' },
        h('span', { class: 'brand-lockup' }, h('span', { class: 'brand-mark' }, icon('anchor')), 'Deckhand'),
        chip.el),
      h('section', { class: 'home-hero' },
        h('h1', { class: 't-display home-title' }, 'Make a deck with your AI.'),
        h('p', { class: 't-lead home-lead' }, 'Describe it and your agent builds it, or open one you already have. It stays a single HTML file the whole time.')),
      running,
      h('div', { class: 'home-cards' }, create.el, open.el)));

  function renderRunning() {
    const { run } = store.get();
    const active = run && run.status === 'running';
    running.hidden = !active;
    if (!active) return;
    const who = run.agentName || 'Your agent';
    if (run.kind === 'create') {
      runningText.textContent = `${who} is building a deck`;
      watch.hidden = false;
      watch.onclick = () => onWatchRun(run.id);
    } else {
      runningText.textContent = `${who} is editing ${run.targetPath ? run.targetPath.split('/').pop() : 'a deck'}`;
      watch.hidden = false;
      watch.onclick = () => openDeck(run.targetPath);
    }
  }

  store.subscribe((_, patch) => { if ('run' in patch) renderRunning(); });

  async function refresh() {
    try {
      info = await api.get('/api/state');
    } catch {
      info = null;
    }
    store.set({ info });
    if (info && 'agents' in info) setAgents(info.agents);
    if (info && 'run' in info) store.set({ run: info.run });
    create.render();
    create.refreshTarget();
    renderRunning();
    await open.load();
  }

  return {
    el,
    show({ description } = {}) {
      el.hidden = false;
      open.showError('');
      create.setDraft(description ?? readDraft());
      create.render();
      refresh();
      requestAnimationFrame(() => create.focus());
    },
    hide() { el.hidden = true; },
    showError(msg) { open.showError(msg); },
  };
}
