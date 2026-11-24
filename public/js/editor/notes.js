import { h } from '../dom.js';
import { sendLegacy } from '../api.js';
import { doc, win, frameEl, closestEditable, ensureId, slideIndexOf, parseTranslate, EDIT_SEL, IMG_SEL } from './frame.js';

function describeTarget(t) {
  const snip = t.text ? `: "${t.text.slice(0, 60)}${t.text.length > 60 ? '…' : ''}"` : '';
  return `On <${t.tag}>${snip}`;
}

function placeWithin(pop, x, y) {
  const w = pop.offsetWidth, ht = pop.offsetHeight;
  pop.style.left = Math.min(x, innerWidth - w - 12) + 'px';
  pop.style.top = Math.min(y, innerHeight - ht - 12) + 'px';
}

export function mountNotes(ctx) {
  const count = h('span', { class: 'count' }, '0');
  const list = h('div', { class: 'notes-list' });
  ctx.slots.notes.append(h('div', { class: 'sb-title' }, 'Notes for the AI ', count), list);

  let noteTarget = null;
  const noteTargetLabel = h('div', { class: 'note-pop-target' });
  const noteText = h('textarea', { placeholder: 'Tell the AI what to change here…' });
  const noteScope = h('input', { type: 'checkbox' });
  const notePop = h('div', { class: 'note-pop', hidden: true },
    noteTargetLabel,
    noteText,
    h('label', { class: 'note-scope' }, noteScope, ' apply to all similar elements'),
    h('div', { class: 'note-pop-actions' },
      h('button', { type: 'button', class: 'ghost', onclick: closeNotePop }, 'Cancel'),
      h('button', { type: 'button', onclick: saveNotePop }, 'Add note'),
    ),
  );

  let pinNote = null;
  const pinMeta = h('div', { class: 'note-pop-target' });
  const pinText = h('textarea');
  const pinPop = h('div', { class: 'note-pop', hidden: true },
    pinMeta,
    pinText,
    h('div', { class: 'note-pop-actions' },
      h('button', { type: 'button', class: 'ghost', onclick: deletePinNote }, 'Delete'),
      h('button', { type: 'button', onclick: savePinPop }, 'Save'),
    ),
  );
  ctx.root.append(notePop, pinPop);

  noteText.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') saveNotePop();
    if (e.key === 'Escape') closeNotePop();
  });
  pinText.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') savePinPop();
    if (e.key === 'Escape') closePinPop();
  });
  document.addEventListener('click', (e) => {
    if (!pinPop.contains(e.target)) closePinPop();
    if (!notePop.contains(e.target)) dismissEmpty();
  });

  function openFromContextMenu(e) {
    e.preventDefault();
    const t = closestEditable(e.target) || e.target;
    ensureId(t);
    const w = win();
    noteTarget = {
      aiId: t.getAttribute('data-ai-id'),
      tag: t.tagName.toLowerCase(),
      text: t.matches(IMG_SEL) ? (t.getAttribute('alt') || t.getAttribute('src') || '') : (t.innerText || '').trim(),
      docX: e.clientX + w.scrollX,
      docY: e.clientY + w.scrollY,
      slide: slideIndexOf(t),
    };
    const fr = frameEl().getBoundingClientRect();
    noteTargetLabel.textContent = describeTarget(noteTarget);
    noteText.value = '';
    noteScope.checked = false;
    notePop.hidden = false;
    placeWithin(notePop, fr.left + e.clientX, fr.top + e.clientY);
    noteText.focus();
  }

  function saveNotePop() {
    const text = noteText.value.trim();
    if (!text || !noteTarget) return closeNotePop();
    ctx.notes.push({
      id: 'n' + Date.now(), aiId: noteTarget.aiId, targetTag: noteTarget.tag, targetText: noteTarget.text,
      scope: noteScope.checked ? 'global' : 'element', text,
      docX: noteTarget.docX, docY: noteTarget.docY, slide: noteTarget.slide,
    });
    closeNotePop();
    render();
    persist();
    ctx.commit();
  }

  function closeNotePop() { notePop.hidden = true; noteTarget = null; }
  function dismissEmpty() { if (!notePop.hidden && !noteText.value.trim()) closeNotePop(); }

  function openPinPop(n, pinEl) {
    pinNote = n;
    pinMeta.textContent = (n.scope === 'global' ? 'all similar' : (n.targetTag || 'note')) + (n.slide ? ' · slide ' + n.slide : '');
    pinText.value = n.text;
    pinPop.hidden = false;
    const r = pinEl.getBoundingClientRect();
    const w = pinPop.offsetWidth, ht = pinPop.offsetHeight;
    let x = r.right + 8; if (x + w > innerWidth - 8) x = r.left - w - 8;
    let y = r.top; if (y + ht > innerHeight - 8) y = innerHeight - ht - 8;
    pinPop.style.left = Math.max(8, x) + 'px';
    pinPop.style.top = Math.max(8, y) + 'px';
    pinText.focus();
  }

  function closePinPop() { pinPop.hidden = true; pinNote = null; }
  function savePinPop() { if (!pinNote) return; pinNote.text = pinText.value.trim(); render(); persist(); closePinPop(); }
  function deletePinNote() { if (!pinNote) return; remove(pinNote); closePinPop(); }

  function remove(n) {
    ctx.notes = ctx.notes.filter((x) => x !== n);
    render();
    persist();
  }

  function noteActions(n) {
    const st = ctx.runs && ctx.runs.stateOf(n.id);
    if (st === 'running') return h('span', { class: 'n-run running' }, 'running…');
    if (st === 'queued') return h('span', { class: 'n-run queued' }, 'queued');
    return [
      h('button', { type: 'button', class: 'run', onclick: () => ctx.runs.runNote(n) }, 'Run'),
      h('button', {
        type: 'button',
        onclick: () => {
          const v = prompt('Edit note', n.text);
          if (v != null) { n.text = v.trim(); render(); persist(); }
        },
      }, 'Edit'),
      h('button', { type: 'button', onclick: () => remove(n) }, 'Delete'),
    ];
  }

  function render() {
    count.textContent = ctx.notes.length;
    list.replaceChildren(...ctx.notes.map((n, i) => h('div', { class: 'note-item', id: 'note-' + n.id },
      h('div', { class: 'n-top' },
        h('span', { class: 'n-badge' }, String(i + 1)),
        h('span', { class: 'n-meta' }, (n.scope === 'global' ? 'all similar' : n.targetTag) + (n.slide ? ' · slide ' + n.slide : '')),
      ),
      h('div', { class: 'n-text' }, n.text),
      h('div', { class: 'n-actions' }, noteActions(n)),
    )));
  }

  async function load() {
    if (!ctx.deck) return;
    const stem = ctx.deck.name.replace(/\.html?$/i, '');
    try {
      const r = await fetch('/deckroot/' + encodeURIComponent(stem + '.deckhand.json') + '?t=' + Date.now());
      ctx.notes = r.ok ? ((await r.json()).notes || []) : [];
    } catch {
      ctx.notes = [];
    }
    render();
  }

  function computeTweaks() {
    const out = [];
    const d = doc();
    if (!d) return out;
    d.querySelectorAll(EDIT_SEL).forEach((e) => {
      const tr = parseTranslate(e);
      if (Math.abs(tr.x) > 0.5 || Math.abs(tr.y) > 0.5) out.push({ aiId: e.getAttribute('data-ai-id'), tag: e.tagName.toLowerCase(), kind: 'move', dx: tr.x, dy: tr.y });
      if (e.matches(IMG_SEL) && e.style.width) out.push({ aiId: e.getAttribute('data-ai-id'), kind: 'resize', w: parseFloat(e.style.width), h: parseFloat(e.style.height) || 0 });
    });
    return out;
  }

  function persist() {
    sendLegacy({ type: 'save-notes', payload: { notes: ctx.notes, layoutTweaks: computeTweaks() } });
  }

  return { load, render, persist, computeTweaks, openFromContextMenu, openPinPop, dismissEmpty };
}
