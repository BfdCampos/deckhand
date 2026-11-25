import { api, connectEvents, onEvent, deckFromState, normaliseDeck } from './api.js';
import { store } from './store.js';
import { toast } from './ui/toast.js';
import { createHome } from './home/home.js';
import { createGeneration } from './create/generation.js';
import { createEditor } from './editor/editor.js';

const app = document.getElementById('app');
const home = createHome({
  openDeck: (p) => openDeck(p),
  onCreateStarted: (run) => showGeneration(run.id),
  onWatchRun: (id) => showGeneration(id),
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

function editUrl(deck) { return '/edit?deck=' + encodeURIComponent(deck.path); }

function setUrl(target, push) {
  if (location.pathname + location.search !== target) history[push ? 'pushState' : 'replaceState'](null, '', target);
}

function showEditor(deck, { push = true } = {}) {
  store.set({ deck });
  setUrl(editUrl(deck), push);
  home.hide();
  generation.hide();
  editor.open(deck);
}

function showHome({ push = false, description } = {}) {
  setUrl('/', push);
  editor.hide();
  generation.hide();
  home.show({ description });
}

function showGeneration(runId, { push = true } = {}) {
  setUrl('/create?run=' + encodeURIComponent(runId), push);
  editor.hide();
  home.hide();
  generation.show(runId);
}

async function openDeck(path, { push = true } = {}) {
  const deck = normaliseDeck(await api.post('/api/open', { path }));
  showEditor(deck, { push });
}

const ROUTES = {
  '/edit': async (params, { current }) => {
    const wanted = params.get('deck');
    if (!wanted) return showHome();
    if (current && current.path === wanted) return showEditor(current, { push: false });
    try {
      await openDeck(wanted, { push: false });
    } catch (err) {
      showHome();
      home.showError(err);
    }
  },
  '/create': (params) => {
    const run = params.get('run');
    return run ? showGeneration(run, { push: false }) : showHome();
  },
  '/': (params, { current, boot }) => (boot && current ? showEditor(current, { push: false }) : showHome()),
};

async function route({ boot = false } = {}) {
  const handler = ROUTES[location.pathname] || ROUTES['/'];
  await handler(new URLSearchParams(location.search), { current: store.get().deck, boot });
}

let lastServerId = null;

onEvent((m) => {
  if (m.type === 'error') { home.showError(m.error); return; }
  let deck;
  let reconnected = false;
  if (m.type === 'hello') {
    reconnected = lastServerId !== null;
    lastServerId = m.serverId;
    deck = deckFromState(m.state);
  } else if (m.type === 'bound' || m.type === 'deck') {
    deck = normaliseDeck(m.deck);
  } else {
    return;
  }
  if (!deck) return;
  const current = store.get().deck;
  const changed = !current || current.path !== deck.path;
  store.set({ deck });
  if (editor.visible && (changed || reconnected)) showEditor(deck, { push: false });
});

window.addEventListener('popstate', () => route());

connectEvents({ onStatus: (live) => store.set({ conn: live ? 'live' : 'reconnecting' }) });

api.get('/api/state')
  .then((s) => store.set({ deck: deckFromState(s) }))
  .catch(() => {})
  .finally(() => route({ boot: true }));
