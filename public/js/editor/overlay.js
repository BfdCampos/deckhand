import { h } from '../dom.js';
import { doc, win, frameEl, IMG_SEL, SLIDE_SEL } from './frame.js';
import { isOpen } from './notes.js';

export function mountOverlay(ctx) {
  const ov = ctx.overlayEl;
  const pinEls = new Map();
  let selBox = null;
  let handleEls = [];

  function layer(cls) {
    let l = ov.querySelector('.' + cls);
    if (!l) { l = h('div', { class: cls }); ov.appendChild(l); }
    return l;
  }

  function tick() {
    requestAnimationFrame(tick);
    const deckEl = frameEl();
    if (!deckEl || !ctx.deck || !doc() || !doc().body || ctx.root.hidden) {
      if (ov.children.length) { ov.replaceChildren(); pinEls.clear(); selBox = null; }
      return;
    }
    const fr = deckEl.getBoundingClientRect();
    positionChrome(fr);
    updatePins(fr);
  }

  function ensureChrome() {
    const l = layer('chrome');
    if (selBox && selBox.isConnected) return;
    l.replaceChildren();
    selBox = h('div', { class: 'sel-box' });
    l.appendChild(selBox);
    handleEls = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([cx, cy]) => {
      const handle = h('div', { class: 'handle', dataset: { cx, cy } });
      handle.onmousedown = (e) => ctx.manual.startResize(e, ctx.selected, cx, cy);
      l.appendChild(handle);
      return handle;
    });
  }

  function positionChrome(fr) {
    ensureChrome();
    const sel = ctx.selected;
    const show = sel && sel.isConnected;
    selBox.style.display = show ? 'block' : 'none';
    if (!show) { handleEls.forEach((el) => (el.style.display = 'none')); return; }
    const isImg = sel.matches(IMG_SEL);
    const r = sel.getBoundingClientRect();
    Object.assign(selBox.style, { left: fr.left + r.left + 'px', top: fr.top + r.top + 'px', width: r.width + 'px', height: r.height + 'px' });
    handleEls.forEach((el) => {
      if (!isImg) { el.style.display = 'none'; return; }
      el.style.display = 'block';
      el.style.left = fr.left + r.left + (+el.dataset.cx) * r.width - 6 + 'px';
      el.style.top = fr.top + r.top + (+el.dataset.cy) * r.height - 6 + 'px';
    });
  }

  function updatePins(fr) {
    const l = layer('pinlayer');
    const seen = new Set();
    ctx.notes.forEach((n, i) => {
      let pos = isOpen(n) ? pinPos(n, fr) : null;
      if (pos && (pos.y < fr.top || pos.y > fr.bottom || pos.x < fr.left || pos.x > fr.right + 12)) pos = null;
      let p = pinEls.get(n.id);
      if (!pos) { if (p) { p.remove(); pinEls.delete(n.id); } return; }
      if (!p) {
        p = h('button', { type: 'button', class: 'pin' });
        p.onclick = (e) => {
          e.stopPropagation();
          const cur = ctx.notes.find((x) => x.id === p.dataset.nid);
          if (cur) ctx.notesApi.openPinPop(cur, p);
        };
        l.appendChild(p);
        pinEls.set(n.id, p);
      }
      p.dataset.nid = n.id;
      p.textContent = i + 1;
      p.title = n.text;
      p.setAttribute('aria-label', `Note ${i + 1}: ${n.text}`);
      p.style.left = pos.x + 'px';
      p.style.top = pos.y + 'px';
      seen.add(n.id);
    });
    for (const [id, p] of pinEls) { if (!seen.has(id)) { p.remove(); pinEls.delete(id); } }
  }

  function pinPos(n, fr) {
    const w = win();
    const point = n.docX != null ? { x: fr.left + (n.docX - w.scrollX), y: fr.top + (n.docY - w.scrollY) } : null;
    const node = n.aiId ? doc().querySelector(`[data-ai-id="${CSS.escape(n.aiId)}"]`) : null;
    if (node && node.isConnected) {
      const r = node.getBoundingClientRect();
      const big = node.matches(SLIDE_SEL) || r.width * r.height > 0.4 * fr.width * fr.height;
      if (big && point) return point;
      return { x: fr.left + r.right, y: fr.top + r.top };
    }
    return point;
  }

  requestAnimationFrame(tick);
}
