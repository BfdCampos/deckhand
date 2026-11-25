import { h } from '../dom.js';
import { api, onEvent } from '../api.js';
import { icon } from '../ui/icons.js';
import { toast } from '../ui/toast.js';
import { openPopover } from '../ui/popover.js';
import { pushEscape } from '../ui/escape.js';
import { doc, win, frameEl, closestEditable, closestAnchored, aiIdOf, slideIndexOf, IMG_SEL, SLIDE_SEL } from './frame.js';

const MOD = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl';

const LABELS = {
  h1: ['heading', 'headings'], h2: ['heading', 'headings'], h3: ['heading', 'headings'],
  h4: ['heading', 'headings'], h5: ['heading', 'headings'], h6: ['heading', 'headings'],
  p: ['paragraph', 'paragraphs'], li: ['list item', 'list items'], img: ['image', 'images'],
  blockquote: ['quote', 'quotes'], figcaption: ['caption', 'captions'], section: ['slide', 'slides'],
  div: ['box', 'boxes'], span: ['text', 'text'], ul: ['list', 'lists'], ol: ['list', 'lists'],
};

export function targetLabel(tag, plural = false) {
  const l = LABELS[String(tag || '').toLowerCase()];
  if (l) return l[plural ? 1 : 0];
  return plural ? 'elements like this' : 'element';
}

export const isOpen = (n) => (n.status || 'open') !== 'done';

function noteMeta(n) {
  if (n.scope === 'global') return `all similar ${targetLabel(n.targetTag, true)}`;
  return targetLabel(n.targetTag) + (n.slide ? ` · slide ${n.slide}` : '');
}

function snippet(text) {
  return text ? `'${text.slice(0, 60)}${text.length > 60 ? '…' : ''}'` : '';
}

function popTarget(el, target) {
  const isSlide = el.matches(SLIDE_SEL);
  const what = isSlide ? `slide${target.slide ? ` ${target.slide}` : ''}` : el.hasAttribute('data-editable') ? 'text box' : targetLabel(target.tag);
  const text = isSlide ? '' : el.matches(IMG_SEL) ? (el.getAttribute('alt') || '') : target.text;
  const quote = snippet(text);
  return h('div', { class: 'note-pop-target t-meta' }, `On ${what}`, quote ? ': ' : '', quote ? h('span', { class: 'text-ink' }, quote) : null);
}

