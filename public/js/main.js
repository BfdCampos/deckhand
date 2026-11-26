import { api, connectEvents, onEvent, deckFromState, normaliseDeck } from './api.js';
import { store } from './store.js';
import { toast } from './ui/toast.js';
import { confirmDeepLink } from './deep-link.js';
import { createHome } from './home/home.js';
import { createGeneration } from './create/generation.js';
import { createEditor } from './editor/editor.js';

const app = document.getElementById('app');
const home = createHome({
  openDeck: (p) => openDeck(p),
  onCreateStarted: (run) => showGeneration(run.id),
  onWatchRun: (id) => showGeneration(id),
  onContinue: () => {
    const deck = store.get().deck;
    if (deck) showEditor(deck, { push: true });
  },
});
const generation = createGeneration({
  openDeck: (p) => openDeck(p, { push: false }),
  goHome: ({ description, message } = {}) => {
    showHome({ description });
    if (message) toast(message);
  },
  showRun: (id, { replace = false } = {}) => showGeneration(id, { push: !replace }),
});
const editor = createEditor({ onHome: () => showHome({ push: true }) });
app.append(home.el, generation.el, editor.el);

function urlDeck() {
  return location.pathname === '/edit' ? new URLSearchParams(location.search).get('deck') : null;
}

function urlSlide() {
  const n = Number(new URLSearchParams(location.search).get('slide'));
  return Number.isInteger(n) && n > 0 ? n : null;
}

function showEditor(deck, { push = true, slide = null, paused = null } = {}) {
  if (!paused) store.set({ deck });
  if (urlDeck() !== deck.path) {
    const target = '/edit?deck=' + encodeURIComponent(deck.path) + (slide ? `&slide=${slide}` : '');
    history[push ? 'pushState' : 'replaceState']({ deckPath: deck.path }, '', target);
  } else if (history.state?.deckPath !== deck.path) {
    history.replaceState({ ...history.state, deckPath: deck.path }, '', location.href);
  }
  home.hide();
  generation.hide();
  editor.open(deck, { slide, paused });
}

function pauseFor(current) {
  return {
    deck: current,
    onSwitch: () => showEditor(current, { push: false }),
    onHome: () => showHome({ push: true }),
  };
}

function showHome({ push = false, description } = {}) {
  store.set({ justCreated: null });
  if (location.pathname !== '/' || location.search) history[push ? 'pushState' : 'replaceState'](null, '', '/');
  editor.hide();
  generation.hide();
  home.show({ description });
}

function showGeneration(runId, { push = true } = {}) {
  const target = '/create?run=' + encodeURIComponent(runId);
  if (location.pathname + location.search !== target) history[push ? 'pushState' : 'replaceState'](null, '', target);
  editor.hide();
  home.hide();
  generation.show(runId);
}

let pendingOpen = null;

async function openDeck(path, { push = true, slide = null } = {}) {
  pendingOpen = path;
  try {
    const deck = normaliseDeck(await api.post('/api/deck/open', { path }));
    let current = deck;
    try { current = deckFromState(await api.get('/api/state')) || deck; } catch { /* trust the open */ }
    if (current.deckId !== deck.deckId) {
      store.set({ deck: current });
      showEditor(deck, { push, slide, paused: pauseFor(current) });
      return;
    }
    showEditor(deck, { push, slide });
  } finally {
    pendingOpen = null;
  }
}

function askToOpen(wanted, slide, { fromHistory = false } = {}) {
  showHome();
  confirmDeepLink(wanted, {
    reason: fromHistory ? 'history' : 'link',
    onOpen: () => openDeck(wanted, { push: true, slide }).catch((err) => { showHome(); home.showError(err); }),
    onCancel: () => showHome(),
  });
}

const ROUTES = {
  '/edit': (params, { current }) => {
    const wanted = urlDeck();
    const slide = urlSlide();
    if (!wanted) return showHome();
    if (current && current.path === wanted) return showEditor(current, { push: false, slide });
    return askToOpen(wanted, slide, { fromHistory: history.state?.deckPath === wanted });
  },
  '/create': (params) => {
    const run = params.get('run');
    return run ? showGeneration(run, { push: false }) : showHome();
  },
  '/': () => showHome(),
};

async function route({ boot = false } = {}) {
  const handler = ROUTES[location.pathname] || ROUTES['/'];
  await handler(new URLSearchParams(location.search), { current: store.get().deck, boot });
}

let lastServerId = null;
let reconnected = false;
let restarted = false;

onEvent((m) => {
  if (m.type === 'error') { home.showError(m.error); return; }
  if (m.type === 'hello') {
    reconnected = lastServerId !== null;
    restarted = reconnected && m.serverId !== lastServerId;
    lastServerId = m.serverId;
    return;
  }
  if (m.type !== 'deck') return;
  const deck = normaliseDeck(m.deck);
  const wasReconnect = reconnected;
  const wasRestart = restarted;
  reconnected = false;
  restarted = false;
  if (!deck) {
    store.set({ deck: null });
    if (!editor.visible) return;
    if (wasRestart && !editor.paused) editor.reopen();
    else editor.showClosed();
    return;
  }
  store.set({ deck });
  if (!editor.visible) return;
  const shown = editor.deck;
  if (!shown || shown.path === deck.path) {
    if (!shown || shown.deckId !== deck.deckId) showEditor(deck, { push: false, slide: urlSlide() });
    else if (wasReconnect) editor.reconnected();
    else editor.updateMeta(deck);
    return;
  }
  if (deck.path === pendingOpen) return;
  editor.showElsewhere(deck, pauseFor(deck));
});

window.addEventListener('popstate', () => route());

connectEvents({ onStatus: (live) => store.set({ conn: live ? 'live' : 'reconnecting' }) });

api.get('/api/state')
  .then((s) => store.set({ deck: deckFromState(s) }))
  .catch(() => {})
  .finally(() => route({ boot: true }));
