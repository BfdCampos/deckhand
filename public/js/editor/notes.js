import { h } from '../dom.js';
import { sendLegacy } from '../api.js';
import { icon } from '../ui/icons.js';
import { openPopover } from '../ui/popover.js';
import { doc, win, frameEl, closestEditable, ensureId, slideIndexOf, parseTranslate, EDIT_SEL, IMG_SEL } from './frame.js';

const MOD = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl';

function targetLabel(t) {
  const snip = t.text ? `'${t.text.slice(0, 60)}${t.text.length > 60 ? '…' : ''}'` : '';
  return h('div', { class: 't-meta' }, `On <${t.tag}>`, snip ? ': ' : '', snip ? h('span', { class: 'text-ink' }, snip) : null);
}

function noteMeta(n) {
  return (n.scope === 'global' ? 'all similar' : (n.targetTag || 'note')) + (n.slide ? ' · slide ' + n.slide : '');
}

export function mountNotes(ctx) {
  const count = h('span', { class: 'pill-count' }, '0');
  const list = h('div', { class: 'notes-list' });
  ctx.slots.notes.append(h('div', { class: 'sb-title' }, h('span', { class: 't-label' }, 'Notes for the AI'), count), list);

  let notePop = null;
  let pinPop = null;

  function submitOnModEnter(field, submit) {
    field.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); submit(); }
    });
  }

  function openFromContextMenu(e) {
    e.preventDefault();
    const t = closestEditable(e.target) || e.target;
    ensureId(t);
    const w = win();
    const target = {
      aiId: t.getAttribute('data-ai-id'),
      tag: t.tagName.toLowerCase(),
      text: t.matches(IMG_SEL) ? (t.getAttribute('alt') || t.getAttribute('src') || '') : (t.innerText || '').trim(),
      docX: e.clientX + w.scrollX,
      docY: e.clientY + w.scrollY,
      slide: slideIndexOf(t),
    };
    if (notePop) notePop.close();
    if (pinPop) pinPop.close();

    const text = h('textarea', { class: 'textarea', rows: 3, placeholder: 'Tell the AI what to change here…', 'aria-label': 'Note' });
    const scope = h('input', { type: 'checkbox' });
    const save = () => {
      const value = text.value.trim();
      if (value) {
        ctx.notes.push({
          id: 'n' + Date.now(), aiId: target.aiId, targetTag: target.tag, targetText: target.text,
          scope: scope.checked ? 'global' : 'element', text: value,
          docX: target.docX, docY: target.docY, slide: target.slide,
        });
        render();
        persist();
        ctx.commit();
      }
      pop.close();
    };
    submitOnModEnter(text, save);

    const fr = frameEl().getBoundingClientRect();
    const pop = openPopover({
      x: fr.left + e.clientX,
      y: fr.top + e.clientY,
      label: 'Add a note',
      className: 'note-pop',
      outsideDocs: [doc()],
      canDismiss: () => text.value.trim() === '',
      onClose: () => { if (notePop === pop) notePop = null; },
      content: h('div', { class: 'note-pop-body' },
        targetLabel(target),
        text,
        h('label', { class: 'check' }, scope, 'Apply to all similar elements'),
        h('div', { class: 'row gap-2 end' },
          h('span', { class: 'grow t-meta' }, h('span', { class: 'kbd' }, `${MOD} Enter`)),
          h('button', { type: 'button', class: 'btn btn-ghost btn-sm', onclick: () => pop.close() }, 'Cancel'),
          h('button', { type: 'button', class: 'btn btn-secondary btn-sm', onclick: save }, 'Add note'),
        ),
      ),
    });
    notePop = pop;
    text.focus();
  }

  function openPinPop(n, pinEl) {
    if (pinPop) pinPop.close();
    const text = h('textarea', { class: 'textarea', rows: 3, 'aria-label': 'Note' });
    text.value = n.text;
    const save = () => { n.text = text.value.trim(); render(); persist(); pop.close(); };
    submitOnModEnter(text, save);
    const pop = openPopover({
      anchor: pinEl,
      label: 'Edit note',
      className: 'note-pop',
      outsideDocs: [doc()],
      onClose: () => { if (pinPop === pop) pinPop = null; },
      content: h('div', { class: 'note-pop-body' },
        h('div', { class: 't-meta' }, noteMeta(n)),
        text,
        h('div', { class: 'row gap-2 end' },
          h('button', { type: 'button', class: 'btn btn-danger btn-sm', onclick: () => { remove(n); pop.close(); } }, 'Delete'),
          h('span', { class: 'grow' }),
          h('button', { type: 'button', class: 'btn btn-secondary btn-sm', onclick: save }, 'Save'),
        ),
      ),
    });
    pinPop = pop;
    text.focus();
  }

  function remove(n) {
    ctx.notes = ctx.notes.filter((x) => x !== n);
    render();
    persist();
  }

  function noteActions(n) {
    const st = ctx.runs && ctx.runs.stateOf(n.id);
    if (st === 'running') return h('span', { class: 'n-run t-meta text-accent' }, h('span', { class: 'spin' }), 'Running…');
    if (st === 'queued') return h('span', { class: 'n-run t-meta' }, 'Queued');
    return [
      h('div', { class: 'btn-group' },
        h('button', { type: 'button', class: 'btn btn-sm btn-secondary', onclick: () => ctx.runs.runNote(n) }, icon('play', { size: 14 }), 'Run'),
        h('button', {
          type: 'button',
          class: 'btn btn-sm btn-secondary',
          onclick: () => {
            const v = prompt('Edit note', n.text);
            if (v != null) { n.text = v.trim(); render(); persist(); }
          },
        }, icon('pencil', { size: 14 }), 'Edit'),
      ),
      h('button', { type: 'button', class: 'btn btn-sm btn-ghost', onclick: () => remove(n) }, 'Delete'),
    ];
  }

  function render() {
    count.textContent = ctx.notes.length;
    list.replaceChildren(...ctx.notes.map((n, i) => h('div', { class: 'note-item', id: 'note-' + n.id },
      h('div', { class: 'n-top' },
        h('span', { class: 'badge' }, String(i + 1)),
        h('span', { class: 't-meta' }, noteMeta(n)),
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

  return { load, render, persist, computeTweaks, openFromContextMenu, openPinPop };
}
