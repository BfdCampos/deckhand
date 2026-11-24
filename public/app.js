/* Deckhand front-end. The parent page owns all editor UI; the deck itself
   stays pristine inside the iframe and is written back to disk on every change. */

const TEXT_SEL = 'h1,h2,h3,h4,h5,h6,p,li,blockquote,figcaption,[data-editable]';
const IMG_SEL = 'img';
const EDIT_SEL = TEXT_SEL + ',' + IMG_SEL;
const SLIDE_SEL = 'section,.slide,[data-slide],.reveal section';

const INJECT_STYLE = `
  [data-dh-hover]{outline:2px solid #3b82f688 !important; outline-offset:2px; cursor:default;}
  [contenteditable="true"]{outline:2px solid #3b82f6 !important; cursor:text;}
  * { -webkit-user-drag:none; }
`;

const $ = (s) => document.querySelector(s);
const el = (t, c) => { const e = document.createElement(t); if (c) e.className = c; return e; };

let ws, deck = { bound: false };
let notes = [];
let selected = null;      // element in iframe currently selected
let editing = null;       // element currently in text-edit mode
let pendingReload = false;
let saveTimer = null;
let idCounter = 0;

// ---- websocket -----------------------------------------------------------
function connect() {
  ws = new WebSocket(`ws://${location.host}/ws`);
  ws.onopen = () => setConn(true);
  ws.onclose = () => { setConn(false); setTimeout(connect, 800); };
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.type === 'bound') { deck = m.deck; if (deck.bound) initEditor(); }
    else if (m.type === 'deck-changed') reloadDeck();
    else if (m.type === 'run-queued') onRunQueued(m);
    else if (m.type === 'run-started') onRunStarted(m);
    else if (m.type === 'run-activity') onRunActivity(m);
    else if (m.type === 'run-done') onRunDone(m);
    else if (m.type === 'error') showLandingError(m.error);
  };
}
function setConn(live) { const c = $('#conn'); if (!c) return; c.textContent = live ? 'live' : 'reconnecting…'; c.classList.toggle('live', live); }
function wsSend(o) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); }

// ---- landing / picker ----------------------------------------------------
async function loadDir(dir) {
  const r = await fetch('/api/fs?dir=' + encodeURIComponent(dir || ''));
  const d = await r.json();
  if (d.error) return showLandingError(d.error);
  $('#picker-path').textContent = d.path;
  const list = $('#picker-list'); list.innerHTML = '';
  if (d.parent && d.parent !== d.path) list.appendChild(pickerRow('..', '⬆', () => loadDir(d.parent)));
  for (const e of d.entries) {
    if (e.isDir) list.appendChild(pickerRow(e.name, '📁', () => loadDir(d.path + '/' + e.name)));
    else list.appendChild(pickerRow(e.name, '📄', () => openDeck(d.path + '/' + e.name), 'html'));
  }
}
function pickerRow(name, ic, onClick, cls = '') {
  const row = el('div', 'picker-row ' + cls);
  row.innerHTML = `<span class="ic">${ic}</span><span>${name}</span>`;
  row.onclick = onClick;
  return row;
}
function showLandingError(msg) { const e = $('#landing-error'); if (e) e.textContent = msg || ''; }
async function openDeck(path) {
  const r = await fetch('/api/open', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path }) });
  const d = await r.json();
  if (d.error) return showLandingError(d.error);
  deck = d; initEditor();
}

// ---- editor bootstrap ----------------------------------------------------
function initEditor() {
  $('#landing').classList.add('hidden');
  $('#editor').classList.remove('hidden');
  $('#sb-file-path').textContent = deck.deckPath;
  const f = $('#deck');
  f.onload = enhance;
  f.src = deck.deckUrl + '?t=' + Date.now();
}
function openAnother() {
  const dir = deck.deckPath ? deck.deckPath.replace(/\/[^/]*$/, '') : '';
  showLandingError('');
  $('#editor').classList.add('hidden');
  $('#landing').classList.remove('hidden');
  loadDir(dir);
}
function reloadDeck() {
  const f = $('#deck');
  if (editing) { pendingReload = true; return; } // don't clobber an in-progress edit
  f.src = deck.deckUrl + '?t=' + Date.now();
  loadNotes();
}

