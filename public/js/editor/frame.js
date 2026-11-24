export const TEXT_SEL = 'h1,h2,h3,h4,h5,h6,p,li,blockquote,figcaption,[data-editable]';
export const IMG_SEL = 'img';
export const EDIT_SEL = TEXT_SEL + ',' + IMG_SEL;
export const SLIDE_SEL = 'section,.slide,[data-slide],.reveal section';

const AFFORDANCE_STYLE = `
  [data-dh-hover]{outline:2px solid #3b82f688 !important; outline-offset:2px; cursor:default;}
  [contenteditable="true"]{outline:2px solid #3b82f6 !important; cursor:text;}
  * { -webkit-user-drag:none; }
`;

let iframe = null;
let idCounter = 0;

export function bindFrame(el) { iframe = el; }
export function frameEl() { return iframe; }
export function doc() { return iframe && iframe.contentDocument; }
export function win() { return iframe && iframe.contentWindow; }

export function injectAffordanceStyle(d) {
  let st = d.getElementById('dh-style');
  if (!st) {
    st = d.createElement('style');
    st.id = 'dh-style';
    if (d.head) d.head.appendChild(st);
  }
  st.textContent = AFFORDANCE_STYLE;
}

export function closestEditable(node) { return node && node.closest ? node.closest(EDIT_SEL) : null; }

export function slideIndexOf(node) {
  const slide = node.closest && node.closest(SLIDE_SEL);
  if (!slide) return null;
  const i = [...doc().querySelectorAll(SLIDE_SEL)].indexOf(slide);
  return i >= 0 ? i + 1 : null;
}

export function currentSlide() {
  const d = doc();
  const slides = [...d.querySelectorAll(SLIDE_SEL)];
  if (!slides.length) return d.body;
  const w = win();
  const mid = w.scrollY + w.innerHeight / 2;
  return slides.find((s) => {
    const r = s.getBoundingClientRect();
    const top = r.top + w.scrollY;
    return mid >= top && mid <= top + r.height;
  }) || slides[0] || d.body;
}

export function parseTranslate(node) {
  const m = /translate\(\s*(-?[\d.]+)px\s*,\s*(-?[\d.]+)px/.exec(node.style.transform || '');
  return m ? { x: +m[1], y: +m[2] } : { x: 0, y: 0 };
}

export function ensureIds(d) {
  d.querySelectorAll('[data-ai-id]').forEach((e) => {
    const m = /^dh(\d+)$/.exec(e.getAttribute('data-ai-id'));
    if (m) idCounter = Math.max(idCounter, +m[1]);
  });
  d.querySelectorAll(EDIT_SEL).forEach((e) => ensureId(e));
}

export function ensureId(e) {
  if (!e.getAttribute('data-ai-id')) e.setAttribute('data-ai-id', nextId());
  return e.getAttribute('data-ai-id');
}

export function nextId() { return 'dh' + (++idCounter); }

export function cleanClone(el) {
  const clone = el.cloneNode(true);
  const nodes = [clone, ...clone.querySelectorAll('*')];
  for (const n of nodes) {
    if (n.id === 'dh-style') { n.remove(); continue; }
    if (n.hasAttribute('contenteditable')) {
      n.removeAttribute('contenteditable');
      n.removeAttribute('spellcheck');
    }
    for (const a of [...n.attributes]) if (a.name.startsWith('data-dh-')) n.removeAttribute(a.name);
  }
  return clone;
}

export function serializeDeck() {
  const d = doc();
  const dt = d.doctype ? `<!DOCTYPE ${d.doctype.name}>` : '<!DOCTYPE html>';
  return dt + '\n' + cleanClone(d.documentElement).outerHTML;
}
