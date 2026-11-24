import { h } from '../dom.js';
import { api } from '../api.js';
import { icon } from '../ui/icons.js';

export function createHome({ openDeck }) {
  const pathLabel = h('div', { class: 'picker-path' });
  const list = h('div', { class: 'picker-list' });
  const error = h('div', { class: 'error', role: 'alert' });
  const manual = h('input', { type: 'text', placeholder: '…or paste an absolute path to a .html file' });

  const open = async (p) => {
    showError('');
    try { await openDeck(p); } catch (err) { showError(err.message); }
  };

  manual.addEventListener('keydown', (e) => { if (e.key === 'Enter') open(manual.value.trim()); });

  const el = h('div', { class: 'landing', hidden: true },
    h('div', { class: 'landing-card' },
      h('div', { class: 'brand' }, icon('anchor', { size: 24 }), 'Deckhand'),
      h('p', { class: 'tagline' }, 'An HTML presentation editor, built for your AI.'),
      h('p', { class: 'hint' },
        'Pick the ', h('code', null, '.html'), ' deck you want to edit. Your AI keeps writing to the same file, and your hand edits and notes ride along.',
      ),
      h('div', { class: 'picker' }, pathLabel, list),
      h('div', { class: 'picker-manual' },
        manual,
        h('button', { type: 'button', onclick: () => open(manual.value.trim()) }, 'Open'),
      ),
      error,
    ),
  );

  function row(name, iconName, onClick, cls) {
    return h('div', { class: ['picker-row', cls], role: 'button', tabindex: '0', onclick: onClick,
      onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); } } },
      h('span', { class: 'ic' }, icon(iconName)),
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
    if (d.parent && d.parent !== d.path) rows.push(row('..', 'folder', () => loadDir(d.parent), 'up'));
    for (const e of d.entries) {
      const full = d.path + '/' + e.name;
      if (e.isDir) rows.push(row(e.name, 'folder', () => loadDir(full)));
      else rows.push(row(e.name, 'file', () => open(full), 'html'));
    }
    list.replaceChildren(...rows);
  }

  function showError(msg) { error.textContent = msg || ''; }

  return {
    el,
    show(dir) {
      showError('');
      el.hidden = false;
      loadDir(dir);
    },
    hide() { el.hidden = true; },
    showError,
  };
}
