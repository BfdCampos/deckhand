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
    const tr = parseTranslate(t);
    drag = { t, x0: e.clientX, y0: e.clientY, tx0: tr.x, ty0: tr.y, moved: false, prevStyle: t.getAttribute('style') };
    const d = doc();
    const move = (ev) => {
      const dx = ev.clientX - drag.x0, dy = ev.clientY - drag.y0;
      if (!drag.moved && Math.hypot(dx, dy) < 4) return;
      drag.moved = true;
      drag.t.style.transform = `translate(${Math.round(drag.tx0 + dx)}px, ${Math.round(drag.ty0 + dy)}px)`;
    };
    const up = () => {
      d.removeEventListener('mousemove', move, true);
      d.removeEventListener('mouseup', up, true);
      const done = drag;
      drag = null;
      if (!done.moved) return;
      if (!ctx.canFinish()) { setStyleAttr(done.t, done.prevStyle); return; }
      saveStyle(done.t, done.prevStyle, { transform: done.t.style.transform });
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
    startEdit(t);
  }

  function startEdit(t) {
    clearSelection();
    ctx.editing = t;
    const before = cleanInner(t);
    t.setAttribute('contenteditable', 'true');
    t.removeAttribute('data-dh-hover');
    t.focus();
    const popEscape = pushEscape(() => { t.blur(); return true; });
    const onBlur = () => {
      popEscape();
      t.removeEventListener('blur', onBlur);
      t.removeAttribute('contenteditable');
      if (ctx.editing === t) ctx.editing = null;
      const after = cleanInner(t);
      if (after !== before && !ctx.canFinish()) {
        setInnerHtml(t, before);
      } else if (after !== before) {
        saver.apply(() => ({ type: 'setInner', aiId: aiIdOf(t), tag: t.tagName.toLowerCase(), before, after }), {
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
    img.setAttribute('style', 'max-width: 40%;');
    if (insertElement(img)) select(img);
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

  return { wire, select, clearSelection, startEdit, endEditing, startResize, addText, addImage, deleteSelected };
}
