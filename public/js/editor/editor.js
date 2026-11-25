import { h } from '../dom.js';
import { api, onEvent, tabId, normaliseDeck } from '../api.js';
import { store } from '../store.js';
import { icon } from '../ui/icons.js';
import { toast, setToastHost } from '../ui/toast.js';
import { attachEscape, pushEscape } from '../ui/escape.js';
import { bindFrame, doc, injectAffordanceStyle, captureScroll, restoreScroll, currentSlideIndex, slides } from './frame.js';
import { createSaver } from './saver.js';
import { createManual } from './manual.js';
import { mountOverlay } from './overlay.js';
import { mountNotes } from './notes.js';
import { createDock } from './dock.js';
import { mountRuns } from './runs.js';

const CONN_LABEL = { connecting: 'Connecting…', live: 'Live', reconnecting: 'Reconnecting…' };
const CONN_DOT = { connecting: 'dot', live: 'dot dot-success', reconnecting: 'dot dot-warning' };
const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform);
const HINT_KEY = 'deckhand.hintDismissed';

export function createEditor({ onHome }) {
  const iframe = h('iframe', { id: 'deck', title: 'Deck' });
  const overlayEl = h('div', { id: 'overlay', class: 'overlay' });
  const dockEl = h('div', { id: 'dock', class: 'dock', hidden: true });
  const pillText = h('span', null);
  const veil = h('div', { class: 'editor-veil', hidden: true },
    h('div', { class: 'editor-pill', role: 'status' }, h('span', { class: 'dot dot-working' }), pillText));
  const stage = h('div', { class: 'stage' }, iframe, dockEl, veil);

  const connDot = h('span', { class: 'dot' });
  const connLabel = h('span', null);
  const conn = h('span', { class: 'conn t-meta' }, connDot, connLabel);
  const deckName = h('span', { class: 'topbar-name truncate' });
  const banners = h('div', { class: 'editor-banners' });

  const slots = {
    agent: h('div', { class: 'topbar-agent' }),
    tools: h('div', { class: 'sb-tools' }),
    notes: h('div', { class: 'sb-section sb-notes' }),
    activity: h('div', { class: 'sb-section activity' }),
    footer: h('div', { class: 'sb-foot' }),
  };

  const state = { missing: false, closed: false, pendingScroll: null, pendingRev: 0, reloadWanted: null, reloadScheduled: false };

  const ctx = {
    iframe,
    overlayEl,
    dockEl,
    stage,
    slots,
    deck: null,
    rev: 0,
    gen: 0,
    notes: [],
    layoutTweaks: {},
    selected: null,
    editing: null,
    locked: false,
    canEdit: () => !!ctx.deck && !ctx.locked && !ctx.deck.readOnly && !state.missing && !state.closed,
    canChangeNotes: () => ctx.canEdit(),
    reload,
    editEnded,
    showMissing,
    showClosed,
    setLocked,
    flushSaves,
    goHome,
  };

  const saver = createSaver(ctx);
  ctx.saver = saver;

  const homeButton = h('button', { type: 'button', class: 'btn btn-ghost btn-sm topbar-home', onclick: goHome }, '← Home');
  const topbar = h('header', { class: 'topbar' },
    homeButton,
    deckName,
    h('span', { class: 'grow' }),
    saver.el,
    slots.agent,
  );

  const root = h('div', { class: 'editor', hidden: true },
    h('div', { class: 'editor-main' }, topbar, banners, stage),
    h('aside', { class: 'sidebar' },
      h('div', { class: 'sb-head' },
        h('span', { class: 'brand-lockup' }, h('span', { class: 'brand-mark' }, icon('anchor')), 'Deckhand'),
        conn,
      ),
      slots.tools,
      slots.notes,
      slots.activity,
      slots.footer,
    ),
    overlayEl,
  );
  ctx.root = root;

  bindFrame(iframe);
  ctx.manual = createManual(ctx);
  ctx.notesApi = mountNotes(ctx);
  ctx.dock = createDock(ctx);
  ctx.runs = mountRuns(ctx);
  mountOverlay(ctx);

  const textButton = h('button', { type: 'button', class: 'btn btn-secondary', title: 'Add a text box', onclick: () => ctx.manual.addText() }, icon('plus'), 'Text');
  const imageButton = h('button', { type: 'button', class: 'btn btn-secondary', title: 'Add an image', onclick: () => ctx.manual.addImage() }, icon('image'), 'Image');
  const hint = h('div', { class: 'tools-hint', hidden: localStorage.getItem(HINT_KEY) === '1' },
    h('p', { class: 't-meta' }, 'Double-click to edit text. Drag to move. Right-click to leave a note. Paste an image anywhere.'),
    h('button', {
      type: 'button',
      class: 'btn btn-ghost btn-sm btn-icon',
      'aria-label': 'Dismiss hint',
      onclick: () => { localStorage.setItem(HINT_KEY, '1'); hint.hidden = true; },
    }, icon('x', { size: 14 })),
  );
  slots.tools.append(h('div', { class: 'tools' }, textButton, imageButton), hint);

  function syncControls() {
    const editable = ctx.canEdit();
    textButton.disabled = !editable;
    imageButton.disabled = !editable;
    root.classList.toggle('is-locked', ctx.locked);
    root.classList.toggle('is-readonly', !!ctx.deck?.readOnly);
  }

  const showConn = (s) => { connLabel.textContent = CONN_LABEL[s.conn] || ''; connDot.className = CONN_DOT[s.conn] || 'dot'; };
  store.subscribe(showConn);
  showConn(store.get());

  const bannerMap = new Map();
  function setBanner(key, spec) {
    if (!spec) bannerMap.delete(key);
    else bannerMap.set(key, spec);
    banners.replaceChildren(...[...bannerMap.values()].map((b) => h('div', { class: `banner banner-flush banner-${b.tone}`, role: b.tone === 'info' ? 'status' : 'alert' },
      icon(b.icon),
      h('span', { class: 'banner-text' }, b.text),
      b.actions?.length ? h('div', { class: 'banner-actions' }, b.actions.map((a) => h('button', { type: 'button', class: 'btn btn-secondary btn-sm', onclick: a.onClick }, a.icon ? icon(a.icon) : null, a.label))) : null,
    )));
  }

  function showMissing() {
    state.missing = true;
    ctx.manual.endEditing();
    ctx.selected = null;
    setBanner('missing', { tone: 'error', icon: 'alert-circle', text: `Can't find ${ctx.deck?.name || 'the deck'} any more.`, actions: [{ label: 'Back to Home', icon: 'home', onClick: goHome }] });
    syncControls();
    ctx.notesApi.render();
  }

  function showClosed() {
    state.closed = true;
    ctx.manual.endEditing();
    ctx.selected = null;
    setBanner('closed', {
      tone: 'warning',
      icon: 'warning',
      text: 'This deck was closed in another tab.',
      actions: [{ label: 'Reopen', icon: 'refresh', onClick: reopen }, { label: 'Home', icon: 'home', onClick: goHome }],
    });
    syncControls();
    ctx.notesApi.render();
  }

  async function reopen() {
    try {
      const deck = normaliseDeck(await api.post('/api/deck/open', { path: ctx.deck.path }));
      open(deck, { slide: currentSlideIndex() || null });
    } catch (err) {
      toast(err.message, { tone: 'error' });
    }
  }

  function setLocked(locked, message) {
    ctx.locked = !!locked;
    if (ctx.locked) {
      ctx.manual.endEditing();
      ctx.selected = null;
      ctx.notesApi.closePopovers();
    }
    pillText.textContent = message || 'Your agent is editing your deck…';
    veil.hidden = !ctx.locked;
    syncControls();
    ctx.notesApi.render();
  }

  async function flushSaves() {
    ctx.manual.endEditing();
    await saver.flush();
  }

  async function goHome() {
    try { await flushSaves(); } catch { /* go home anyway */ }
    onHome();
  }

  function loadFrame(scroll) {
    state.pendingScroll = scroll;
    ctx.selected = null;
    ctx.notesApi.closePopovers();
    iframe.src = ctx.deck.url + (ctx.deck.url.includes('?') ? '&' : '?') + 't=' + Date.now();
  }

  function reload(reason = 'tab') {
    if (!ctx.deck) return;
    const wanted = state.reloadWanted || { toast: false, clear: false };
    if (reason === 'external') wanted.toast = true;
    if (reason !== 'tab') wanted.clear = true;
    state.reloadWanted = wanted;
    if (ctx.editing || state.reloadScheduled) return;
    state.reloadScheduled = true;
    saver.flush().then(() => {
      state.reloadScheduled = false;
      if (ctx.editing || !state.reloadWanted || !ctx.deck) return;
      const why = state.reloadWanted;
      state.reloadWanted = null;
      if (why.clear && saver.clearHistory()) toast('Undo history cleared');
      if (why.toast) toast('Updated from disk');
      loadFrame(captureScroll());
    });
  }

  function editEnded() {
    if (state.reloadWanted) reload('tab');
  }

  onEvent((m) => {
    if (!ctx.deck || m.deckId !== ctx.deck.deckId) return;
    if (m.type === 'deck-changed') {
      if (m.source === 'tab' && m.byTab === tabId) { ctx.rev = Math.max(ctx.rev, m.rev); return; }
      state.pendingRev = Math.max(state.pendingRev, m.rev);
      if (state.missing) { state.missing = false; setBanner('missing', null); syncControls(); }
      reload(m.source);
    } else if (m.type === 'deck-missing') {
      showMissing();
    }
  });

  let scrollTimer = null;
  function onDeckScroll() {
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(() => {
      if (root.hidden || !doc()) return;
      const index = currentSlideIndex();
      ctx.dock.setActive(index);
      if (!index || location.pathname !== '/edit') return;
      const url = new URL(location.href);
      if (url.searchParams.get('slide') === String(index)) return;
      url.searchParams.set('slide', String(index));
      history.replaceState(history.state, '', url);
    }, 120);
  }

  function onKey(e) {
    if (root.hidden || e.defaultPrevented || e.isComposing) return;
    const t = e.target;
    if (t && t.closest && t.closest('input, textarea, select, [contenteditable="true"], .dialog-scrim, .popover')) return;
    if (document.querySelector('.dialog-scrim')) return;
    const mod = e.metaKey || e.ctrlKey;
    const key = e.key.toLowerCase();
    if (mod && key === 'z') {
      e.preventDefault();
      if (!ctx.canEdit()) return;
      if (e.shiftKey) saver.redo();
      else saver.undo();
    } else if (mod && key === 'y' && !IS_MAC) {
      e.preventDefault();
      if (ctx.canEdit()) saver.redo();
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && ctx.selected && !mod) {
      e.preventDefault();
      ctx.manual.deleteSelected();
    }
  }
  document.addEventListener('keydown', onKey);

  pushEscape(() => {
    if (root.hidden || !ctx.selected) return false;
    ctx.selected = null;
    return true;
  });

  function enhance() {
    const d = doc();
    if (!ctx.deck || !d || !d.body || !d.URL.includes('/deckroot/')) return;
    injectAffordanceStyle(d);
    attachEscape(d);
    ctx.manual.wire(d);
    d.addEventListener('keydown', onKey);
    d.addEventListener('scroll', onDeckScroll, { capture: true, passive: true });
    ctx.gen++;
    ctx.rev = Math.max(ctx.rev, state.pendingRev);
    const scroll = state.pendingScroll;
    state.pendingScroll = null;
    restoreScroll(scroll);
    requestAnimationFrame(() => restoreScroll(scroll));
    ctx.dock.build();
    ctx.dock.setActive(currentSlideIndex());
    ctx.manual.clearSelection();
    setBanner('noslides', ctx.deck.hasSlides === false || !slides().length
      ? { tone: 'info', icon: 'info', text: 'No slides found. Editing as one page.' }
      : null);
    document.body.dataset.ready = String(ctx.gen);
  }
  iframe.addEventListener('load', enhance);

  function open(deck, { slide } = {}) {
    ctx.manual.endEditing();
    ctx.deck = deck;
    ctx.rev = deck.rev ?? 0;
    state.pendingRev = 0;
    state.missing = !!deck.missing;
    state.closed = false;
    state.reloadWanted = null;
    saver.clearHistory();
    store.set({ deck });
    deckName.textContent = deck.name;
    deckName.title = deck.path;
    document.title = `${deck.name} · Deckhand`;
    bannerMap.clear();
    setBanner('readonly', deck.readOnly ? { tone: 'warning', icon: 'warning', text: "This file is read-only. You can browse it and copy prompts, but edits won't save." } : null);
    if (state.missing) showMissing();
    syncControls();
    root.hidden = false;
    setToastHost(stage);
    ctx.notesApi.load();
    loadFrame(slide ? { slide: Number(slide), frac: 0 } : null);
  }

  return {
    el: root,
    ctx,
    stage,
    get visible() { return !root.hidden; },
    get deck() { return ctx.deck; },
    open,
    showClosed,
    hide() {
      ctx.manual.endEditing();
      ctx.notesApi.closePopovers();
      root.hidden = true;
      setToastHost(null);
      delete document.body.dataset.ready;
      document.title = 'Deckhand';
    },
  };
}
