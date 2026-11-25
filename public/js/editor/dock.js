import { h } from '../dom.js';
import { doc, slides, cleanClone } from './frame.js';

function deckHead() {
  let out = '';
  for (const n of doc().querySelectorAll('head style:not(#dh-style), head link[rel="stylesheet"]')) out += n.outerHTML;
  return out;
}

function inertSlide(slide) {
  const clone = cleanClone(slide);
  for (const n of clone.querySelectorAll('script, iframe, object, embed')) n.remove();
  for (const n of [clone, ...clone.querySelectorAll('*')]) {
    for (const a of [...n.attributes]) {
      if (a.name.startsWith('on') || /^\s*javascript:/i.test(a.value)) n.removeAttribute(a.name);
    }
  }
  return clone.outerHTML;
}

export function createDock(ctx) {
  const dock = ctx.dockEl;
  let observer = null;
  let tiles = [];

  function build() {
    observer?.disconnect();
    dock.replaceChildren();
    tiles = [];
    const list = slides();
    if (list.length < 2) { dock.hidden = true; return; }
    const baseHref = new URL(ctx.deck.url.replace(/[^/]*$/, ''), location.origin).href;
    const head = deckHead();
    const docFor = (slide) => `<!DOCTYPE html><html><head><base href="${baseHref}">${head}<style>html,body{overflow:hidden!important;margin:0;scroll-snap-type:none!important}</style></head><body>${inertSlide(slide)}</body></html>`;
    observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting || entry.target.querySelector('iframe')) continue;
        const frame = h('iframe', { class: 'dock-thumb', sandbox: 'allow-scripts', scrolling: 'no', tabindex: '-1', 'aria-hidden': 'true' });
        frame.srcdoc = docFor(list[Number(entry.target.dataset.index)]);
        entry.target.prepend(frame);
      }
    }, { root: dock, rootMargin: '0px 200px' });
    list.forEach((slide, i) => {
      const tile = h('button', {
        type: 'button',
        class: 'dock-tile',
        'aria-label': `Go to slide ${i + 1}`,
        dataset: { index: String(i) },
        onclick: () => slide.scrollIntoView({ behavior: 'smooth', block: 'start' }),
      }, h('span', { class: 'dock-num' }, String(i + 1)));
      tiles.push(tile);
      dock.appendChild(tile);
      observer.observe(tile);
    });
    dock.hidden = false;
  }

  function setActive(index) {
    tiles.forEach((t, i) => {
      const on = i === index - 1;
      t.classList.toggle('active', on);
      if (on) t.setAttribute('aria-current', 'true');
      else t.removeAttribute('aria-current');
    });
  }

  return { build, setActive, clear: () => { observer?.disconnect(); dock.replaceChildren(); dock.hidden = true; } };
}