function doc() { return $('#deck').contentDocument; }
function win() { return $('#deck').contentWindow; }

function enhance() {
  const d = doc();
  if (!d) return;
  // inject affordance styles (stripped before saving)
  let st = d.getElementById('dh-style');
  if (!st) { st = d.createElement('style'); st.id = 'dh-style'; d.head && d.head.appendChild(st); }
  st.textContent = INJECT_STYLE;

  ensureIds(d);
  wireDeckEvents(d);
  loadNotes();
  buildDock();
  clearSelection();
}

function ensureIds(d) {
  // Seed the counter past any ids already in the file so we never collide.
  d.querySelectorAll('[data-ai-id]').forEach((e) => { const m = /^dh(\d+)$/.exec(e.getAttribute('data-ai-id')); if (m) idCounter = Math.max(idCounter, +m[1]); });
  d.querySelectorAll(EDIT_SEL).forEach((e) => { if (!e.getAttribute('data-ai-id')) e.setAttribute('data-ai-id', 'dh' + (++idCounter)); });
}
function ensureId(e) { if (!e.getAttribute('data-ai-id')) e.setAttribute('data-ai-id', 'dh' + (++idCounter)); return e.getAttribute('data-ai-id'); }

// ---- deck event wiring ---------------------------------------------------
function wireDeckEvents(d) {
  d.addEventListener('mouseover', (e) => { const t = closestEditable(e.target); if (t && t !== editing) t.setAttribute('data-dh-hover', ''); });
  d.addEventListener('mouseout', (e) => { const t = closestEditable(e.target); if (t) t.removeAttribute('data-dh-hover'); });

  d.addEventListener('mousedown', onDeckMouseDown, true);
  d.addEventListener('dblclick', onDeckDblClick, true);
  d.addEventListener('contextmenu', onDeckContextMenu, true);
  d.addEventListener('paste', onDeckPaste, true);
  win().addEventListener('scroll', () => { }, true); // rects recomputed each tick
}

function closestEditable(node) { return node && node.closest ? node.closest(EDIT_SEL) : null; }
function slideIndexOf(node) {
  const slide = node.closest && node.closest(SLIDE_SEL);
  if (!slide) return null;
  const all = [...doc().querySelectorAll(SLIDE_SEL)];
  const i = all.indexOf(slide);
  return i >= 0 ? i + 1 : null;
}

// --- selection + drag ---
let drag = null;
function onDeckMouseDown(e) {
  dismissEmptyNotePop(); // clicking on the deck dismisses an empty note box
  if (editing) return;
  const t = closestEditable(e.target);
  if (!t) { clearSelection(); return; }
  if (e.button !== 0) return;
  select(t);
  e.preventDefault();
  const tr = parseTranslate(t);
  drag = { t, x0: e.clientX, y0: e.clientY, tx0: tr.x, ty0: tr.y, moved: false };
  const move = (ev) => {
    const dx = ev.clientX - drag.x0, dy = ev.clientY - drag.y0;
    if (!drag.moved && Math.hypot(dx, dy) < 4) return;
    drag.moved = true;
    drag.t.style.transform = `translate(${drag.tx0 + dx}px, ${drag.ty0 + dy}px)`;
  };
  const up = () => {
    doc().removeEventListener('mousemove', move, true);
    doc().removeEventListener('mouseup', up, true);
    if (drag.moved) commit();
    drag = null;
  };
  doc().addEventListener('mousemove', move, true);
  doc().addEventListener('mouseup', up, true);
}

function onDeckDblClick(e) {
  const t = e.target.closest(TEXT_SEL);
  if (!t) return;
  e.preventDefault();
  startEdit(t);
}

function startEdit(t) {
  clearSelection();
  editing = t;
  t.setAttribute('contenteditable', 'true');
  t.removeAttribute('data-dh-hover');
  t.focus();
  const onInput = () => scheduleSave();
  const onBlur = () => {
    t.removeAttribute('contenteditable');
    t.removeEventListener('input', onInput);
    t.removeEventListener('blur', onBlur);
    editing = null;
    commit();
    if (pendingReload) { pendingReload = false; reloadDeck(); }
  };
  t.addEventListener('input', onInput);
  t.addEventListener('blur', onBlur);
}

