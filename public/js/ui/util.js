export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
    else if (key in node && typeof value !== 'string') node[key] = value;
    else node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export function motionMs(token) {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(token).trim();
  const n = parseFloat(raw);
  if (!Number.isFinite(n)) return 0;
  return raw.endsWith('ms') ? n : n * 1000;
}

export function afterMotion(node, token, done) {
  const ms = motionMs(token);
  if (ms <= 0) { done(); return; }
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    node.removeEventListener('transitionend', onEnd);
    done();
  };
  const onEnd = (e) => { if (e.target === node) finish(); };
  node.addEventListener('transitionend', onEnd);
  setTimeout(finish, ms + 50);
}

export function enter(node) {
  void node.offsetWidth;
  node.classList.add('is-in');
}

const FOCUSABLE = [
  'a[href]', 'button:not([disabled])', 'input:not([disabled]):not([type="hidden"])',
  'textarea:not([disabled])', 'select:not([disabled])', '[tabindex]:not([tabindex="-1"])', '[contenteditable="true"]',
].join(',');

export function focusables(root) {
  return [...root.querySelectorAll(FOCUSABLE)].filter((n) => n.getClientRects().length > 0);
}

export function ensureStylesheet(href) {
  if (document.querySelector(`link[rel="stylesheet"][href="${href}"]`)) return;
  document.head.append(el('link', { rel: 'stylesheet', href }));
}

export function formatElapsed(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}
