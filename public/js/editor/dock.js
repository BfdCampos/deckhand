import { h } from '../dom.js';
import { doc, SLIDE_SEL } from './frame.js';

function deckHeadHTML() {
  let out = '';
  doc().querySelectorAll('head style, head link[rel="stylesheet"]').forEach((n) => (out += n.outerHTML));
  return out;
}

export function buildDock(ctx) {
  const dock = ctx.dockEl;
  dock.replaceChildren();
  const slides = [...doc().querySelectorAll(SLIDE_SEL)];
  if (slides.length < 2) { dock.hidden = true; return; }
  const baseHref = location.origin + ctx.deck.url.replace(/[^/]*$/, '');
  const head = deckHeadHTML();
  slides.forEach((slide, i) => {
    const frame = h('iframe', { class: 'dock-thumb', sandbox: 'allow-same-origin', scrolling: 'no', tabindex: '-1', 'aria-hidden': 'true' });
    frame.srcdoc = `<!DOCTYPE html><html><head><base href="${baseHref}">${head}<style>html,body{overflow:hidden!important;margin:0;scroll-snap-type:none}</style></head><body>${slide.outerHTML}</body></html>`;
    const tile = h('div', {
      class: 'dock-tile',
      title: `Slide ${i + 1}`,
      onclick: () => slide.scrollIntoView({ behavior: 'smooth', block: 'start' }),
    }, frame, h('div', { class: 'tnum' }, String(i + 1)));
    dock.appendChild(tile);
  });
  dock.hidden = false;
}