function select(t) { selected = t; }
function clearSelection() { selected = null; }

// ---- overlay render loop (selection box, handles, pins) ------------------
const pinEls = new Map(); // note id -> persistent pin element (so pins are stable click targets)
let selBox = null, handleEls = [];
function ovLayer(cls) { const ov = $('#overlay'); let l = ov.querySelector('.' + cls); if (!l) { l = el('div', cls); ov.appendChild(l); } return l; }

function tick() {
  requestAnimationFrame(tick);
  const ov = $('#overlay');
  const deckEl = $('#deck');
  if (!ov || !deckEl || !deck.bound || !doc()) { if (ov && ov.children.length) { ov.innerHTML = ''; pinEls.clear(); selBox = null; } return; }
  const fr = deckEl.getBoundingClientRect();
  positionChrome(fr);
  updatePins(fr);
}

// Selection box + resize handles persist across frames (so handles are grabbable).
function ensureChrome() {
  const layer = ovLayer('chrome');
  if (selBox && selBox.isConnected) return;
  layer.innerHTML = '';
  selBox = el('div', 'sel-box'); layer.appendChild(selBox);
  handleEls = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([cx, cy]) => {
    const h = el('div', 'handle'); h.dataset.cx = cx; h.dataset.cy = cy;
    h.onmousedown = (e) => startResize(e, selected, cx, cy);
    layer.appendChild(h);
    return h;
  });
}
function positionChrome(fr) {
  ensureChrome();
  const show = selected && selected.isConnected;
  selBox.style.display = show ? 'block' : 'none';
  const isImg = show && selected.matches(IMG_SEL);
  if (show) {
    const r = selected.getBoundingClientRect();
    Object.assign(selBox.style, { left: fr.left + r.left + 'px', top: fr.top + r.top + 'px', width: r.width + 'px', height: r.height + 'px' });
    handleEls.forEach((h) => {
      if (!isImg) { h.style.display = 'none'; return; }
      h.style.display = 'block';
      h.style.left = fr.left + r.left + (+h.dataset.cx) * r.width - 6 + 'px';
      h.style.top = fr.top + r.top + (+h.dataset.cy) * r.height - 6 + 'px';
    });
  } else {
    handleEls.forEach((h) => (h.style.display = 'none'));
  }
}

// Pins persist across frames (reconciled, not rebuilt) so they stay clickable.
function updatePins(fr) {
  const layer = ovLayer('pinlayer');
  const seen = new Set();
  notes.forEach((n, i) => {
    const pos = pinPos(n, fr);
    let p = pinEls.get(n.id);
    if (!pos) { if (p) { p.remove(); pinEls.delete(n.id); } return; }
    if (!p) {
      p = el('div', 'pin');
      p.onclick = (e) => { e.stopPropagation(); const cur = notes.find((x) => x.id === p._nid); if (cur) openPinPop(cur, p); };
      layer.appendChild(p);
      pinEls.set(n.id, p);
    }
    p._nid = n.id;
    p.textContent = i + 1;
    p.title = n.text;
    p.style.left = pos.x + 'px';
    p.style.top = pos.y + 'px';
    seen.add(n.id);
  });
  for (const [id, p] of pinEls) { if (!seen.has(id)) { p.remove(); pinEls.delete(id); } }
}

function pinPos(n, fr) {
  const w = win();
  const point = n.docX != null ? { x: fr.left + (n.docX - w.scrollX), y: fr.top + (n.docY - w.scrollY) } : null;
  const node = n.aiId ? doc().querySelector(`[data-ai-id="${n.aiId}"]`) : null;
  if (node && node.isConnected) {
    const r = node.getBoundingClientRect();
    // For a big target (a slide/section or a near-full-slide element) the top-right
    // corner is miles from where you clicked, so pin it at the click point instead.
    const big = node.matches(SLIDE_SEL) || r.width * r.height > 0.4 * fr.width * fr.height;
    if (big && point) return point;
    return { x: fr.left + r.right, y: fr.top + r.top };
  }
  return point;
}

