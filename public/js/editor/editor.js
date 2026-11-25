import { h } from '../dom.js';
import { onEvent, sendLegacy } from '../api.js';
import { store } from '../store.js';
import { icon } from '../ui/icons.js';
import { setToastHost } from '../ui/toast.js';
import { attachEscape } from '../ui/escape.js';
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
  const filePath = h('span', { class: 'sb-file-path t-meta' });
  const connDot = h('span', { class: 'dot' });
  const connLabel = h('span', null);
  const conn = h('span', { class: 'conn t-meta' }, connDot, connLabel);
  const stage = h('div', { class: 'stage' }, iframe, overlayEl, dockEl);

  const slots = {
    tools: h('div', { class: 'sb-tools' }),
    notes: h('div', { class: 'sb-section' }),
    activity: h('div', { class: 'sb-section activity' }),
    footer: h('div', { class: 'sb-foot' }),
  };

  const sidebar = h('aside', { class: 'sidebar' },
    h('div', { class: 'sb-head' },
      h('span', { class: 'brand-lockup' }, h('span', { class: 'brand-mark' }, icon('anchor')), 'Deckhand'),
      conn,
    ),
    h('div', { class: 'sb-file' },
      filePath,
      h('button', { type: 'button', class: 'link link-btn', title: 'Open a different presentation', onclick: () => onHome() }, 'Open another deck →'),
    ),
    slots.tools,
    slots.notes,
    slots.activity,
    slots.footer,
  );

  const root = h('div', { class: 'editor', hidden: true }, stage, sidebar);

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

  let elsewhere = null;
  const elsewhereText = h('p', { class: 'editor-elsewhere-text' });
  const switchBtn = h('button', { type: 'button', class: 'btn btn-primary' }, 'Switch to it');
  const homeBtn = h('button', { type: 'button', class: 'btn btn-secondary' }, icon('home'), 'Go Home');
  const notice = h('div', { class: 'editor-elsewhere', role: 'alertdialog', 'aria-labelledby': 'editor-elsewhere-text', hidden: true },
    h('div', { class: 'editor-elsewhere-card' },
      h('span', { class: 'editor-elsewhere-icon' }, icon('alert')),
      elsewhereText,
      h('p', { class: 't-small text-muted' }, "Edits here are paused so nothing is saved into the wrong file."),
      h('div', { class: 'editor-elsewhere-actions' }, homeBtn, switchBtn)));
  elsewhereText.id = 'editor-elsewhere-text';
  root.append(notice);

  function clearElsewhere() {
    elsewhere = null;
    stage.inert = false;
    sidebar.inert = false;
    notice.hidden = true;
  }

  bindFrame(iframe);
  ctx.manual = createManual(ctx);
  ctx.notesApi = mountNotes(ctx);
  ctx.runs = mountRuns(ctx);
  mountOverlay(ctx);

  slots.tools.append(
    h('div', { class: 'tools' },
      h('button', { type: 'button', class: 'btn btn-secondary', title: 'Add a text box', onclick: () => ctx.manual.addText() }, icon('plus'), 'Text'),
      h('button', { type: 'button', class: 'btn btn-secondary', title: 'Add an image', onclick: () => ctx.manual.addImage() }, icon('image'), 'Image'),
    ),
    h('p', { class: 'tools-hint t-meta' }, 'Single-click to select · double-click text to edit · drag to move · right-click anything to leave a note for the AI · paste an image anywhere.'),
  );

  const CONN_DOT = { connecting: 'dot', live: 'dot dot-success', reconnecting: 'dot dot-warning' };
  const showConn = (s) => { connLabel.textContent = CONN_LABEL[s.conn] || ''; connDot.className = CONN_DOT[s.conn] || 'dot'; };
  store.subscribe(showConn);
  showConn(store.get());

  onEvent((m) => { if (m.type === 'deck-changed' && ctx.deck && !root.hidden) reload(); });

  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(commit, 400);
  }

  function commit() {
    clearTimeout(saveTimer);
    if (!doc() || elsewhere) return;
    sendLegacy({ type: 'save-html', html: serializeDeck() });
    ctx.notesApi.persist();
  }

  function load() {
    const url = ctx.deck.url + '?t=' + Date.now();
    if (iframe.contentWindow) iframe.contentWindow.location.replace(url);
    else iframe.src = url;
  }

  function reload() {
    if (elsewhere) return;
    if (ctx.editing) { ctx.pendingReload = true; return; }
    load();
    ctx.notesApi.load();
  }

  function enhance() {
    const d = doc();
    if (!d || root.hidden || d.URL === 'about:blank') return;
    injectAffordanceStyle(d);
    attachEscape(d);
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
    stage,
    get visible() { return !root.hidden; },
    get deck() { return ctx.deck; },
    showElsewhere(deck, { onSwitch, onHome }) {
      clearTimeout(saveTimer);
      elsewhere = deck;
      stage.inert = true;
      sidebar.inert = true;
      elsewhereText.textContent = `Another tab opened ${deck.name || deck.path.split('/').pop()}.`;
      switchBtn.onclick = onSwitch;
      homeBtn.onclick = onHome;
      notice.hidden = false;
      switchBtn.focus();
    },
    open(deck) {
      clearElsewhere();
      ctx.deck = deck;
      filePath.textContent = deck.path;
      root.hidden = false;
      setToastHost(stage);
      load();
    },
    hide() {
      clearElsewhere();
      root.hidden = true;
      iframe.contentWindow?.location.replace('about:blank');
      setToastHost(null);
    },
  };
}
