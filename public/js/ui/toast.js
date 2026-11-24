import { el, afterMotion, enter } from './util.js';
import { icon } from './icons.js';

const DURATION = 3000;
const ACTION_EXTRA = 2000;
const TONE_ICON = { info: 'info', success: 'check-circle', error: 'alert-circle' };

let region = null;
let host = null;
const queue = [];
let current = null;

function getRegion() {
  const parent = host || document.body;
  if (!region || region.parentNode !== parent) {
    region?.remove();
    region = el('div', { class: host ? 'toast-region is-hosted' : 'toast-region', role: 'status', 'aria-live': 'polite' });
    parent.append(region);
  }
  return region;
}

export function setToastHost(node) {
  host = node || null;
  if (region) {
    region.remove();
    region = null;
  }
  if (current) getRegion().append(current.node);
}

function sameAs(a, text, tone) {
  return a && a.text === text && a.tone === tone && !a.action;
}

export function toast(text, { action, tone = 'info' } = {}) {
  const last = queue.length ? queue[queue.length - 1] : current;
  if (!action && sameAs(last, text, tone)) return last.handle;

  const item = { text, tone, action, node: null, timer: null, done: false };
  item.handle = { dismiss: () => dismiss(item) };
  queue.push(item);
  if (!current) showNext();
  return item.handle;
}

function startTimer(item) {
  clearTimeout(item.timer);
  item.timer = setTimeout(() => dismiss(item), DURATION + (item.action ? ACTION_EXTRA : 0));
}

function showNext() {
  const item = queue.shift();
  if (!item) { current = null; return; }
  current = item;

  const children = [icon(TONE_ICON[item.tone] || 'info'), el('span', { class: 'toast-text', text: item.text })];
  if (item.action) {
    children.push(el('button', {
      type: 'button',
      class: 'btn btn-sm btn-secondary toast-action',
      text: item.action.label,
      onclick: () => {
        dismiss(item);
        item.action.onClick?.();
      },
    }));
  }
  children.push(el('button', {
    type: 'button',
    class: 'btn btn-sm btn-ghost btn-icon toast-close',
    'aria-label': 'Dismiss',
    onclick: () => dismiss(item),
  }, icon('x', { size: 14 })));

  item.node = el('div', { class: `toast toast-${item.tone}` }, children);
  item.node.addEventListener('mouseenter', () => clearTimeout(item.timer));
  item.node.addEventListener('mouseleave', () => { if (!item.done) startTimer(item); });
  item.node.addEventListener('focusin', () => clearTimeout(item.timer));

  getRegion().append(item.node);
  enter(item.node);
  startTimer(item);
}

function dismiss(item) {
  if (item.done) return;
  item.done = true;
  clearTimeout(item.timer);
  if (item !== current) {
    const i = queue.indexOf(item);
    if (i !== -1) queue.splice(i, 1);
    return;
  }
  const node = item.node;
  node.classList.remove('is-in');
  node.classList.add('is-out');
  afterMotion(node, '--dur-pop', () => {
    node.remove();
    if (current === item) showNext();
  });
}