function startResize(e, img, cx, cy) {
  e.preventDefault(); e.stopPropagation();
  if (!img || !img.matches(IMG_SEL)) return;
  const iframe = $('#deck');
  iframe.style.pointerEvents = 'none'; // stop the iframe swallowing mouse moves during the drag
  const r0 = img.getBoundingClientRect();
  const ratio = r0.width / r0.height;
  const x0 = e.clientX, w0 = r0.width;
  const move = (ev) => {
    const dir = cx === 1 ? 1 : -1;
    const w = Math.max(24, w0 + (ev.clientX - x0) * dir);
    img.style.width = Math.round(w) + 'px';
    img.style.height = Math.round(w / ratio) + 'px';
  };
  const up = () => {
    window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up);
    iframe.style.pointerEvents = '';
    commit();
  };
  window.addEventListener('mousemove', move); window.addEventListener('mouseup', up);
}

function parseTranslate(node) {
  const m = /translate\(\s*(-?[\d.]+)px\s*,\s*(-?[\d.]+)px/.exec(node.style.transform || '');
  return m ? { x: +m[1], y: +m[2] } : { x: 0, y: 0 };
}

// ---- notes ---------------------------------------------------------------
let noteTarget = null;
function onDeckContextMenu(e) {
  e.preventDefault();
  const editableT = closestEditable(e.target);
  const t = editableT || e.target;
  ensureId(t);
  const w = win();
  noteTarget = {
    el: t, aiId: t.getAttribute('data-ai-id'), tag: t.tagName.toLowerCase(),
    text: t.matches(IMG_SEL) ? (t.getAttribute('alt') || t.getAttribute('src') || '') : (t.innerText || '').trim(),
    docX: e.clientX + w.scrollX, docY: e.clientY + w.scrollY, slide: slideIndexOf(t),
  };
  const fr = $('#deck').getBoundingClientRect();
  openNotePop(fr.left + e.clientX, fr.top + e.clientY, noteTarget);
}
function openNotePop(x, y, tgt) {
  const pop = $('#note-pop');
  $('#note-pop-target').textContent = describeTarget(tgt);
  $('#note-pop-text').value = '';
  $('#note-scope').checked = false;
  pop.classList.remove('hidden');
  const w = pop.offsetWidth, h = pop.offsetHeight;
  pop.style.left = Math.min(x, innerWidth - w - 12) + 'px';
  pop.style.top = Math.min(y, innerHeight - h - 12) + 'px';
  $('#note-pop-text').focus();
}
function describeTarget(t) {
  const snip = t.text ? ` — "${t.text.slice(0, 60)}${t.text.length > 60 ? '…' : ''}"` : '';
  return `On <${t.tag}>${snip}`;
}
function saveNotePop() {
  const text = $('#note-pop-text').value.trim();
  if (!text || !noteTarget) return closeNotePop();
  notes.push({
    id: 'n' + Date.now(), aiId: noteTarget.aiId, targetTag: noteTarget.tag, targetText: noteTarget.text,
    scope: $('#note-scope').checked ? 'global' : 'element', text,
    docX: noteTarget.docX, docY: noteTarget.docY, slide: noteTarget.slide,
  });
  closeNotePop();
  renderNotes();
  persistNotes();
  commit(); // persist ids into the deck too
}
function closeNotePop() { $('#note-pop').classList.add('hidden'); noteTarget = null; }
// Clicking away dismisses the note box only when it's empty (don't lose typed text).
function dismissEmptyNotePop() { if (!$('#note-pop').classList.contains('hidden') && !$('#note-pop-text').value.trim()) closeNotePop(); }

function renderNotes() {
  $('#notes-count').textContent = notes.length;
  const list = $('#notes-list'); list.innerHTML = '';
  notes.forEach((n, i) => {
    const item = el('div', 'note-item'); item.id = 'note-' + n.id;
    const scope = n.scope === 'global' ? 'all similar' : n.targetTag;
    const st = runState[n.id];
    const actions = st === 'running' ? '<span class="n-run running">running…</span>'
      : st === 'queued' ? '<span class="n-run queued">queued</span>'
        : '<button data-act="run" class="run">Run</button><button data-act="edit">Edit</button><button data-act="del">Delete</button>';
    item.innerHTML = `
      <div class="n-top"><span class="n-badge">${i + 1}</span><span class="n-meta">${scope}${n.slide ? ' · slide ' + n.slide : ''}</span></div>
      <div class="n-text"></div>
      <div class="n-actions">${actions}</div>`;
    item.querySelector('.n-text').textContent = n.text;
    const run = item.querySelector('[data-act="run"]');
    if (run) run.onclick = () => runNote(n);
    const del = item.querySelector('[data-act="del"]');
    if (del) del.onclick = () => { notes = notes.filter((x) => x !== n); renderNotes(); persistNotes(); };
    const ed = item.querySelector('[data-act="edit"]');
    if (ed) ed.onclick = () => { const v = prompt('Edit note', n.text); if (v != null) { n.text = v.trim(); renderNotes(); persistNotes(); } };
    list.appendChild(item);
  });
}
function flash(node) { if (!node) return; node.style.transition = 'background .2s'; node.style.background = '#3b82f6'; setTimeout(() => (node.style.background = ''), 300); }

// Click a pin on the slide -> edit/delete that note inline.
let pinNote = null;
function openPinPop(n, pinEl) {
  pinNote = n;
  const pop = $('#pin-pop');
  $('#pin-pop-meta').textContent = (n.scope === 'global' ? 'all similar' : (n.targetTag || 'note')) + (n.slide ? ' · slide ' + n.slide : '');
  $('#pin-pop-text').value = n.text;
  pop.classList.remove('hidden');
  const r = pinEl.getBoundingClientRect();
  const w = pop.offsetWidth, h = pop.offsetHeight;
  let x = r.right + 8; if (x + w > innerWidth - 8) x = r.left - w - 8;
  let y = r.top; if (y + h > innerHeight - 8) y = innerHeight - h - 8;
  pop.style.left = Math.max(8, x) + 'px';
  pop.style.top = Math.max(8, y) + 'px';
  $('#pin-pop-text').focus();
}
function closePinPop() { $('#pin-pop').classList.add('hidden'); pinNote = null; }
function savePinPop() { if (!pinNote) return; pinNote.text = $('#pin-pop-text').value.trim(); renderNotes(); persistNotes(); closePinPop(); }
function deletePinNote() { if (!pinNote) return; notes = notes.filter((x) => x !== pinNote); renderNotes(); persistNotes(); closePinPop(); }

async function loadNotes() {
  if (!deck.bound) return;
  const stem = deck.base.replace(/\.html?$/i, '');
  try {
    const r = await fetch('/deckroot/' + encodeURIComponent(stem + '.deckhand.json') + '?t=' + Date.now());
    if (!r.ok) { notes = []; renderNotes(); return; }
    const d = await r.json();
    notes = d.notes || [];
  } catch { notes = []; }
  renderNotes();
}
function persistNotes() { wsSend({ type: 'save-notes', payload: { notes, layoutTweaks: computeTweaks() } }); }

function computeTweaks() {
  const out = [];
  const d = doc(); if (!d) return out;
  d.querySelectorAll(EDIT_SEL).forEach((e) => {
    const tr = parseTranslate(e);
    if (Math.abs(tr.x) > 0.5 || Math.abs(tr.y) > 0.5) out.push({ aiId: e.getAttribute('data-ai-id'), tag: e.tagName.toLowerCase(), kind: 'move', dx: tr.x, dy: tr.y });
    if (e.matches(IMG_SEL) && e.style.width) out.push({ aiId: e.getAttribute('data-ai-id'), kind: 'resize', w: parseFloat(e.style.width), h: parseFloat(e.style.height) || 0 });
  });
  return out;
}

// ---- add text / image / paste --------------------------------------------
function currentSlide() {
  const d = doc();
  const slides = [...d.querySelectorAll(SLIDE_SEL)];
  if (!slides.length) return d.body;
  const mid = win().scrollY + win().innerHeight / 2;
  return slides.find((s) => { const r = s.getBoundingClientRect(); const top = r.top + win().scrollY; return mid >= top && mid <= top + r.height; }) || slides[0] || d.body;
}
function addText() {
  const d = doc();
  const box = d.createElement('div');
  box.setAttribute('data-editable', ''); box.setAttribute('data-ai-id', 'dh' + (++idCounter));
  box.style.cssText = 'position:relative; padding:6px; min-width:80px; font-size:24px;';
  box.textContent = 'New text';
  currentSlide().appendChild(box);
  commit();
  startEdit(box);
  const range = d.createRange(); range.selectNodeContents(box); const sel = win().getSelection(); sel.removeAllRanges(); sel.addRange(range);
}
function addImage() {
  const inp = document.createElement('input'); inp.type = 'file'; inp.accept = 'image/*';
  inp.onchange = () => { const f = inp.files[0]; if (f) fileToDeck(f); };
  inp.click();
}
function onDeckPaste(e) {
  const items = e.clipboardData && e.clipboardData.items;
  if (!items) return;
  for (const it of items) { if (it.type.startsWith('image/')) { e.preventDefault(); fileToDeck(it.getAsFile()); return; } }
}
async function fileToDeck(file) {
  const dataUrl = await new Promise((res) => { const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(file); });
  const resp = await fetch('/api/asset', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: file.name, dataUrl }) });
  const { url, error } = await resp.json();
  if (error) return alert(error);
  const d = doc();
  const img = d.createElement('img');
  img.src = url; img.setAttribute('data-ai-id', 'dh' + (++idCounter)); img.style.maxWidth = '40%';
  currentSlide().appendChild(img);
  commit();
  select(img);
}

