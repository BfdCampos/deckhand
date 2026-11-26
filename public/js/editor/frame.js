export const TEXT_SEL = 'h1,h2,h3,h4,h5,h6,p,li,blockquote,figcaption,[data-editable]';
export const IMG_SEL = 'img';
export const EDIT_SEL = TEXT_SEL + ',' + IMG_SEL;
export const SLIDE_SEL = 'section,.slide,[data-slide],.reveal section';

const AFFORDANCE_STYLE = `
  [data-dh-hover]{outline:2px solid #3b82f688 !important; outline-offset:2px; cursor:move;}
  [contenteditable="true"]{outline:2px solid #3b82f6 !important; outline-offset:2px; cursor:text;}
  * { -webkit-user-drag:none; }
`;

let iframe = null;

export function bindFrame(el) { iframe = el; }
export function frameEl() { return iframe; }
export function doc() { return iframe && iframe.contentDocument; }
export function win() { return iframe && iframe.contentWindow; }

export function injectAffordanceStyle(d) {
  let st = d.getElementById('dh-style');
  if (!st) {
    st = d.createElement('style');
    st.id = 'dh-style';
    (d.head || d.documentElement).appendChild(st);
  }
  st.textContent = AFFORDANCE_STYLE;
}

export function closestEditable(node) { return node && node.closest ? node.closest(EDIT_SEL) : null; }
export function closestAnchored(node) { return node && node.closest ? node.closest('[data-ai-id]') : null; }
export const aiIdOf = (el) => (el && el.getAttribute('data-ai-id')) || null;

export function slides() {
  const d = doc();
  return d ? [...d.querySelectorAll(SLIDE_SEL)].filter((s) => !s.parentElement.closest(SLIDE_SEL)) : [];
}

export function slideIndexOf(node) {
  const slide = node.closest && node.closest(SLIDE_SEL);
  if (!slide) return null;
  const list = slides();
  const top = list.find((s) => s === slide || s.contains(slide));
  const i = list.indexOf(top);
  return i >= 0 ? i + 1 : null;
}

export function currentSlideIndex() {
  const list = slides();
  if (!list.length) return 0;
  const mid = win().innerHeight / 2;
  const i = list.findIndex((s) => {
    const r = s.getBoundingClientRect();
    return r.top <= mid && r.bottom > mid;
  });
  return i >= 0 ? i + 1 : 1;
}

export function currentSlide() {
  const list = slides();
  if (!list.length) return doc().body;
  return list[currentSlideIndex() - 1] || list[0];
}

function scrollerOf(el) {
  const d = el.ownerDocument;
  for (let n = el.parentElement; n; n = n.parentElement) {
    if (n === d.body || n === d.documentElement) break;
    const oy = getComputedStyle(n).overflowY;
    if ((oy === 'auto' || oy === 'scroll') && n.scrollHeight > n.clientHeight) return n;
  }
  const body = d.body;
  if (body && getComputedStyle(body).overflowY.match(/auto|scroll/) && body.scrollHeight > body.clientHeight) return body;
  return d.scrollingElement || d.documentElement;
}

export function captureScroll() {
  const d = doc();
  if (!d || !d.body) return null;
  const list = slides();
  if (!list.length) {
    const s = d.scrollingElement || d.documentElement;
    return { y: s.scrollTop };
  }
  let index = 0;
  list.forEach((s, i) => { if (s.getBoundingClientRect().top <= 1) index = i; });
  const r = list[index].getBoundingClientRect();
  const frac = r.height > 0 ? Math.min(1, Math.max(0, -r.top / r.height)) : 0;
  return { slide: index + 1, frac };
}

export function restoreScroll(pos) {
  const d = doc();
  if (!pos || !d || !d.body) return;
  if (pos.y !== undefined) {
    (d.scrollingElement || d.documentElement).scrollTop = pos.y;
    return;
  }
  const list = slides();
  const slide = list[Math.min(list.length, Math.max(1, pos.slide)) - 1];
  if (!slide) return;
  slide.scrollIntoView({ block: 'start', behavior: 'instant' });
  if (pos.frac > 0) scrollerOf(slide).scrollTop += pos.frac * slide.getBoundingClientRect().height;
}

export function parseTranslate(node) {
  const parts = (node.style.translate || '').trim().split(/\s+/).filter(Boolean);
  const px = (v) => { const m = /^(-?[\d.]+)px$/.exec(v || '0px'); return m ? +m[1] : 0; };
  return parts.length ? { x: px(parts[0]), y: px(parts[1]) } : { x: 0, y: 0 };
}

function stripAffordances(root) {
  for (const n of [...root.querySelectorAll('*')]) {
    if (n.id === 'dh-style') { n.remove(); continue; }
    for (const a of [...n.attributes]) if (a.name.startsWith('data-dh-')) n.removeAttribute(a.name);
  }
  return root;
}

export function cleanInner(el) {
  return stripAffordances(el.cloneNode(true)).innerHTML;
}

export function cleanClone(el) {
  const clone = stripAffordances(el.cloneNode(true));
  clone.removeAttribute('contenteditable');
  for (const a of [...clone.attributes]) if (a.name.startsWith('data-dh-')) clone.removeAttribute(a.name);
  return clone;
}

export function setInnerHtml(el, html) {
  if (typeof el.setHTMLUnsafe === 'function') { el.setHTMLUnsafe(html); return; }
  const range = el.ownerDocument.createRange();
  range.selectNodeContents(el);
  el.replaceChildren(range.createContextualFragment(html));
}

export function setStyleAttr(el, value) {
  if (value === null || value === undefined || value === '') el.removeAttribute('style');
  else el.setAttribute('style', value);
}
