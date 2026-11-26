import { el, afterMotion, enter, motionMs } from './util.js';
import { icon } from './icons.js';
import { pushEscape } from './escape.js';

const MARGIN = 8;
const GAP = 6;

export function openPopover({
  x = 0,
  y = 0,
  anchor,
  align = 'start',
  content,
  canDismiss = () => true,
  onClose,
  className,
  role,
  label,
  outsideDocs = [],
} = {}) {
  let closed = false;
  const node = el('div', {
    class: className ? `popover ${className}` : 'popover',
    role: role || 'dialog',
    'aria-label': label,
  }, content || null);
  document.body.append(node);

  function place(px, py) {
    const w = node.offsetWidth;
    const h = node.offsetHeight;
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;
    let left;
    let top;
    if (anchor) {
      const r = anchor.getBoundingClientRect();
      left = align === 'end' ? r.right - w : r.left;
      top = r.bottom + GAP;
      if (top + h > vh - MARGIN && r.top - GAP - h >= MARGIN) top = r.top - GAP - h;
    } else {
      left = px;
      top = py;
      if (left + w > vw - MARGIN) left = px - w;
      if (top + h > vh - MARGIN) top = py - h;
    }
    left = Math.min(Math.max(MARGIN, left), Math.max(MARGIN, vw - MARGIN - w));
    top = Math.min(Math.max(MARGIN, top), Math.max(MARGIN, vh - MARGIN - h));
    node.style.left = `${Math.round(left)}px`;
    node.style.top = `${Math.round(top)}px`;
  }
  place(x, y);
  enter(node);

  let nudgeTimer = null;
  function nudge() {
    node.classList.remove('is-nudged');
    void node.offsetWidth;
    node.classList.add('is-nudged');
    clearTimeout(nudgeTimer);
    nudgeTimer = setTimeout(() => node.classList.remove('is-nudged'), Math.max(600, motionMs('--dur-screen')));
    const field = node.querySelector('textarea, input');
    field?.focus();
  }

  function onPointerDown(e) {
    if (node.contains(e.target)) return;
    if (anchor && anchor.contains(e.target)) return;
    if (canDismiss()) close();
    else nudge();
  }
  const docs = [document, ...outsideDocs.filter(Boolean)];
  const listenTimer = setTimeout(() => {
    if (closed) return;
    for (const d of docs) d.addEventListener('pointerdown', onPointerDown, true);
  }, 0);

  const popEscape = pushEscape(() => { close(); return true; });

  function close() {
    if (closed) return;
    closed = true;
    clearTimeout(listenTimer);
    clearTimeout(nudgeTimer);
    for (const d of docs) d.removeEventListener('pointerdown', onPointerDown, true);
    popEscape();
    node.classList.remove('is-in');
    node.classList.add('is-out');
    afterMotion(node, '--dur-pop', () => node.remove());
    onClose?.();
  }

  return { close, el: node, reposition: place };
}

export function openMenu({ items, anchor, x, y, align = 'start', label, onClose } = {}) {
  let popover = null;
  const list = el('div', { class: 'menu-list', role: 'menu', 'aria-label': label });

  const buttons = [];
  for (const item of items) {
    if (item.separator) { list.append(el('div', { class: 'menu-sep', role: 'separator' })); continue; }
    if (item.heading) { list.append(el('div', { class: 'menu-label t-label', text: item.heading })); continue; }
    const checkable = item.checked !== undefined;
    const button = el('button', {
      type: 'button',
      class: item.danger ? 'menu-item is-danger' : 'menu-item',
      role: checkable ? 'menuitemradio' : 'menuitem',
      'aria-checked': checkable ? String(Boolean(item.checked)) : undefined,
      disabled: item.disabled,
      tabindex: '-1',
      onclick: () => {
        popover.close();
        item.onSelect?.();
      },
    },
    item.icon ? icon(item.icon) : null,
    el('span', { class: 'menu-item-label', text: item.label }),
    checkable ? icon('check', { className: 'menu-item-check' }) : null);
    buttons.push(button);
    list.append(button);
  }

  const enabled = () => buttons.filter((b) => !b.disabled);
  list.addEventListener('keydown', (e) => {
    const items = enabled();
    if (!items.length) return;
    const i = items.indexOf(document.activeElement);
    let next = null;
    if (e.key === 'ArrowDown') next = items[(i + 1) % items.length];
    else if (e.key === 'ArrowUp') next = items[(i - 1 + items.length) % items.length];
    else if (e.key === 'Home') next = items[0];
    else if (e.key === 'End') next = items[items.length - 1];
    else if (e.key === 'Tab') { e.preventDefault(); popover.close(); return; }
    if (next) { e.preventDefault(); next.focus(); }
  });

  const previous = document.activeElement;
  popover = openPopover({
    anchor,
    x,
    y,
    align,
    content: list,
    className: 'popover-tight',
    role: 'presentation',
    onClose: () => {
      anchor?.setAttribute('aria-expanded', 'false');
      if (previous && previous.isConnected && list.contains(document.activeElement)) previous.focus();
      onClose?.();
    },
  });
  anchor?.setAttribute('aria-expanded', 'true');

  const start = enabled().find((b) => b.getAttribute('aria-checked') === 'true') || enabled()[0];
  start?.focus();
  return popover;
}