// ---- save (write-through) ------------------------------------------------
function scheduleSave() { clearTimeout(saveTimer); saveTimer = setTimeout(commit, 400); }
function commit() {
  clearTimeout(saveTimer);
  const d = doc(); if (!d) return;
  wsSend({ type: 'save-html', html: serializeDeck(d) });
  persistNotes();
}
function serializeDeck(d) {
  const root = d.documentElement.cloneNode(true);
  const st = root.querySelector('#dh-style'); if (st) st.remove();
  root.querySelectorAll('[contenteditable]').forEach((n) => { n.removeAttribute('contenteditable'); n.removeAttribute('spellcheck'); });
  root.querySelectorAll('[data-dh-hover]').forEach((n) => n.removeAttribute('data-dh-hover'));
  const dt = d.doctype ? `<!DOCTYPE ${d.doctype.name}>` : '<!DOCTYPE html>';
  return dt + '\n' + root.outerHTML;
}

// ---- slide dock ----------------------------------------------------------
function deckHeadHTML() {
  const d = doc(); let h = '';
  d.querySelectorAll('head style, head link[rel="stylesheet"]').forEach((n) => (h += n.outerHTML));
  return h;
}
function buildDock() {
  const dock = $('#dock'); dock.innerHTML = '';
  const slides = [...doc().querySelectorAll(SLIDE_SEL)];
  if (slides.length < 2) { dock.classList.add('hidden'); return; }
  const baseHref = location.origin + deck.deckUrl.replace(/[^/]*$/, ''); // absolute so srcdoc never resolves assets to root
  const head = deckHeadHTML();
  slides.forEach((slide, i) => {
    const tile = el('div', 'dock-tile');
    const frame = el('iframe', 'dock-thumb');
    frame.setAttribute('scrolling', 'no');
    frame.srcdoc = `<!DOCTYPE html><html><head><base href="${baseHref}">${head}<style>html,body{overflow:hidden!important;margin:0;scroll-snap-type:none}</style></head><body>${slide.outerHTML}</body></html>`;
    const num = el('div', 'tnum'); num.textContent = i + 1;
    tile.appendChild(frame); tile.appendChild(num);
    tile.onclick = () => slide.scrollIntoView({ behavior: 'smooth', block: 'start' });
    dock.appendChild(tile);
  });
  dock.classList.remove('hidden');
}

