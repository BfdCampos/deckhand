import { el, afterMotion, enter, focusables } from './util.js';
import { icon } from './icons.js';
import { pushEscape } from './escape.js';

let seq = 0;

export function openModal({ title, body, actions = [], onClose, width, initialFocus } = {}) {
  const titleId = `dialog-title-${++seq}`;
  const previous = document.activeElement;
  let closed = false;

  const api = { close, el: null };

  const buttons = actions.map((action) => {
    const variant = action.primary ? 'btn-primary' : action.danger ? 'btn-danger' : 'btn-secondary';
    return el('button', {
      type: 'button',
      class: `btn ${variant}`,
      disabled: action.disabled,
      onclick: () => (action.onClick ? action.onClick(api) : close()),
    }, action.icon ? icon(action.icon) : null, action.label);
  });

  const dialog = el('div', {
    class: 'dialog',
    role: 'dialog',
    'aria-modal': 'true',
    'aria-labelledby': titleId,
  },
  el('header', { class: 'dialog-head' },
    el('h2', { class: 'dialog-title', id: titleId, text: title }),
    el('button', {
      type: 'button',
      class: 'btn btn-ghost btn-icon btn-sm dialog-close',
      'aria-label': 'Close',
      onclick: () => close(),
    }, icon('x'))),
  el('div', { class: 'dialog-body' }, body || null),
  buttons.length ? el('footer', { class: 'dialog-foot' }, buttons) : null);
  if (width) dialog.style.setProperty('--modal-w', typeof width === 'number' ? `${width}px` : width);

  const scrim = el('div', { class: 'dialog-scrim' }, dialog);
  api.el = dialog;

  let downOnScrim = false;
  scrim.addEventListener('pointerdown', (e) => { downOnScrim = e.target === scrim; });
  scrim.addEventListener('click', (e) => {
    if (downOnScrim && e.target === scrim) close();
    downOnScrim = false;
  });

  scrim.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab') return;
    const items = focusables(dialog);
    if (!items.length) { e.preventDefault(); return; }
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    if (e.shiftKey && (active === first || !dialog.contains(active))) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && (active === last || !dialog.contains(active))) {
      e.preventDefault();
      first.focus();
    }
  });

  const popEscape = pushEscape(() => { close(); return true; });

  document.body.append(scrim);
  enter(scrim);

  const target = initialFocus
    || focusables(dialog.querySelector('.dialog-body'))[0]
    || dialog.querySelector('.dialog-foot .btn-primary')
    || focusables(dialog)[0];
  target?.focus();

  function close() {
    if (closed) return;
    closed = true;
    popEscape();
    scrim.inert = true;
    scrim.setAttribute('aria-hidden', 'true');
    scrim.classList.remove('is-in');
    scrim.classList.add('is-out');
    afterMotion(scrim, '--dur-pop', () => scrim.remove());
    if (previous && previous.isConnected && typeof previous.focus === 'function') previous.focus();
    onClose?.();
  }

  return api;
}
