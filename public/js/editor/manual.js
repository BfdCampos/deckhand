import { api } from '../api.js';
import { toast } from '../ui/toast.js';
import { pushEscape } from '../ui/escape.js';
import {
  doc, win, frameEl, closestEditable, currentSlide, parseTranslate, aiIdOf, cleanInner, setInnerHtml,
  setStyleAttr, TEXT_SEL, IMG_SEL,
} from './frame.js';

const UNANCHORED = "Deckhand can't save changes to this element, because the deck's own script made it. Leave a note instead.";
const UPLOAD_COPY = {
  too_large: 'That image is over 20 MB. Try a smaller one.',
  not_image: "That file isn't an image Deckhand can use.",
};

export function createManual(ctx) {
  const saver = ctx.saver;
  let drag = null;

  function wire(d) {
    d.addEventListener('mouseover', (e) => {
      if (!ctx.canEdit()) return;
      const t = closestEditable(e.target);
      if (t && t !== ctx.editing) t.setAttribute('data-dh-hover', '');
    });
    d.addEventListener('mouseout', (e) => {
      const t = closestEditable(e.target);
      if (t) t.removeAttribute('data-dh-hover');
    });
    d.addEventListener('mousedown', onMouseDown, true);
    d.addEventListener('dblclick', onDblClick, true);
    d.addEventListener('contextmenu', (e) => ctx.notesApi.openFromContextMenu(e), true);
    d.addEventListener('paste', onPaste, true);
    d.addEventListener('click', (e) => {
      const link = e.target.closest && e.target.closest('a[href]');
      if (link && !link.getAttribute('href').startsWith('#')) e.preventDefault();
    }, true);
  }

  function select(t) { ctx.selected = t; }
  function clearSelection() { ctx.selected = null; }

  function onMouseDown(e) {
    if (ctx.editing || e.button !== 0) return;
    const t = closestEditable(e.target);
    if (!t) { clearSelection(); return; }
    if (!ctx.canEdit()) return;
    select(t);
    e.preventDefault();
    if (document.activeElement && document.activeElement !== document.body && document.activeElement !== frameEl()) document.activeElement.blur();
    const tr = parseTranslate(t);
    drag = { t, x0: e.clientX, y0: e.clientY, tx0: tr.x, ty0: tr.y, moved: false, prevStyle: t.getAttribute('style') };
    const d = doc();
    const move = (ev) => {
      const dx = ev.clientX - drag.x0, dy = ev.clientY - drag.y0;
      if (!drag.moved && Math.hypot(dx, dy) < 4) return;
      drag.moved = true;
      drag.value = `${Math.round(drag.tx0 + dx)}px ${Math.round(drag.ty0 + dy)}px`;
      drag.t.style.translate = drag.value;
    };
    const up = () => {
      d.removeEventListener('mousemove', move, true);
      d.removeEventListener('mouseup', up, true);
      const done = drag;
      drag = null;
      if (!done.moved) return;
      if (!ctx.canFinish()) { setStyleAttr(done.t, done.prevStyle); return; }
      saveStyle(done.t, done.prevStyle, { translate: done.value });
    };
    d.addEventListener('mousemove', move, true);
    d.addEventListener('mouseup', up, true);
  }

  function saveStyle(el, prevStyle, props) {
    if (!aiIdOf(el)) {
      setStyleAttr(el, prevStyle);
      toast(UNANCHORED, { tone: 'error' });
      return;
    }
    let saved = null;
    saver.apply(() => ({ type: 'setStyle', aiId: aiIdOf(el), tag: el.tagName.toLowerCase(), props }), {
      rollback: () => setStyleAttr(el, prevStyle),
      onResult: (r) => { saved = r.style ?? el.getAttribute('style'); setStyleAttr(el, saved); },
      undo: () => setStyleAttr(el, prevStyle),
      redo: () => setStyleAttr(el, saved),
    });
  }

  function onDblClick(e) {
    const t = e.target.closest(TEXT_SEL);
    if (!t) return;
    e.preventDefault();
    if (!ctx.canEdit()) return;
    if (!aiIdOf(t)) { toast(UNANCHORED, { tone: 'error' }); return; }
    startEdit(t, { x: e.clientX, y: e.clientY });
  }

  const WORD_CHAR = /[\p{L}\p{N}_'’-]/u;

  function rangeAtPoint(d, x, y) {
    if (d.caretRangeFromPoint) return d.caretRangeFromPoint(x, y);
    const pos = d.caretPositionFromPoint?.(x, y);
    if (!pos) return null;
    const r = d.createRange();
    r.setStart(pos.offsetNode, pos.offset);
    return r;
  }

  function placeCaret(t, point) {
    const d = doc();
    let range = point ? rangeAtPoint(d, point.x, point.y) : null;
    if (!range || !t.contains(range.startContainer)) {
      range = d.createRange();
      range.selectNodeContents(t);
      range.collapse(false);
    } else if (range.startContainer.nodeType === Node.TEXT_NODE) {
      const node = range.startContainer;
      let start = range.startOffset;
      let end = start;
      while (start > 0 && WORD_CHAR.test(node.data[start - 1])) start--;
      while (end < node.data.length && WORD_CHAR.test(node.data[end])) end++;
      if (end > start) {
        const word = d.createRange();
        word.setStart(node, start);
        word.setEnd(node, end);
        const box = word.getBoundingClientRect();
        if (point.x >= box.left && point.x <= box.right && point.y >= box.top && point.y <= box.bottom) range = word;
      }
    }
    const sel = win().getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }

  function innerOf(t) {
    const html = cleanInner(t);
    return /^\s*<br\s*\/?>\s*$/i.test(html) ? '' : html;
  }

  function currentRange() {
    const sel = win().getSelection();
    return sel && sel.rangeCount ? sel.getRangeAt(0) : null;
  }

  const caretHolders = new Set();

  function setCaret(node, offset) {
    const range = doc().createRange();
    range.setStart(node, offset);
    range.collapse(true);
    const sel = win().getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }

  function insertNodes(nodes) {
    const range = currentRange();
    if (!range || !nodes.length) return;
    range.deleteContents();
    const frag = doc().createDocumentFragment();
    for (const n of nodes) frag.appendChild(n);
    const last = nodes[nodes.length - 1];
    range.insertNode(frag);
    if (last.nodeType === Node.TEXT_NODE) {
      setCaret(last, last.data.length);
    } else {
      const holder = doc().createTextNode('\u200B');
      caretHolders.add(holder);
      last.after(holder);
      setCaret(holder, 1);
    }
    ctx.editing?.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function releaseCaretHolders() {
    for (const holder of caretHolders) {
      if (holder.isConnected) {
        const data = holder.data.replace('\u200B', '');
        if (data) holder.data = data;
        else holder.remove();
      }
    }
    caretHolders.clear();
  }

  function insertLineBreak() {
    insertNodes([doc().createElement('br')]);
  }

  function insertPlainText(text) {
    const d = doc();
    const nodes = [];
    text.replace(/\r\n?/g, '\n').split('\n').forEach((line, i) => {
      if (i) nodes.push(d.createElement('br'));
      if (line) nodes.push(d.createTextNode(line));
    });
    insertNodes(nodes);
  }

  function onEditKeyDown(e) {
    if (e.key !== 'Enter' || e.isComposing) return;
    e.preventDefault();
    if (e.shiftKey) insertLineBreak();
    else e.currentTarget.blur();
  }

  function onEditBeforeInput(e) {
    if (e.inputType.startsWith('format')) { e.preventDefault(); return; }
    if (e.inputType !== 'insertText' || !e.data) return;
    const range = currentRange();
    if (!range) return;
    const start = range.startContainer.nodeType === Node.TEXT_NODE ? range.startContainer.parentElement : range.startContainer;
    const link = start && start.closest('a');
    if (!link || !e.currentTarget.contains(link)) return;
    e.preventDefault();
    range.deleteContents();
    let node = range.startContainer;
    if (node.nodeType === Node.TEXT_NODE) {
      node.insertData(range.startOffset, e.data);
      const at = doc().createRange();
      at.setStart(node, range.startOffset + e.data.length);
      at.collapse(true);
      win().getSelection().removeAllRanges();
      win().getSelection().addRange(at);
    } else {
      const text = doc().createTextNode(e.data);
      range.insertNode(text);
      setCaret(text, text.data.length);
    }
    e.currentTarget.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function onEditPaste(e) {
    e.preventDefault();
    e.stopPropagation();
    const data = e.clipboardData;
    if (!data) return;
    const image = [...data.items].find((it) => it.kind === 'file' && it.type.startsWith('image/'));
    if (image) {
      const file = image.getAsFile();
      if (file) fileToDeck(file);
      return;
    }
    const text = data.getData('text/plain');
    if (text) insertPlainText(text);
  }

  function onEditDrop(e) {
    e.preventDefault();
    const text = e.dataTransfer && e.dataTransfer.getData('text/plain');
    if (text) insertPlainText(text);
  }

  function startEdit(t, point = null) {
    clearSelection();
    ctx.editing = t;
    const before = innerOf(t);
    const startRev = ctx.rev;
    t.setAttribute('contenteditable', 'true');
    t.removeAttribute('data-dh-hover');
    t.addEventListener('keydown', onEditKeyDown);
    t.addEventListener('beforeinput', onEditBeforeInput);
    t.addEventListener('paste', onEditPaste);
    t.addEventListener('drop', onEditDrop);
    t.focus();
    if (point) placeCaret(t, point);
    const popEscape = pushEscape(() => { t.blur(); return true; });
    const onBlur = () => {
      popEscape();
      t.removeEventListener('blur', onBlur);
      t.removeEventListener('keydown', onEditKeyDown);
      t.removeEventListener('beforeinput', onEditBeforeInput);
      t.removeEventListener('paste', onEditPaste);
      t.removeEventListener('drop', onEditDrop);
      t.removeAttribute('contenteditable');
      if (ctx.editing === t) ctx.editing = null;
      releaseCaretHolders();
      const after = innerOf(t);
      if (after !== cleanInner(t)) setInnerHtml(t, after);
      if (after !== before && !ctx.canFinish()) {
        setInnerHtml(t, before);
      } else if (after !== before) {
        saver.applyText(t, {
          before,
          after,
          baseRev: startRev,
          rollback: () => setInnerHtml(t, before),
          undo: () => setInnerHtml(t, before),
          redo: () => setInnerHtml(t, after),
        });
      }
      ctx.editEnded();
    };
    t.addEventListener('blur', onBlur);
  }

  function endEditing() {
    if (ctx.editing) ctx.editing.blur();
  }

  function startResize(e, img, cx) {
    e.preventDefault();
    e.stopPropagation();
    if (!img || !img.matches(IMG_SEL) || !ctx.canEdit()) return;
    const iframe = frameEl();
    iframe.style.pointerEvents = 'none';
    const prevStyle = img.getAttribute('style');
    const r0 = img.getBoundingClientRect();
    const ratio = r0.width / r0.height;
    const x0 = e.clientX, w0 = r0.width;
    let changed = false;
    const move = (ev) => {
      const dir = cx === 1 ? 1 : -1;
      const w = Math.max(24, w0 + (ev.clientX - x0) * dir);
      img.style.width = Math.round(w) + 'px';
      img.style.height = Math.round(w / ratio) + 'px';
      changed = true;
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      iframe.style.pointerEvents = '';
      if (!changed) return;
      if (!ctx.canFinish()) { setStyleAttr(img, prevStyle); return; }
      saveStyle(img, prevStyle, { width: img.style.width, height: img.style.height });
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  }

  function insertElement(el, { onSaved } = {}) {
    const slide = currentSlide();
    const parent = slide === doc().body ? null : slide;
    if (parent && !aiIdOf(parent)) { toast(UNANCHORED, { tone: 'error' }); return false; }
    const html = el.outerHTML;
    slide.appendChild(el);
    saver.apply(() => ({ type: 'insert', parentAiId: parent ? aiIdOf(parent) : null, html }), {
      rollback: () => { el.remove(); if (ctx.selected === el) clearSelection(); },
      onResult: (r) => { el.setAttribute('data-ai-id', r.aiId); onSaved?.(); },
      undo: () => { el.remove(); if (ctx.selected === el) clearSelection(); },
      redo: () => slide.appendChild(el),
    });
    return true;
  }

  function addText() {
    if (!ctx.canEdit()) return;
    endEditing();
    const d = doc();
    const box = d.createElement('div');
    box.setAttribute('data-editable', '');
    box.setAttribute('style', 'position: relative; padding: 6px; min-width: 80px; font-size: 24px;');
    box.textContent = 'New text';
    if (!insertElement(box)) return;
    startEdit(box);
    const range = d.createRange();
    range.selectNodeContents(box);
    const sel = win().getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }

  function addImage() {
    if (!ctx.canEdit()) return;
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = 'image/png,image/jpeg,image/gif,image/webp,image/svg+xml';
    inp.onchange = () => { const f = inp.files[0]; if (f) fileToDeck(f); };
    inp.click();
  }

  function onPaste(e) {
    if (ctx.editing) return;
    const items = e.clipboardData && e.clipboardData.items;
    if (!items) return;
    for (const it of items) {
      if (it.kind === 'file' && it.type.startsWith('image/')) {
        e.preventDefault();
        if (ctx.canEdit()) fileToDeck(it.getAsFile());
        return;
      }
    }
  }

  async function fileToDeck(file) {
    let url;
    try {
      ({ url } = await api.upload(file));
    } catch (err) {
      toast(UPLOAD_COPY[err.code] || err.message, { tone: 'error' });
      return;
    }
    const img = doc().createElement('img');
    img.setAttribute('src', url);
    const slide = currentSlide();
    if (slide === doc().body || !aiIdOf(slide)) {
      await floatOverPage(img, slide);
      if (insertElement(img)) select(img);
      return;
    }
    const prevSlideStyle = slide.getAttribute('style');
    const needsRelative = win().getComputedStyle(slide).position === 'static';
    if (needsRelative) slide.style.position = 'relative';
    await floatOverSlide(img, slide);
    const html = img.outerHTML;
    slide.appendChild(img);
    let slideStyle = slide.getAttribute('style');
    const removeImage = () => { img.remove(); if (ctx.selected === img) clearSelection(); };
    saver.apply(() => [
      ...(needsRelative ? [{ type: 'setStyle', aiId: aiIdOf(slide), tag: slide.tagName.toLowerCase(), props: { position: 'relative' } }] : []),
      { type: 'insert', parentAiId: aiIdOf(slide), html },
    ], {
      rollback: () => { removeImage(); setStyleAttr(slide, prevSlideStyle); },
      onResult: (results) => {
        const insert = results[results.length - 1];
        if (needsRelative) { slideStyle = results[0].style ?? slideStyle; setStyleAttr(slide, slideStyle); }
        img.setAttribute('data-ai-id', insert.aiId);
      },
      undo: () => { removeImage(); setStyleAttr(slide, prevSlideStyle); },
      redo: () => { setStyleAttr(slide, slideStyle); slide.appendChild(img); },
    });
    select(img);
  }

  function topLayer(slide) {
    let top = 0;
    for (const el of slide.querySelectorAll('*')) {
      const z = parseInt(win().getComputedStyle(el).zIndex, 10);
      if (Number.isFinite(z)) top = Math.max(top, z);
    }
    return Math.min(top + 1, 2147483000);
  }

  async function measure(img, host) {
    img.setAttribute('style', 'position: absolute; left: 0px; top: 0px; visibility: hidden;');
    host.appendChild(img);
    try { await img.decode(); } catch { /* measure whatever loaded */ }
    const natural = { w: img.naturalWidth || 320, h: img.naturalHeight || 180 };
    img.remove();
    return natural;
  }

  async function floatOverSlide(img, slide) {
    const z = topLayer(slide);
    const natural = await measure(img, slide);
    const s = slide.getBoundingClientRect();
    const cw = slide.clientWidth || s.width;
    const ch = slide.clientHeight || s.height;
    const width = Math.min(natural.w, cw * 0.4);
    const height = width * (natural.h / natural.w);
    const view = win().innerHeight;
    const visibleTop = Math.max(s.top, 0);
    const visibleBottom = Math.min(s.bottom, view);
    const centreY = (visibleTop + visibleBottom) / 2 - s.top;
    const top = Math.max(0, Math.min(ch - height, centreY - height / 2));
    const left = (cw - width) / 2;
    const pct = (v, of) => `${Math.round((v / of) * 10000) / 100}%`;
    img.setAttribute('style', `position: absolute; left: ${pct(left, cw)}; top: ${pct(top, ch)}; width: ${pct(width, cw)}; z-index: ${z};`);
  }

  async function floatOverPage(img, host) {
    const natural = await measure(img, host);
    const view = { w: win().innerWidth, h: win().innerHeight };
    const width = Math.min(natural.w, view.w * 0.4);
    img.setAttribute('style', 'position: absolute; left: 0px; top: 0px; visibility: hidden; width: ' + Math.round(width) + 'px;');
    host.appendChild(img);
    const r = img.getBoundingClientRect();
    const left = Math.round((view.w - r.width) / 2 - r.left);
    const top = Math.round((view.h - r.height) / 2 - r.top);
    img.remove();
    img.setAttribute('style', `position: absolute; left: ${left}px; top: ${top}px; width: ${Math.round(r.width)}px; z-index: ${topLayer(host)};`);
  }

  function deleteSelected() {
    const t = ctx.selected;
    if (!t || !t.isConnected || ctx.editing || !ctx.canEdit()) return;
    if (!aiIdOf(t)) { toast(UNANCHORED, { tone: 'error' }); return; }
    const parent = t.parentNode;
    const next = t.nextSibling;
    const aiId = aiIdOf(t);
    const tag = t.tagName.toLowerCase();
    clearSelection();
    t.remove();
    const restore = () => parent.insertBefore(t, next && next.parentNode === parent ? next : null);
    saver.apply({ type: 'remove', aiId, tag }, {
      rollback: restore,
      undo: restore,
      redo: () => { t.remove(); if (ctx.selected === t) clearSelection(); },
    });
  }

  function onAppPaste(e) {
    if (ctx.editing || !ctx.canEdit()) return;
    const items = e.clipboardData && e.clipboardData.items;
    if (!items) return;
    for (const it of items) {
      if (it.kind === 'file' && it.type.startsWith('image/')) {
        e.preventDefault();
        fileToDeck(it.getAsFile());
        return;
      }
    }
  }

  return { wire, select, clearSelection, startEdit, endEditing, startResize, addText, addImage, deleteSelected, onAppPaste, innerOf };
}
