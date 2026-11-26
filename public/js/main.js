import { api, connectEvents, onEvent, deckFromState, normaliseDeck } from './api.js';
import { store } from './store.js';
import { confirmDeepLink } from './deep-link.js';
import { createHome } from './home/home.js';
import { createEditor } from './editor/editor.js';

const app = document.getElementById('app');
const home = createHome({ openDeck: (p) => openDeck(p) });
const editor = createEditor({ onHome: () => showHome({ push: true }) });
app.append(home.el, editor.el);

function editUrl(deck) { return '/edit?deck=' + encodeURIComponent(deck.path); }

function showEditor(deck, { push = true } = {}) {
  store.set({ deck });
  const target = editUrl(deck);
  if (location.pathname + location.search !== target) history[push ? 'pushState' : 'replaceState'](null, '', target);
  home.hide();
  editor.open(deck);
}

function showHome({ push = false } = {}) {
  if (location.pathname !== '/' || location.search) history[push ? 'pushState' : 'replaceState'](null, '', '/');
  editor.hide();
  const deck = store.get().deck;
  home.show(deck ? deck.dir : '');
}

let pendingOpen = null;

async function openDeck(path, { push = true } = {}) {
  pendingOpen = path;
  try {
    const deck = normaliseDeck(await api.post('/api/open', { path }));
    showEditor(deck, { push });
  } finally {
    pendingOpen = null;
  }
}

function askToOpen(wanted) {
  editor.hide();
  const deck = store.get().deck;
  home.show(deck ? deck.dir : '');
  confirmDeepLink(wanted, {
    onOpen: () => openDeck(wanted, { push: false }).catch((err) => { showHome(); home.showError(err.message); }),
    onCancel: () => showHome(),
  });
}

async function route({ boot = false } = {}) {
  const wanted = location.pathname === '/edit' ? new URLSearchParams(location.search).get('deck') : null;
  const current = store.get().deck;
  if (wanted) {
    if (current && current.path === wanted) return showEditor(current, { push: false });
    askToOpen(wanted);
    return;
  }
  if (boot && current) return showEditor(current, { push: false });
  showHome();
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
  if (!editor.visible || (!changed && !reconnected)) return;
  const showing = editor.deck;
  if (showing && showing.path !== deck.path && deck.path !== pendingOpen) {
    editor.showElsewhere(deck, {
      onSwitch: () => showEditor(deck, { push: false }),
      onHome: () => showHome({ push: true }),
    });
    return;
  }
  showEditor(deck, { push: false });
});

window.addEventListener('popstate', () => route());

connectEvents({ onStatus: (live) => store.set({ conn: live ? 'live' : 'reconnecting' }) });

api.get('/api/state')
  .then((s) => store.set({ deck: deckFromState(s) }))
  .catch(() => {})
  .finally(() => route({ boot: true }));