// ---- hand-off / run ------------------------------------------------------
async function fetchPrompt() { persistNotes(); const r = await fetch('/api/implement', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) }); return (await r.json()).prompt; }

function handoff() {
  if (!notes.length && !computeTweaks().length) return; // nothing to do
  persistNotes();
  fetch('/api/implement', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ run: true }) });
}
function runNote(n) {
  persistNotes();
  fetch('/api/run-note', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ note: { id: n.id, text: n.text, aiId: n.aiId, targetTag: n.targetTag, scope: n.scope, slide: n.slide } }) });
}

// ---- run state + streaming activity --------------------------------------
const runState = {};                      // note id ('' = whole deck) -> 'queued' | 'running'
const KG = (id) => (id == null ? '' : id);
function onRunQueued(m) { runState[KG(m.noteId)] = 'queued'; renderNotes(); }
function onRunStarted(m) {
  runState[KG(m.noteId)] = 'running';
  if (m.noteId == null) { const b = $('#implement'); b.disabled = true; b.textContent = 'Working…'; }
  renderNotes();
  showActivity(m.label);
}
function onRunActivity(m) { addActivity(m); }
function onRunDone(m) {
  delete runState[KG(m.noteId)];
  if (m.noteId == null) { const b = $('#implement'); b.disabled = false; b.textContent = 'Hand off to AI →'; }
  setActivityStatus(m.ok ? 'done' : 'error');
  if (m.ok) {
    notes = m.noteId == null ? [] : notes.filter((x) => x.id !== m.noteId);
    persistNotes();
  } else {
    addActivity({ kind: 'blocked', text: m.error || 'Run failed. You can copy the prompt and run it yourself.' });
  }
  renderNotes();
}
function showActivity(label) {
  const a = $('#activity'); a.classList.remove('hidden');
  $('#activity-log').innerHTML = '';
  setActivityStatus('working');
  addActivity({ kind: 'head', text: label });
}
function setActivityStatus(status) {
  const s = $('#activity-status');
  s.textContent = status === 'working' ? 'working… keep this open' : status === 'done' ? 'done ✓' : status === 'error' ? 'error' : '';
  s.className = 'count st-' + (status || 'idle');
}
function addActivity(m) {
  const log = $('#activity-log');
  const row = el('div', 'act ' + (m.kind || ''));
  row.textContent = (m.kind === 'tool' ? '› ' : '') + (m.text || '');
  log.appendChild(row);
  log.scrollTop = log.scrollHeight;
}

