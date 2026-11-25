import { api, connectEvents, onEvent, deckFromState, normaliseDeck } from './api.js';
import { store } from './store.js';
import { createHome } from './home/home.js';
import { createEditor } from './editor/editor.js';

const app = document.getElementById('app');
const home = createHome({ openDeck: (p) => openDeck(p) });
const editor = createEditor({ onHome: () => showHome({ push: true }) });
app.append(home.el, editor.el);

function urlDeck() {
  return location.pathname === '/edit' ? new URLSearchParams(location.search).get('deck') : null;
}

function urlSlide() {
  const n = Number(new URLSearchParams(location.search).get('slide'));
  return Number.isInteger(n) && n > 0 ? n : null;
}

function showEditor(deck, { push = true, slide = null } = {}) {
  store.set({ deck });
  if (urlDeck() !== deck.path) {
    const target = '/edit?deck=' + encodeURIComponent(deck.path) + (slide ? `&slide=${slide}` : '');
    history[push ? 'pushState' : 'replaceState'](null, '', target);
  }
  home.hide();
  editor.open(deck, { slide });
}

function showHome({ push = false } = {}) {
  if (location.pathname !== '/' || location.search) history[push ? 'pushState' : 'replaceState'](null, '', '/');
  editor.hide();
  const deck = store.get().deck;
  home.show(deck ? deck.dir : '');
}

async function openDeck(path, { push = true, slide = null } = {}) {
  const deck = normaliseDeck(await api.post('/api/deck/open', { path }));
  showEditor(deck, { push, slide });
}

async function route({ boot = false } = {}) {
  const wanted = urlDeck();
  const slide = urlSlide();
  const current = store.get().deck;
  if (wanted) {
    if (current && current.path === wanted) return showEditor(current, { push: false, slide });
    try {
      await openDeck(wanted, { push: false, slide });
    } catch (err) {
      showHome();
      home.showError(err.message);
    }
    return;
  }
  if (boot && current) return showEditor(current, { push: false });
  showHome();
}

let lastServerId = null;
let reconnected = false;

onEvent((m) => {
  if (m.type === 'error') { home.showError(m.error); return; }
  if (m.type === 'hello') {
    reconnected = lastServerId !== null;
    lastServerId = m.serverId;
    return;
  }
  if (m.type !== 'deck' && m.type !== 'bound') return;
  const deck = normaliseDeck(m.deck);
  const wasReconnect = reconnected;
  reconnected = false;
  if (!deck) {
    store.set({ deck: null });
    if (editor.visible) editor.showClosed();
    return;
  }
  store.set({ deck });
  if (!editor.visible) return;
  const shown = editor.deck;
  if (!shown || shown.deckId !== deck.deckId) showEditor(deck, { push: false, slide: urlSlide() });
  else if (wasReconnect) editor.ctx.reload('tab');
});

window.addEventListener('popstate', () => route());

connectEvents({ onStatus: (live) => store.set({ conn: live ? 'live' : 'reconnecting' }) });

api.get('/api/state')
  .then((s) => store.set({ deck: deckFromState(s) }))
  .catch(() => {})
  .finally(() => route({ boot: true }));
