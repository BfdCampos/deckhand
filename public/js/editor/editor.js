import { h } from '../dom.js';
import { onEvent, sendLegacy } from '../api.js';
import { store } from '../store.js';
import { icon } from '../ui/icons.js';
import { bindFrame, doc, injectAffordanceStyle, ensureIds, serializeDeck } from './frame.js';
import { createManual } from './manual.js';
import { mountOverlay } from './overlay.js';
import { mountNotes } from './notes.js';
import { buildDock } from './dock.js';
import { mountRuns } from './runs.js';

const CONN_LABEL = { connecting: 'connecting…', live: 'live', reconnecting: 'reconnecting…' };

export function createEditor({ onHome }) {
  const iframe = h('iframe', { id: 'deck', title: 'deck' });
  const overlayEl = h('div', { id: 'overlay', class: 'overlay' });
  const dockEl = h('div', { id: 'dock', class: 'dock', hidden: true });
  const filePath = h('span', { class: 'sb-file-path' });
  const conn = h('span', { class: 'conn' });

  const slots = {
    tools: h('div', { class: 'sb-tools' }),
    notes: h('div', { class: 'sb-section' }),
    activity: h('div', { class: 'sb-section activity' }),
    footer: h('div', { class: 'sb-foot' }),
  };

  const root = h('div', { class: 'editor', hidden: true },
    h('div', { class: 'stage' }, iframe, overlayEl, dockEl),
    h('aside', { class: 'sidebar' },
      h('div', { class: 'sb-head' },
        h('span', { class: 'brand-sm' }, icon('anchor'), 'Deckhand'),
        conn,
      ),
      h('div', { class: 'sb-file' },
        filePath,
        h('button', { type: 'button', class: 'link-btn', title: 'Open a different presentation', onclick: () => onHome() }, 'Open another deck →'),
      ),
      slots.tools,
      slots.notes,
      slots.activity,
      slots.footer,
    ),
  );

  let saveTimer = null;

  const ctx = {
    root,
    iframe,
    overlayEl,
    dockEl,
    slots,
    deck: null,
    notes: [],
    selected: null,
    editing: null,
    pendingReload: false,
    commit,
    scheduleSave,
    reload,
  };

  bindFrame(iframe);
  ctx.manual = createManual(ctx);
  ctx.notesApi = mountNotes(ctx);
  ctx.runs = mountRuns(ctx);
  mountOverlay(ctx);

  slots.tools.append(
    h('div', { class: 'tools' },
      h('button', { type: 'button', title: 'Add a text box', onclick: () => ctx.manual.addText() }, '+ Text'),
      h('button', { type: 'button', title: 'Add an image', onclick: () => ctx.manual.addImage() }, '+ Image'),
    ),
    h('p', { class: 'tools-hint' }, 'Single-click to select · double-click text to edit · drag to move · right-click anything to leave a note for the AI · paste an image anywhere.'),
  );

  store.subscribe((s) => { conn.textContent = CONN_LABEL[s.conn] || ''; conn.classList.toggle('live', s.conn === 'live'); });
  conn.textContent = CONN_LABEL[store.get().conn];

  onEvent((m) => { if (m.type === 'deck-changed' && ctx.deck) reload(); });

  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(commit, 400);
  }

  function commit() {
    clearTimeout(saveTimer);
    if (!doc()) return;
    sendLegacy({ type: 'save-html', html: serializeDeck() });
    ctx.notesApi.persist();
  }

  function load() {
    iframe.src = ctx.deck.url + '?t=' + Date.now();
  }

  function reload() {
    if (ctx.editing) { ctx.pendingReload = true; return; }
    load();
    ctx.notesApi.load();
  }

  function enhance() {
    const d = doc();
    if (!d) return;
    injectAffordanceStyle(d);
    ensureIds(d);
    ctx.manual.wire(d);
    ctx.notesApi.load();
    buildDock(ctx);
    ctx.manual.clearSelection();
  }
  iframe.addEventListener('load', enhance);

  return {
    el: root,
    ctx,
    get visible() { return !root.hidden; },
    open(deck) {
      ctx.deck = deck;
      filePath.textContent = deck.path;
      root.hidden = false;
      load();
    },
    hide() { root.hidden = true; },
  };
}
