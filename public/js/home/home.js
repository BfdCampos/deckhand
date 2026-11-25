import { h } from '../dom.js';
import { api } from '../api.js';
import { icon } from '../ui/icons.js';

export function createHome({ openDeck }) {
  const pathLabel = h('div', { class: 'picker-path' });
  const list = h('div', { class: 'picker-list' });
  const errorText = h('span', null);
  const error = h('div', { class: 'field-error home-error', role: 'alert', hidden: true }, icon('alert-circle', { size: 14 }), errorText);
  const manual = h('input', { type: 'text', class: 'input mono', placeholder: '…or paste an absolute path to a .html file', 'aria-label': 'Path to a deck' });

  const offerText = h('span', null);
  const offer = h('div', { class: 'field-hint home-offer', hidden: true }, icon('info', { size: 14 }), offerText);

  const open = async (p) => {
    showError('');
    offer.hidden = true;
    try { await openDeck(p); } catch (err) { showError(err.message); }
  };

  manual.addEventListener('keydown', (e) => { if (e.key === 'Enter') open(manual.value.trim()); });

  const el = h('div', { class: 'landing', hidden: true },
    h('div', { class: 'landing-card' },
      h('div', { class: 'brand-lockup brand' }, h('span', { class: 'brand-mark' }, icon('anchor')), 'Deckhand'),
      h('p', { class: 'tagline t-card-title' }, 'An HTML presentation editor, built for your AI.'),
      h('p', { class: 'hint t-small text-muted' },
        'Pick the ', h('code', null, '.html'), ' deck you want to edit. Your AI keeps writing to the same file, and your hand edits and notes ride along.',
      ),
      h('div', { class: 'picker' }, pathLabel, list),
      h('div', { class: 'input-group picker-manual' },
        manual,
        h('button', { type: 'button', class: 'btn btn-secondary', onclick: () => open(manual.value.trim()) }, 'Open'),
      ),
      offer,
      error,
    ),
  );

  function row(name, iconName, onClick, cls) {
    return h('button', { type: 'button', class: ['list-row picker-row', cls], onclick: onClick },
      icon(iconName),
      h('span', { class: 'name' }, name),
    );
  }

  async function loadDir(dir) {
    let d;
    try {
      d = await api.get('/api/fs?dir=' + encodeURIComponent(dir || ''));
    } catch (err) {
      showError(err.message);
      return;
    }
    pathLabel.textContent = d.path;
    const rows = [];
    if (d.parent && d.parent !== d.path) rows.push(row('..', 'folder-open', () => loadDir(d.parent), 'up'));
    for (const e of d.entries) {
      const full = d.path + '/' + e.name;
      if (e.isDir) rows.push(row(e.name, 'folder', () => loadDir(full)));
      else rows.push(row(e.name, 'deck', () => open(full), 'html'));
    }
    list.replaceChildren(...rows);
  }

  function showError(msg) {
    const text = msg && typeof msg === 'object' ? msg.message : msg;
    errorText.textContent = text || '';
    error.hidden = !text;
  }

  return {
    el,
    show(dir) {
      showError('');
      offer.hidden = true;
      el.hidden = false;
      loadDir(dir);
    },
    hide() { el.hidden = true; },
    showError,
    offerPath(path) {
      manual.value = path;
      offerText.textContent = 'A link asked Deckhand to open this deck. Press Open if you want to edit it.';
      offer.hidden = false;
      manual.focus();
    },
  };
}
