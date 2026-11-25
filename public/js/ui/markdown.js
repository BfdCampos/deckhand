import { h } from '../dom.js';

const INLINE = /(`+)([^`]+?)\1|\*\*(?=\S)([^*]+?)\*\*|__(?=\S)([^_]+?)__|\*(?=\S)([^*\n]+?)\*|(?<![\w])_(?=\S)([^_\n]+?)_(?![\w])/g;

function inline(text) {
  const out = [];
  let last = 0;
  for (const m of text.matchAll(INLINE)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[2] !== undefined) out.push(h('code', null, m[2]));
    else if (m[3] !== undefined || m[4] !== undefined) out.push(h('strong', null, inline(m[3] ?? m[4])));
    else out.push(h('em', null, inline(m[5] ?? m[6])));
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

const BULLET = /^\s*[-*•]\s+(.*)$/;
const NUMBER = /^\s*\d+[.)]\s+(.*)$/;

export function renderMarkdown(text) {
  const blocks = [];
  let para = [];
  let list = null;

  const flushPara = () => {
    if (!para.length) return;
    const children = [];
    para.forEach((line, i) => { if (i) children.push(h('br')); children.push(...inline(line)); });
    blocks.push(h('p', null, children));
    para = [];
  };
  const flushList = () => {
    if (!list) return;
    blocks.push(h(list.tag, null, list.items.map((item) => h('li', null, inline(item)))));
    list = null;
  };

  for (const raw of String(text || '').replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.replace(/^#{1,6}\s+/, '');
    const bullet = BULLET.exec(line);
    const number = bullet ? null : NUMBER.exec(line);
    if (bullet || number) {
      flushPara();
      const tag = bullet ? 'ul' : 'ol';
      if (list && list.tag !== tag) flushList();
      if (!list) list = { tag, items: [] };
      list.items.push((bullet || number)[1]);
    } else if (!line.trim()) {
      flushPara();
      flushList();
    } else {
      flushList();
      para.push(line.trim());
    }
  }
  flushPara();
  flushList();
  return blocks;
}
