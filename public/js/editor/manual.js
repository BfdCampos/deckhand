import { api } from '../api.js';
import { toast } from '../ui/toast.js';
import { doc, win, frameEl, closestEditable, currentSlide, parseTranslate, nextId, TEXT_SEL, IMG_SEL } from './frame.js';

export function createManual(ctx) {
  let drag = null;

  function wire(d) {
    d.addEventListener('mouseover', (e) => {
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
    ctx.notesApi.dismissEmpty();
    if (ctx.editing) return;
    const t = closestEditable(e.target);
    if (!t) { clearSelection(); return; }
    if (e.button !== 0) return;
    select(t);
    e.preventDefault();
    const tr = parseTranslate(t);
    drag = { t, x0: e.clientX, y0: e.clientY, tx0: tr.x, ty0: tr.y, moved: false };
    const d = doc();
    const move = (ev) => {
      const dx = ev.clientX - drag.x0, dy = ev.clientY - drag.y0;
      if (!drag.moved && Math.hypot(dx, dy) < 4) return;
      drag.moved = true;
      drag.t.style.transform = `translate(${drag.tx0 + dx}px, ${drag.ty0 + dy}px)`;
    };
    const up = () => {
      d.removeEventListener('mousemove', move, true);
      d.removeEventListener('mouseup', up, true);
      if (drag.moved) ctx.commit();
      drag = null;
    };
    d.addEventListener('mousemove', move, true);
    d.addEventListener('mouseup', up, true);
  }

  function onDblClick(e) {
    const t = e.target.closest(TEXT_SEL);
    if (!t) return;
    e.preventDefault();
    startEdit(t);
  }

  function startEdit(t) {
    clearSelection();
    ctx.editing = t;
    t.setAttribute('contenteditable', 'true');
    t.removeAttribute('data-dh-hover');
    t.focus();
    const onInput = () => ctx.scheduleSave();
    const onBlur = () => {
      t.removeAttribute('contenteditable');
      t.removeEventListener('input', onInput);
      t.removeEventListener('blur', onBlur);
      ctx.editing = null;
      ctx.commit();
      if (ctx.pendingReload) { ctx.pendingReload = false; ctx.reload(); }
    };
    t.addEventListener('input', onInput);
    t.addEventListener('blur', onBlur);
  }

  function startResize(e, img, cx) {
    e.preventDefault();
    e.stopPropagation();
    if (!img || !img.matches(IMG_SEL)) return;
    const iframe = frameEl();
    iframe.style.pointerEvents = 'none';
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
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      iframe.style.pointerEvents = '';
      ctx.commit();
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  }

  function addText() {
    const d = doc();
    const box = d.createElement('div');
    box.setAttribute('data-editable', '');
    box.setAttribute('data-ai-id', nextId());
    box.style.cssText = 'position:relative; padding:6px; min-width:80px; font-size:24px;';
    box.textContent = 'New text';
    currentSlide().appendChild(box);
    ctx.commit();
    startEdit(box);
    const range = d.createRange();
    range.selectNodeContents(box);
    const sel = win().getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }

  function addImage() {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = 'image/*';
    inp.onchange = () => { const f = inp.files[0]; if (f) fileToDeck(f); };
    inp.click();
  }

  function onPaste(e) {
    const items = e.clipboardData && e.clipboardData.items;
    if (!items) return;
    for (const it of items) {
      if (it.type.startsWith('image/')) { e.preventDefault(); fileToDeck(it.getAsFile()); return; }
    }
  }

  async function fileToDeck(file) {
    let url;
    try {
      ({ url } = await api.upload(file));
    } catch (err) {
      toast(err.message, { tone: 'error' });
      return;
    }
    const img = doc().createElement('img');
    img.src = url;
    img.setAttribute('data-ai-id', nextId());
    img.style.maxWidth = '40%';
    currentSlide().appendChild(img);
    ctx.commit();
    select(img);
  }

  return { wire, select, clearSelection, startEdit, startResize, addText, addImage };
}
