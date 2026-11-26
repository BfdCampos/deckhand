import { h } from '../dom.js';
import { api } from '../api.js';
import { icon } from '../ui/icons.js';
import { openBrowse } from './browse-modal.js';
import { homeOf, middleTruncate, openErrorText, relativeTime, tildify } from './paths.js';

const SHOWN = 8;

export function createOpenCard({ openDeck, getInfo }) {
  const list = h('ul', { class: 'recents', 'aria-label': 'Recent decks' });
  const pathInput = h('input', {
    type: 'text',
    class: 'input mono open-path',
    placeholder: 'Or paste the full path to a .html file',
    'aria-label': 'Deck path',
    autocomplete: 'off',
    spellcheck: 'false',
  });
  const openBtn = h('button', { type: 'button', class: 'btn btn-secondary' }, 'Open');
  const errorText = h('span', null);
  const error = h('p', { class: 'field-error open-error', role: 'alert', hidden: true }, icon('alert-circle', { size: 14 }), errorText);
  const browseBtn = h('button', { type: 'button', class: 'btn btn-ghost open-browse' }, icon('folder-open'), 'Browse…');
  const busyNote = h('p', { class: 'open-busy t-small', role: 'status', hidden: true });
  const sampleBtn = h('button', { type: 'button', class: 'link recents-sample', hidden: true, onclick: () => open(getInfo()?.sampleDeck) }, icon('play', { size: 12 }), 'Try the sample deck');

  const el = h('section', { class: 'card-lg home-card home-open', 'aria-labelledby': 'open-title' },
    h('header', { class: 'home-card-head' },
      h('span', { class: 'home-card-icon' }, icon('folder')),
      h('h2', { class: 't-card-title', id: 'open-title' }, 'Open a deck')),
    h('div', { class: 'open-recents' },
      h('span', { class: 't-label' }, 'Recent'),
      list),
    h('div', { class: 'open-actions' },
      busyNote,
      h('div', { class: 'input-group' }, pathInput, openBtn),
      error,
      h('div', { class: 'open-foot' }, browseBtn, sampleBtn)));

  let busy = false;
  let blocked = null;

  function setBusy(text) {
    blocked = text || null;
    busyNote.textContent = blocked || '';
    busyNote.hidden = !blocked;
    pathInput.disabled = !!blocked;
    openBtn.disabled = !!blocked;
    browseBtn.disabled = !!blocked;
    sampleBtn.disabled = !!blocked;
    el.classList.toggle('is-busy', !!blocked);
    for (const b of list.querySelectorAll('.recent-open')) b.disabled = !!blocked;
  }

  function showError(err) {
    const text = !err ? '' : typeof err === 'string' ? err : openErrorText(err);
    errorText.textContent = text;
    error.hidden = !text;
    if (text) pathInput.setAttribute('aria-invalid', 'true');
    else pathInput.removeAttribute('aria-invalid');
  }

  async function open(p) {
    const target = (p || '').trim();
    if (blocked) return;
    if (!target || busy) { if (!target) showError({ code: 'not_found' }); return; }
    busy = true;
    showError('');
    try {
      await openDeck(target);
    } catch (err) {
      showError(err);
    } finally {
      busy = false;
    }
  }

  pathInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); open(pathInput.value); } });
  pathInput.addEventListener('input', () => showError(''));
  openBtn.addEventListener('click', () => open(pathInput.value));
  browseBtn.addEventListener('click', () => openBrowse({ openDeck, home: homeOf(getInfo()) }));

  async function remove(item) {
    try {
      const res = await api.post('/api/recents/remove', { path: item.path });
      render(res.items || []);
    } catch (err) {
      showError(err.message);
    }
  }

  function row(item) {
    const home = homeOf(getInfo());
    const dir = tildify(item.dir, home);
    const openButton = h('button', {
      type: 'button',
      class: 'recent-open',
      title: item.missing ? `${item.path} is missing` : item.path,
      'aria-disabled': item.missing ? 'true' : undefined,
      onclick: () => { if (!item.missing) open(item.path); },
    },
    icon(item.missing ? 'alert' : 'deck', { className: 'recent-icon' }),
    h('span', { class: 'recent-text' },
      h('span', { class: 'recent-name' }, item.name),
      h('span', { class: 'recent-dir mono' }, middleTruncate(dir, 44))),
    item.missing
      ? h('span', { class: 'tag recent-missing' }, 'Missing')
      : h('span', { class: 'recent-time tnum' }, relativeTime(item.openedAt)));
    const removeButton = h('button', {
      type: 'button',
      class: 'btn btn-ghost btn-icon btn-sm recent-remove',
      'aria-label': 'Remove from recents',
      title: 'Remove from recents',
      onclick: () => remove(item),
    }, icon('x', { size: 14 }));
    return h('li', { class: ['recent-row', item.missing && 'is-missing'] }, openButton, removeButton);
  }

  function render(items) {
    sampleBtn.hidden = !getInfo()?.sampleDeck;
    const shown = items.slice(0, SHOWN);
    if (shown.length) {
      list.replaceChildren(...shown.map(row));
      setBusy(blocked);
      return;
    }
    list.replaceChildren(h('li', { class: 'recents-empty' },
      h('p', null, 'Decks you open or create will show up here.')));
  }

  async function load() {
    try {
      const res = await api.get('/api/recents');
      render(res.items || []);
    } catch {
      render([]);
    }
  }

  return { el, load, showError, setBusy, focusPath: () => pathInput.focus() };
}