async function showPrompt() {
  $('#impl-prompt').textContent = await fetchPrompt();
  $('#impl-modal').classList.remove('hidden');
}
function toggleMenu(force) { $('#implement-menu').classList.toggle('hidden', force); }

// ---- boot ----------------------------------------------------------------
function boot() {
  connect();
  fetch('/api/state').then((r) => r.json()).then((s) => { if (s.bound) { deck = s; initEditor(); } else { loadDir(); } });

  $('#manual-open').onclick = () => openDeck($('#manual-path').value.trim());
  $('#manual-path').addEventListener('keydown', (e) => { if (e.key === 'Enter') openDeck($('#manual-path').value.trim()); });

  $('#tool-text').onclick = addText;
  $('#tool-image').onclick = addImage;
  $('#open-another').onclick = openAnother;

  $('#implement').onclick = handoff;
  $('#implement-caret').onclick = (e) => { e.stopPropagation(); toggleMenu(); };
  $('#menu-copy').onclick = async () => { toggleMenu(true); const p = await fetchPrompt(); await navigator.clipboard.writeText(p); };
  $('#menu-show').onclick = () => { toggleMenu(true); showPrompt(); };
  document.addEventListener('click', (e) => {
    toggleMenu(true);
    if (!$('#pin-pop').contains(e.target)) closePinPop();
    if (!$('#note-pop').contains(e.target)) dismissEmptyNotePop();
  });

  $('#note-save').onclick = saveNotePop;
  $('#note-cancel').onclick = closeNotePop;
  $('#note-pop-text').addEventListener('keydown', (e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') saveNotePop(); if (e.key === 'Escape') closeNotePop(); });

  $('#pin-save').onclick = savePinPop;
  $('#pin-delete').onclick = deletePinNote;
  $('#pin-pop-text').addEventListener('keydown', (e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') savePinPop(); if (e.key === 'Escape') closePinPop(); });

  $('#impl-close').onclick = () => $('#impl-modal').classList.add('hidden');
  $('#impl-copy').onclick = () => navigator.clipboard.writeText($('#impl-prompt').textContent).then(() => ($('#impl-copy').textContent = 'Copied ✓'));

  requestAnimationFrame(tick); // single persistent overlay render loop
}
boot();
