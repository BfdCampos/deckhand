import { h } from '../dom.js';
import { api } from '../api.js';
import { icon } from '../ui/icons.js';
import { openModal } from '../ui/modal.js';
import { openErrorText } from './paths.js';

function crumbsFor(listing, home) {
  const raw = listing.crumbs || [];
  if (!home) return raw;
  const i = raw.findIndex((c) => c.path === home);
  if (i < 0) return raw;
  return [{ name: 'Home', path: home, home: true }, ...raw.slice(i + 1)];
}

function entriesOf(listing) {
  return (listing.entries || []).filter((e) => e.kind === 'dir' || e.kind === 'deck');
}

export function openBrowse({ openDeck, home }) {
  const crumbs = h('nav', { class: 'browse-crumbs', 'aria-label': 'Folder' });
  const list = h('ul', { class: 'browse-list', 'aria-label': 'Folders and decks', tabindex: '-1' });
  const status = h('p', { class: 'browse-status t-meta', role: 'status', hidden: true });
  const errorText = h('span', null);
  const error = h('p', { class: 'field-error browse-error', role: 'alert', hidden: true }, icon('alert-circle', { size: 14 }), errorText);

  let current = null;
  let seq = 0;

  const modal = openModal({
    title: 'Choose a deck',
    width: 560,
    body: h('div', { class: 'browse' }, crumbs, list, status, error),
    actions: [{ label: 'Cancel' }],
    initialFocus: list,
  });

  function setError(text) {
    errorText.textContent = text || '';
    error.hidden = !text;
  }

  const rows = () => [...list.querySelectorAll('.browse-row')];

  async function load(dir, { focusPath } = {}) {
    const mine = ++seq;
    setError('');
    let listing;
    try {
      listing = await api.get(`/api/fs${dir ? `?${new URLSearchParams({ dir })}` : ''}`);
    } catch (err) {
      if (mine === seq) setError(err.message || "Deckhand can't open that folder.");
      return;
    }
    if (mine !== seq) return;
    current = listing;

    const trail = crumbsFor(listing, home);
    crumbs.replaceChildren(...trail.flatMap((c, i) => {
      const last = i === trail.length - 1;
      const btn = h('button', {
        type: 'button',
        class: ['browse-crumb', last && 'is-current'],
        'aria-current': last ? 'location' : undefined,
        onclick: () => { if (!last) load(c.path); },
      }, c.home ? icon('home', { size: 14 }) : null, c.name);
      return i ? [icon('chevron-right', { size: 12, className: 'browse-sep' }), btn] : [btn];
    }));

    const entries = entriesOf(listing);
    list.replaceChildren(...entries.map((e) => h('li', null, h('button', {
      type: 'button',
      class: ['browse-row', `is-${e.kind}`],
      'data-kind': e.kind,
      'data-path': e.path,
      title: e.path,
      onclick: () => choose(e),
    }, icon(e.kind === 'dir' ? 'folder' : 'deck'), h('span', { class: 'browse-name' }, e.name),
    e.kind === 'dir' ? icon('chevron-right', { size: 14, className: 'browse-go' }) : null))));
    if (!entries.length) list.append(h('li', { class: 'browse-empty t-meta' }, 'No folders or decks here.'));
    status.hidden = true;

    const all = rows();
    const target = (focusPath && all.find((r) => r.dataset.path === focusPath)) || all[0];
    if (target) target.focus();
    else list.focus();
  }

  async function choose(entry) {
    if (entry.kind === 'dir') { load(entry.path); return; }
    try {
      await openDeck(entry.path);
      modal.close();
    } catch (err) {
      setError(openErrorText(err));
    }
  }

  function up() {
    if (!current?.path || current.path === '/') return;
    const parent = current.parent || current.path.replace(/\/[^/]+\/?$/, '') || '/';
    load(parent, { focusPath: current.path });
  }

  modal.el.addEventListener('keydown', (e) => {
    if (e.target.matches('input, textarea')) return;
    const all = rows();
    const i = all.indexOf(document.activeElement);
    let next = null;
    if (e.key === 'ArrowDown') next = all[Math.min(all.length - 1, i + 1)] || all[0];
    else if (e.key === 'ArrowUp') next = all[Math.max(0, i - 1)] || all[0];
    else if (e.key === 'Home') next = all[0];
    else if (e.key === 'End') next = all[all.length - 1];
    else if (e.key === 'Backspace') { e.preventDefault(); up(); return; }
    if (next) { e.preventDefault(); next.focus(); next.scrollIntoView({ block: 'nearest' }); }
  });

  load(null);
  return modal;
}