export function mountNotes(ctx) {
  const count = h('span', { class: 'pill-count' }, '0');
  const list = h('div', { class: 'notes-list' });
  const tweaksLine = h('div', { class: 'notes-tweaks t-meta', hidden: true });
  ctx.slots.notes.append(h('div', { class: 'sb-title' }, h('span', { class: 't-label' }, 'Notes for the AI'), count), list, tweaksLine);

  ctx.notes = [];
  ctx.layoutTweaks = {};
  let rev = -1;
  let notePop = null;
  let pinPop = null;
  let inline = null;

  const canChange = () => ctx.canChangeNotes();

  function adopt(snapshot) {
    if (!ctx.deck || !snapshot || snapshot.deckId !== ctx.deck.deckId) return;
    if (typeof snapshot.rev === 'number' && snapshot.rev < rev) return;
    if (typeof snapshot.rev === 'number') rev = snapshot.rev;
    ctx.notes = snapshot.notes || [];
    if (snapshot.layoutTweaks) ctx.layoutTweaks = snapshot.layoutTweaks;
    render();
  }

  onEvent((m) => { if (m.type === 'notes') adopt(m); });

  async function load() {
    rev = -1;
    ctx.notes = [];
    ctx.layoutTweaks = {};
    render();
    try { adopt(await api.get('/api/notes')); } catch { /* the socket snapshot still arrives */ }
  }

  async function change(body) {
    if (!canChange()) return false;
    try {
      const res = await api.post('/api/notes', { deckId: ctx.deck.deckId, ...body });
      adopt({ deckId: ctx.deck.deckId, notes: res.notes, rev: res.rev });
      return true;
    } catch (err) {
      toast(err.message, { tone: 'error' });
      return false;
    }
  }

  function submitOnModEnter(field, submit) {
    field.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); submit(); }
    });
  }

  function openFromContextMenu(e) {
    e.preventDefault();
    if (!canChange()) return;
    ctx.manual.endEditing();
    const t = closestEditable(e.target) || closestAnchored(e.target) || e.target;
    const w = win();
    const target = {
      aiId: aiIdOf(t),
      tag: t.tagName.toLowerCase(),
      text: t.matches(IMG_SEL) ? (t.getAttribute('alt') || t.getAttribute('src') || '') : (t.innerText || '').trim(),
      docX: e.clientX + w.scrollX,
      docY: e.clientY + w.scrollY,
      slide: slideIndexOf(t),
    };
    notePop?.close();
    pinPop?.close();

    const text = h('textarea', { class: 'textarea', rows: 3, placeholder: 'Tell the AI what to change here…', 'aria-label': 'Note' });
    const scope = h('input', { type: 'checkbox' });
    let saving = false;
    const save = async () => {
      const value = text.value.trim();
      if (!value || saving) { if (!value) pop.close(); return; }
      saving = true;
      const ok = await change({
        op: 'add',
        note: {
          aiId: target.aiId, targetTag: target.tag, targetText: target.text.slice(0, 500), text: value,
          scope: scope.checked ? 'global' : 'element', slide: target.slide, docX: target.docX, docY: target.docY,
        },
      });
      saving = false;
      if (ok) pop.close();
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
        popTarget(t, target),
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
    pinPop?.close();
    const text = h('textarea', { class: 'textarea', rows: 3, 'aria-label': 'Note' });
    text.value = n.text;
    const editable = canChange();
    text.disabled = !editable;
    const save = async () => {
      const value = text.value.trim();
      if (!value) return;
      if (value === n.text || await change({ op: 'edit', id: n.id, text: value })) pop.close();
    };
    submitOnModEnter(text, save);
    const pop = openPopover({
      anchor: pinEl,
      label: 'Edit note',
      className: 'note-pop',
      outsideDocs: [doc()],
      canDismiss: () => text.value.trim() === n.text,
      onClose: () => { if (pinPop === pop) pinPop = null; },
      content: h('div', { class: 'note-pop-body' },
        h('div', { class: 't-meta' }, noteMeta(n)),
        text,
        h('div', { class: 'row gap-2 end' },
          h('button', { type: 'button', class: 'btn btn-danger btn-sm', disabled: !editable, onclick: async () => { if (await remove(n)) pop.close(); } }, 'Delete'),
          h('span', { class: 'grow' }),
          h('button', { type: 'button', class: 'btn btn-ghost btn-sm', onclick: () => pop.close() }, 'Cancel'),
          h('button', { type: 'button', class: 'btn btn-secondary btn-sm', disabled: !editable, onclick: save }, 'Save'),
        ),
      ),
    });
    pinPop = pop;
    if (editable) text.focus();
  }

  function remove(n) {
    if (inline?.id === n.id) stopInlineEdit();
    return change({ op: 'delete', id: n.id });
  }

  function stopInlineEdit() {
    if (!inline) return;
    inline.popEscape();
    inline = null;
    render();
  }

  function startInlineEdit(n) {
    stopInlineEdit();
    const area = h('textarea', { class: 'textarea', rows: 3, 'aria-label': 'Edit note' });
    area.value = n.text;
    const save = async () => {
      const value = area.value.trim();
      if (!value) return;
      if (value === n.text) { stopInlineEdit(); return; }
      if (await change({ op: 'edit', id: n.id, text: value })) stopInlineEdit();
    };
    submitOnModEnter(area, save);
    const el = h('div', { class: 'n-edit' },
      area,
      h('div', { class: 'row gap-2 end' },
        h('span', { class: 'grow t-meta' }, h('span', { class: 'kbd' }, `${MOD} Enter`)),
        h('button', { type: 'button', class: 'btn btn-ghost btn-sm', onclick: stopInlineEdit }, 'Cancel'),
        h('button', { type: 'button', class: 'btn btn-secondary btn-sm', onclick: save }, 'Save'),
      ));
    inline = { id: n.id, el, popEscape: pushEscape(() => { stopInlineEdit(); return true; }) };
    render();
    area.focus();
    area.setSelectionRange(area.value.length, area.value.length);
  }

  function noteActions(n) {
    const st = ctx.runs?.stateOf?.(n.id);
    if (st === 'running') return h('span', { class: 'n-run t-meta text-accent' }, h('span', { class: 'spin' }), 'Running…');
    if (st === 'queued') return h('span', { class: 'n-run t-meta' }, 'Queued');
    const disabled = !canChange();
    return [
      isOpen(n) ? h('div', { class: 'btn-group' },
        h('button', { type: 'button', class: 'btn btn-sm btn-secondary', disabled: disabled || !ctx.runs?.runNote, onclick: () => ctx.runs.runNote(n) }, icon('play', { size: 14 }), 'Run'),
        h('button', { type: 'button', class: 'btn btn-sm btn-secondary', disabled, onclick: () => startInlineEdit(n) }, icon('pencil', { size: 14 }), 'Edit'),
      ) : h('button', { type: 'button', class: 'btn btn-sm btn-secondary', disabled, onclick: () => startInlineEdit(n) }, icon('pencil', { size: 14 }), 'Edit'),
      h('button', { type: 'button', class: 'btn btn-sm btn-ghost', disabled, onclick: () => remove(n) }, 'Delete'),
    ];
  }

  function card(n, i) {
    const tag = ctx.runs?.noteTag?.(n.id);
    const done = !isOpen(n);
    return h('div', { class: ['note-item', done && 'is-done'], id: 'note-' + n.id },
      h('div', { class: 'n-top' },
        h('span', { class: 'badge' }, String(i + 1)),
        h('span', { class: 't-meta grow' }, noteMeta(n)),
        done ? h('span', { class: 'tag tag-success' }, icon('check', { size: 12 }), 'Done') : null,
        tag ? h('span', { class: 'tag tag-warning' }, tag) : null,
      ),
      inline?.id === n.id ? inline.el : h('div', { class: 'n-text' }, n.text),
      inline?.id === n.id ? null : h('div', { class: 'n-actions' }, noteActions(n)),
    );
  }

  function render() {
    if (inline && !ctx.notes.some((n) => n.id === inline.id)) { inline.popEscape(); inline = null; }
    count.textContent = ctx.notes.filter(isOpen).length;
    if (!ctx.notes.length) {
      list.replaceChildren(h('p', { class: 'notes-empty t-meta' }, 'No notes yet. Right-click anything on a slide to tell the AI what to change.'));
    } else {
      list.replaceChildren(...ctx.notes.map(card));
    }
    const tweaks = Object.keys(ctx.layoutTweaks || {}).length;
    tweaksLine.hidden = !tweaks;
    tweaksLine.textContent = tweaks === 1 ? '1 layout tweak will go with the hand-off' : `${tweaks} layout tweaks will go with the hand-off`;
  }

  function closePopovers() {
    notePop?.close();
    pinPop?.close();
    stopInlineEdit();
  }

  return {
    load,
    render,
    openFromContextMenu,
    openPinPop,
    closePopovers,
    rendersRunTags: true,
    persist() {},
    computeTweaks: () => Object.entries(ctx.layoutTweaks || {}).map(([aiId, t]) => ({ aiId, ...t })),
  };
}
