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

  function insertPlainText(text) {
    const d = doc();
    const lines = text.replace(/\r\n?/g, '\n').split('\n');
    lines.forEach((line, i) => {
      if (i) d.execCommand('insertLineBreak');
      if (line) d.execCommand('insertText', false, line);
    });
  }

  function onEditKeyDown(e) {
    if (e.key !== 'Enter' || e.isComposing) return;
    e.preventDefault();
    if (e.shiftKey) doc().execCommand('insertLineBreak');
    else e.currentTarget.blur();
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
    t.addEventListener('paste', onEditPaste);
    t.addEventListener('drop', onEditDrop);
    t.focus();
    if (point) placeCaret(t, point);
    const popEscape = pushEscape(() => { t.blur(); return true; });
    const onBlur = () => {
      popEscape();
      t.removeEventListener('blur', onBlur);
      t.removeEventListener('keydown', onEditKeyDown);
      t.removeEventListener('paste', onEditPaste);
      t.removeEventListener('drop', onEditDrop);
      t.removeAttribute('contenteditable');
      if (ctx.editing === t) ctx.editing = null;
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
    await floatOverSlide(img, currentSlide());
    if (insertElement(img)) select(img);
  }

  async function floatOverSlide(img, slide) {
    img.setAttribute('style', 'position: absolute; left: 0px; top: 0px; max-width: 40%; visibility: hidden;');
    slide.appendChild(img);
    try { await img.decode(); } catch { /* measure whatever loaded */ }
    const s = slide.getBoundingClientRect();
    const view = win().innerHeight;
    const visibleTop = Math.max(s.top, 0);
    const visibleBottom = Math.min(s.bottom, view);
    const maxWidth = Math.min(img.naturalWidth || 320, s.width * 0.4);
    img.style.maxWidth = '';
    img.style.width = `${Math.round(maxWidth)}px`;
    const r = img.getBoundingClientRect();
    const left = Math.round(s.left + (s.width - r.width) / 2 - r.left);
    const top = Math.round(Math.max(s.top, visibleTop + (visibleBottom - visibleTop - r.height) / 2) - r.top);
    img.remove();
    img.setAttribute('style', `position: absolute; left: ${left}px; top: ${top}px; width: ${Math.round(r.width)}px; max-width: 40%;`);
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
