import { parse, parseFragment, serialize, defaultTreeAdapter } from 'parse5';
import { HttpError } from './security.js';

const HTML_NS = 'http://www.w3.org/1999/xhtml';
const ANCHOR_TAGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'li', 'blockquote', 'figcaption', 'img', 'section']);
const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const FORBIDDEN_TAGS = new Set(['script', 'iframe', 'frame', 'frameset', 'object', 'embed', 'base', 'meta', 'link', 'style', 'template']);
const URL_ATTRS = new Set(['href', 'src', 'xlink:href', 'action', 'formaction', 'srcset', 'poster']);
const NUM = '-?\\d+(?:\\.\\d+)?';
const LENGTH = new RegExp(`^(?:${NUM}(?:px|%|em|rem|vw|vh)|0|auto|none)$`);
const TRANSFORM_FN = `(?:translate|translateX|translateY|rotate|scale|scaleX|scaleY|skewX|skewY)\\(\\s*${NUM}(?:px|%|deg|turn|rad)?(?:\\s*,\\s*${NUM}(?:px|%|deg|turn|rad)?)?\\s*\\)`;
const STYLE_RULES = {
  width: LENGTH,
  height: LENGTH,
  'max-width': LENGTH,
  translate: new RegExp(`^${NUM}(?:px|%)(?:\\s+${NUM}(?:px|%))?$`),
  transform: new RegExp(`^(?:none|${TRANSFORM_FN}(?:\\s+${TRANSFORM_FN})*)$`),
};

const missing = (aiId) => new HttpError(409, 'anchor_missing', `There is no element ${aiId} in the deck.`);
const mismatch = () => new HttpError(409, 'anchor_mismatch', 'That element no longer matches the deck.');
const badOp = (message = 'That change could not be applied.') => new HttpError(400, 'bad_op', message);

const attrValue = (node, name) => node.attrs?.find((a) => a.name === name)?.value;

function isAnchorable(node) {
  if (node.namespaceURI !== HTML_NS) return false;
  if (ANCHOR_TAGS.has(node.tagName)) return true;
  if (attrValue(node, 'data-editable') !== undefined || attrValue(node, 'data-slide') !== undefined) return true;
  const cls = attrValue(node, 'class');
  return !!cls && cls.split(/\s+/).includes('slide');
}

function locate(src, node) {
  const loc = node.sourceCodeLocation;
  if (!loc?.startTag) return null;
  const start = loc.startOffset;
  const tagNameEnd = start + 1 + node.tagName.length;
  if (src[start] !== '<' || src.slice(start + 1, tagNameEnd).toLowerCase() !== node.tagName.toLowerCase()) return null;
  if (!/[\s/>]/.test(src[tagNameEnd] || '')) return null;
  const startTagEnd = loc.startTag.endOffset;
  const innerEnd = loc.endTag ? loc.endTag.startOffset : loc.endOffset;
  if (!(start < startTagEnd && startTagEnd <= innerEnd && innerEnd <= loc.endOffset)) return null;
  return { start, end: loc.endOffset, tagNameEnd, startTagEnd, innerStart: startTagEnd, innerEnd, attrs: loc.attrs || {} };
}

function findBody(doc) {
  const html = doc.childNodes.find((n) => n.tagName === 'html');
  return html?.childNodes.find((n) => n.tagName === 'body') || null;
}

export function indexSource(src) {
  const doc = parse(src, { sourceCodeLocationInfo: true });
  const body = findBody(doc);
  const infos = new Map();
  const ids = new Map();
  const duplicates = [];
  const unanchored = [];
  const renames = [];
  let hasSlides = false;

  const walk = (node, parentId, bounds) => {
    let prevEnd = bounds ? bounds.start : -1;
    for (const child of node.childNodes || []) {
      if (!child.tagName) continue;
      const loc = locate(src, child);
      let safe = false;
      if (loc) {
        safe = (!bounds || (loc.start >= bounds.start && loc.end <= bounds.end)) && loc.start >= prevEnd;
        prevEnd = Math.max(prevEnd, loc.end);
      }
      if (child.namespaceURI === HTML_NS) {
        const cls = attrValue(child, 'class');
        if ((cls && cls.split(/\s+/).includes('slide')) || attrValue(child, 'data-slide') !== undefined || child.tagName === 'section') hasSlides = true;
      }
      let id = attrValue(child, 'data-ai-id');
      if (loc && id !== undefined && (id === '' || infos.has(id))) {
        if (id !== '') duplicates.push(id);
        const a = loc.attrs['data-ai-id'];
        if (a) renames.push({ start: a.startOffset, end: a.endOffset });
        id = undefined;
      }
      if (loc && id !== undefined) {
        infos.set(id, { aiId: id, tag: child.tagName, ns: child.namespaceURI, node: child, parentId, safe, ...loc });
        ids.set(id, child.tagName);
      } else if (loc && id === undefined && isAnchorable(child) && attrValue(child, 'data-ai-id') === undefined) {
        unanchored.push(loc.tagNameEnd);
      }
      walk(child, id !== undefined && loc ? id : parentId, loc && safe ? { start: loc.innerStart, end: loc.innerEnd } : null);
    }
  };
  if (body) walk(body, null, null);

  let maxN = 0;
  for (const m of src.matchAll(/data-ai-id\s*=\s*["']?dh(\d+)/gi)) maxN = Math.max(maxN, Number(m[1]));

  return {
    source: src,
    doc,
    body,
    ids,
    duplicates,
    unanchored,
    renames,
    hasSlides,
    maxN,
    get: (aiId) => infos.get(aiId),
  };
}

export function applySplices(src, splices) {
  const sorted = [...splices].sort((a, b) => a.start - b.start || a.end - b.end);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].start < sorted[i - 1].end) throw badOp('Overlapping changes.');
  }
  let out = '';
  let pos = 0;
  const applied = [];
  for (const s of sorted) {
    out += src.slice(pos, s.start) + s.text;
    applied.push({ start: s.start, end: s.end, text: s.text, old: src.slice(s.start, s.end) });
    pos = s.end;
  }
  out += src.slice(pos);
  return { source: out, applied };
}

export function invertSplices(applied) {
  let delta = 0;
  return applied.map((s) => {
    const start = s.start + delta;
    delta += s.text.length - (s.end - s.start);
    return { start, end: start + s.text.length, text: s.old, old: s.text };
  });
}

export function rebaseRanges(ranges, mods) {
  let current = ranges.map((r) => ({ ...r }));
  for (const mod of mods) {
    const next = [];
    for (const r of current) {
      let shift = 0;
      for (const s of mod) {
        if (s.end <= r.start) shift += s.text.length - (s.end - s.start);
        else if (s.start >= r.end) continue;
        else return null;
      }
      next.push({ ...r, start: r.start + shift, end: r.end + shift });
    }
    current = next;
  }
  return current;
}

export function anchorSource(src) {
  const index = indexSource(src);
  let n = index.maxN;
  const edits = [
    ...index.unanchored.map((at) => ({ start: at, end: at, kind: 'add' })),
    ...index.renames.map((r) => ({ ...r, kind: 'rename' })),
  ].sort((a, b) => a.start - b.start);
  const splices = edits.map((e) => {
    const id = `dh${++n}`;
    return { start: e.start, end: e.end, text: e.kind === 'add' ? ` data-ai-id="${id}"` : `data-ai-id="${id}"` };
  });
  const { source } = applySplices(src, splices);
  return { source, added: index.unanchored.length, renamed: index.renames.length };
}

function splitDeclarations(raw) {
  const decls = [];
  let depth = 0;
  let quote = null;
  let start = 0;
  for (let i = 0; i <= raw.length; i++) {
    const c = raw[i];
    if (i === raw.length || (c === ';' && !quote && depth === 0)) {
      const text = raw.slice(start, i);
      const colon = text.indexOf(':');
      decls.push({ start, end: i, text, name: colon === -1 ? null : text.slice(0, colon).trim().toLowerCase(), colon: colon === -1 ? -1 : start + colon });
      start = i + 1;
    } else if (quote) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '(') depth++;
    else if (c === ')') depth = Math.max(0, depth - 1);
  }
  return decls;
}

function normaliseStyle(value) {
  return splitDeclarations(value)
    .filter((d) => d.text.trim())
    .map((d) => (d.colon === -1 ? d.text.trim() : `${d.name}: ${d.text.slice(d.colon - d.start + 1).trim().replace(/\s+/g, ' ')}`))
    .join('; ');
}

function contextElement(tag, ns = HTML_NS) {
  return defaultTreeAdapter.createElement(tag, ns, []);
}

export function canonicalFragment(html, tag, ns = HTML_NS) {
  const frag = parseFragment(contextElement(tag, ns), html);
  const walk = (node) => {
    for (const a of node.attrs || []) if (a.name === 'style') a.value = normaliseStyle(a.value);
    for (const c of node.childNodes || []) walk(c);
    if (node.content) walk(node.content);
  };
  walk(frag);
  return serialize(frag);
}

export function mergeStyle(raw, props) {
  const edits = [];
  const appends = [];
  const decls = splitDeclarations(raw);
  for (const [prop, value] of Object.entries(props)) {
    const matches = decls.filter((d) => d.name === prop);
    if (value === null) {
      for (const d of matches) {
        let end = d.end < raw.length ? d.end + 1 : d.end;
        while (end < raw.length && /\s/.test(raw[end])) end++;
        edits.push({ start: d.start, end, text: '' });
      }
    } else if (matches.length) {
      const d = matches.at(-1);
      edits.push({ start: d.colon + 1, end: d.end, text: ` ${value}` });
    } else {
      appends.push(`${prop}: ${value};`);
    }
  }
  let out = applySplices(raw, edits).source;
  if (appends.length) {
    const trimmed = out.replace(/\s+$/, '');
    const sep = !trimmed ? '' : trimmed.endsWith(';') ? ' ' : '; ';
    out = trimmed + sep + appends.join(' ') + out.slice(trimmed.length);
  }
  return out;
}

function px(value) {
  const m = /^\s*(-?\d+(?:\.\d+)?)px\s*$/.exec(value || '');
  return m ? Math.round(Number(m[1])) : null;
}

function tweakFromProps(tag, props) {
  const next = { tag };
  const fields = [];
  if ('translate' in props) {
    fields.push('move');
    const m = /^(-?\d+(?:\.\d+)?)px(?:\s+(-?\d+(?:\.\d+)?)px)?$/.exec(props.translate || '');
    if (m) { next.dx = Math.round(Number(m[1])); next.dy = Math.round(Number(m[2] || 0)); }
  } else if ('transform' in props) {
    fields.push('move');
    const m = /translate\(\s*(-?\d+(?:\.\d+)?)px\s*(?:,\s*(-?\d+(?:\.\d+)?)px\s*)?\)/.exec(props.transform || '');
    if (m) { next.dx = Math.round(Number(m[1])); next.dy = Math.round(Number(m[2] || 0)); }
  }
  if ('width' in props || 'height' in props) {
    fields.push('resize');
    const w = px(props.width);
    const h = px(props.height);
    if (w !== null) next.w = w;
    if (h !== null) next.h = h;
  }
  return { fields, next: withKind(next) };
}

function withKind(t) {
  const kind = t.w !== undefined || t.h !== undefined ? 'resize' : t.dx !== undefined ? 'move' : null;
  return kind ? { kind, ...t } : null;
}

export function mergeTweak(prev, { fields, next }) {
  const out = { ...(prev || {}) };
  delete out.kind;
  if (next?.tag) out.tag = next.tag;
  if (fields.includes('move')) {
    delete out.dx; delete out.dy;
    if (next?.dx !== undefined) { out.dx = next.dx; out.dy = next.dy; }
  }
  if (fields.includes('resize')) {
    delete out.w; delete out.h;
    if (next?.w !== undefined) out.w = next.w;
    if (next?.h !== undefined) out.h = next.h;
  }
  return withKind(out);
}

function target(index, op) {
  if (typeof op.aiId !== 'string') throw badOp('Missing element id.');
  const info = index.get(op.aiId);
  if (!info) throw missing(op.aiId);
  if (op.tag !== undefined && String(op.tag).toLowerCase() !== info.tag.toLowerCase()) throw mismatch();
  if (!info.safe) throw mismatch();
  return info;
}

function descendants(index, aiId) {
  const out = new Set();
  for (const id of index.ids.keys()) {
    let p = index.get(id).parentId;
    while (p) {
      if (p === aiId) { out.add(id); break; }
      p = index.get(p)?.parentId;
    }
  }
  return out;
}

function verifyStable(oldIdx, newIdx, { scope = null, removed = false, added = null } = {}) {
  if (newIdx.duplicates.length) throw badOp('That change would duplicate an element id.');
  const oldScope = scope ? descendants(oldIdx, scope) : new Set();
  if (removed) oldScope.add(scope);
  const newScope = scope && !removed ? descendants(newIdx, scope) : new Set();
  for (const [id, tag] of oldIdx.ids) {
    if (oldScope.has(id)) continue;
    if (newIdx.ids.get(id) !== tag || newScope.has(id)) throw badOp('That change would break the deck structure.');
    if (newIdx.get(id).parentId !== oldIdx.get(id).parentId) throw badOp('That change would break the deck structure.');
  }
  for (const id of newIdx.ids.keys()) {
    if (!oldIdx.ids.has(id) && !newScope.has(id) && id !== added) throw badOp('That change would break the deck structure.');
  }
}

function checkInsertable(frag) {
  const roots = frag.childNodes.filter((n) => !(n.nodeName === '#text' && !n.value.trim()));
  if (roots.length !== 1 || !roots[0].tagName) throw badOp('Insert exactly one element.');
  const walk = (node, isRoot) => {
    if (FORBIDDEN_TAGS.has(node.tagName)) throw badOp('That element is not allowed.');
    for (const a of node.attrs || []) {
      if (a.name.startsWith('on')) throw badOp('Event handlers are not allowed.');
      if (URL_ATTRS.has(a.name) && /^\s*(javascript|vbscript|data:text\/html)/i.test(a.value)) throw badOp('That link is not allowed.');
      if (a.name === 'data-ai-id' && !isRoot) throw badOp('Nested element ids are not allowed.');
    }
    for (const c of node.childNodes || []) if (c.tagName) walk(c, false);
  };
  walk(roots[0], true);
  return roots[0];
}

const WS_CHARS = new Set([' ', '\t', '\n', '\f', '\r', '\u00A0']);
const RAW_TEXT_TAGS = new Set(['style', 'script', 'xmp', 'iframe', 'noembed', 'noframes', 'plaintext', 'noscript']);
const PRE_TAGS = new Set(['pre', 'textarea', 'listing', 'plaintext']);
const REF_RE = /^&(?:#[0-9]+;?|#[xX][0-9a-fA-F]+;?|[A-Za-z][A-Za-z0-9]*;?)/;
const decoded = new Map();

function decodeRef(ref) {
  if (!decoded.has(ref)) decoded.set(ref, parseFragment(ref).childNodes[0]?.value ?? ref);
  return decoded.get(ref);
}

const escText = (v) => v.replace(/&/g, '&amp;').replace(/\u00A0/g, '&nbsp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escAttr = (v) => v.replace(/&/g, '&amp;').replace(/\u00A0/g, '&nbsp;').replace(/"/g, '&quot;');

function startTagString(node) {
  const attrs = node.attrs.map((a) => {
    const name = a.prefix ? `${a.prefix}:${a.name}` : a.name;
    return ` ${name}="${escAttr(a.name === 'style' ? normaliseStyle(a.value) : a.value)}"`;
  });
  return `<${node.tagName}${attrs.join('')}>`;
}

function textPieces(src, start, end, value, raw) {
  const out = [];
  let i = start;
  let k = 0;
  while (k < value.length) {
    if (i >= end) return null;
    if (src[i] === '&' && !raw) {
      const m = REF_RE.exec(src.slice(i, Math.min(end, i + 40)));
      if (m) {
        const d = decodeRef(m[0]);
        if (d !== m[0] && value.startsWith(d, k)) {
          if (Array.from(d).length !== 1) return null;
          out.push({ v: d, start: i, end: i + m[0].length });
          i += m[0].length;
          k += d.length;
          continue;
        }
      }
    }
    if (src[i] === '\r' && value[k] === '\n') {
      const len = src[i + 1] === '\n' ? 2 : 1;
      out.push({ v: '\n', start: i, end: i + len });
      i += len;
      k += 1;
      continue;
    }
    const cp = String.fromCodePoint(src.codePointAt(i));
    if (!value.startsWith(cp, k)) return null;
    out.push({ v: cp, start: i, end: i + cp.length });
    i += cp.length;
    k += cp.length;
  }
  return i === end ? out : null;
}

function tokenize(html, tag, ns, withLoc) {
  const frag = parseFragment(contextElement(tag, ns), html, { sourceCodeLocationInfo: withLoc });
  const tokens = [];
  const at = (loc, key) => (withLoc && loc ? loc[key] ?? null : null);
  const walk = (parent, strict, raw) => {
    for (const node of parent.childNodes || []) {
      const loc = node.sourceCodeLocation;
      if (node.nodeName === '#text') {
        let pieces = withLoc && loc ? textPieces(html, loc.startOffset, loc.endOffset, node.value, raw) : null;
        if (!pieces) pieces = Array.from(node.value).map((v) => ({ v, start: null, end: null }));
        for (const piece of pieces) {
          const last = tokens.at(-1);
          if (!strict && !raw && WS_CHARS.has(piece.v)) {
            if (last?.k === 'w') { last.v += piece.v; last.end = piece.end; continue; }
            tokens.push({ k: 'w', ...piece });
          } else {
            tokens.push({ k: 't', raw, ...piece });
          }
        }
      } else if (node.nodeName === '#comment') {
        tokens.push({ k: 'c', v: `<!--${node.data}-->`, start: at(loc, 'startOffset'), end: at(loc, 'endOffset') });
      } else if (node.tagName) {
        tokens.push({ k: 's', v: startTagString(node), start: at(loc?.startTag, 'startOffset'), end: at(loc?.startTag, 'endOffset') });
        walk(node.tagName === 'template' ? node.content : node, strict || PRE_TAGS.has(node.tagName), RAW_TEXT_TAGS.has(node.tagName));
        if (!VOID_TAGS.has(node.tagName)) {
          const endAt = withLoc && loc ? (loc.endTag ? loc.endTag.startOffset : loc.endOffset) : null;
          tokens.push({ k: 'e', v: `</${node.tagName}>`, start: endAt, end: withLoc && loc ? (loc.endTag ? loc.endTag.endOffset : loc.endOffset) : null });
        }
      }
    }
  };
  walk(frag, PRE_TAGS.has(tag), RAW_TEXT_TAGS.has(tag));
  return { tokens, frag, length: html.length };
}

const same = (a, b) => a.k === b.k && (a.k === 'w' || a.v === b.v);

function sameIgnoringSpace(a, b) {
  const x = a.filter((t) => t.k !== 'w');
  const y = b.filter((t) => t.k !== 'w');
  return x.length === y.length && x.every((t, i) => t.k === y[i].k && t.v === y[i].v);
}

function emit(t) {
  if (t.k === 't') return t.raw ? t.v : escText(t.v);
  if (t.k === 'w') return t.v === '\u00A0' ? ' ' : escText(t.v);
  return t.v;
}

function minimalSplice(src, dst) {
  const s = src.tokens;
  const a = dst.tokens;
  let p = 0;
  while (p < s.length && p < a.length && same(s[p], a[p])) p++;
  let q = 0;
  while (q < s.length - p && q < a.length - p && same(s[s.length - 1 - q], a[a.length - 1 - q])) q++;
  let sStart = p;
  let sEnd = s.length - q;
  const aStart = p;
  const aEnd = a.length - q;
  if (sEnd > sStart && s[sEnd - 1].k === 'w' && !(aEnd > aStart && a[aEnd - 1].k === 'w')) sEnd--;
  if (sEnd > sStart && s[sStart].k === 'w' && !(aEnd > aStart && a[aStart].k === 'w')) sStart++;
  if (sStart === sEnd && aStart === aEnd) return [];
  const start = sStart < s.length ? s[sStart].start : src.length;
  const end = sEnd > sStart ? s[sEnd - 1].end : start;
  if (start === null || end === null) return null;
  return [{ start, end, text: a.slice(aStart, aEnd).map(emit).join('') }];
}

function riskySignatures(frag) {
  const out = new Map();
  const add = (sig) => out.set(sig, (out.get(sig) || 0) + 1);
  const walk = (node) => {
    for (const c of node.childNodes || []) {
      if (!c.tagName) continue;
      if (FORBIDDEN_TAGS.has(c.tagName)) add(`tag:${c.tagName}`);
      for (const a of c.attrs || []) {
        if (a.name.startsWith('on')) add(`on:${a.name}=${a.value}`);
        if (URL_ATTRS.has(a.name) && /^\s*(javascript|vbscript|data:text\/html)/i.test(a.value)) add(`url:${a.value}`);
      }
      walk(c.tagName === 'template' ? c.content : c);
    }
  };
  walk(frag);
  return out;
}

function planSetInner(index, op) {
  const info = target(index, op);
  if (VOID_TAGS.has(info.tag)) throw badOp('That element has no content to edit.');
  if (typeof op.before !== 'string' || typeof op.after !== 'string') throw badOp('Missing before or after.');
  const sourceInner = index.source.slice(info.innerStart, info.innerEnd);
  const src = tokenize(sourceInner, info.tag, info.ns, true);
  const before = tokenize(op.before, info.tag, info.ns, false);
  if (!sameIgnoringSpace(src.tokens, before.tokens)) {
    throw new HttpError(409, 'script_owned', "This text is set by the deck's own script, so Deckhand can't save it.");
  }
  const after = tokenize(op.after, info.tag, info.ns, false);
  const had = riskySignatures(before.frag);
  for (const [sig, n] of riskySignatures(after.frag)) {
    if (n > (had.get(sig) || 0)) throw badOp('Scripts, styles and event handlers are not allowed in text edits.');
  }
  const local = minimalSplice(src, after) ?? [{ start: 0, end: sourceInner.length, text: after.tokens.map(emit).join('') }];
  return {
    splices: local.map((sp) => ({ start: info.innerStart + sp.start, end: info.innerStart + sp.end, text: sp.text })),
    result: { aiId: info.aiId },
    verify(newIdx) {
      const t = newIdx.get(info.aiId);
      if (!t || t.tag !== info.tag) throw badOp('That change would break the deck structure.');
      const now = tokenize(newIdx.source.slice(t.innerStart, t.innerEnd), t.tag, t.ns, false);
      if (!sameIgnoringSpace(now.tokens, after.tokens)) throw badOp('That change would break the deck structure.');
      verifyStable(index, newIdx, { scope: info.aiId });
    },
  };
}

function planSetStyle(index, op) {
  const info = target(index, op);
  const props = op.props;
  if (!props || typeof props !== 'object' || !Object.keys(props).length) throw badOp('Missing style properties.');
  const clean = {};
  for (const [k, v] of Object.entries(props)) {
    if (!STYLE_RULES[k]) throw badOp(`Deckhand can't set ${k}.`);
    if (v === null || v === '') { clean[k] = null; continue; }
    if (typeof v !== 'string' || v.length > 200 || !STYLE_RULES[k].test(v.trim())) throw badOp('That style value is not allowed.');
    clean[k] = v.trim();
  }
  const src = index.source;
  const loc = info.attrs.style;
  let splice;
  if (loc) {
    const text = src.slice(loc.startOffset, loc.endOffset);
    const m = /^([^\s=]+)(\s*=\s*)?([\s\S]*)$/.exec(text);
    const rawValue = m[3] || '';
    const q = rawValue[0];
    if ((q === '"' || q === "'") && rawValue.endsWith(q) && rawValue.length >= 2) {
      const valueStart = loc.startOffset + m[1].length + (m[2] || '').length + 1;
      const raw = rawValue.slice(1, -1);
      splice = { start: valueStart, end: valueStart + raw.length, text: mergeStyle(raw, clean) };
    } else {
      splice = { start: loc.startOffset, end: loc.endOffset, text: `style="${mergeStyle(rawValue, clean)}"` };
    }
  } else {
    const value = mergeStyle('', clean);
    const at = info.attrs['data-ai-id']?.endOffset ?? info.tagNameEnd;
    splice = value ? { start: at, end: at, text: ` style="${value}"` } : null;
  }
  const result = { aiId: info.aiId, style: attrValue(info.node, 'style') ?? '' };
  return {
    splices: splice && splice.text !== src.slice(splice.start, splice.end) ? [splice] : [],
    result,
    tweak: { aiId: info.aiId, ...tweakFromProps(info.tag, clean) },
    verify(newIdx) {
      if (newIdx.ids.get(info.aiId) !== info.tag) throw badOp('That change would break the deck structure.');
      verifyStable(index, newIdx);
      result.style = attrValue(newIdx.get(info.aiId).node, 'style') ?? '';
    },
  };
}

function planInsert(index, op, nextId) {
  if (typeof op.html !== 'string' || !op.html.trim()) throw badOp('Nothing to insert.');
  let parent = null;
  let at;
  let ctxTag = 'body';
  if (op.parentAiId !== null && op.parentAiId !== undefined) {
    parent = target(index, { aiId: op.parentAiId });
    if (VOID_TAGS.has(parent.tag)) throw badOp("That element can't hold others.");
    at = parent.innerEnd;
    ctxTag = parent.tag;
  } else {
    const bodyLoc = index.body?.sourceCodeLocation;
    const htmlLoc = index.body?.parentNode?.sourceCodeLocation;
    at = bodyLoc?.endTag?.startOffset ?? htmlLoc?.endTag?.startOffset ?? index.source.length;
  }
  const frag = parseFragment(contextElement(ctxTag, parent?.ns), op.html, { sourceCodeLocationInfo: true });
  const root = checkInsertable(frag);
  const rootLoc = root.sourceCodeLocation;
  if (!rootLoc?.startTag) throw badOp('Insert exactly one element.');
  const aiId = nextId();
  const idAttr = rootLoc.attrs?.['data-ai-id'];
  const html = idAttr
    ? op.html.slice(0, idAttr.startOffset) + `data-ai-id="${aiId}"` + op.html.slice(idAttr.endOffset)
    : op.html.slice(0, rootLoc.startOffset + 1 + root.tagName.length) + ` data-ai-id="${aiId}"` + op.html.slice(rootLoc.startOffset + 1 + root.tagName.length);
  return {
    splices: [{ start: at, end: at, text: html }],
    result: { aiId },
    verify(newIdx) {
      const t = newIdx.get(aiId);
      const expectedParent = parent ? newIdx.get(parent.aiId)?.node : newIdx.body;
      if (!t || t.node.parentNode !== expectedParent) throw badOp("That element can't go there.");
      verifyStable(index, newIdx, { added: aiId });
    },
  };
}

function planRemove(index, op) {
  const info = target(index, op);
  return {
    splices: [{ start: info.start, end: info.end, text: '' }],
    result: { aiId: info.aiId },
    verify(newIdx) {
      if (newIdx.ids.has(info.aiId)) throw badOp('That element could not be removed.');
      verifyStable(index, newIdx, { scope: info.aiId, removed: true });
    },
  };
}

export function planOp(index, op, { nextId = () => `dh${index.maxN + 1}` } = {}) {
  if (!op || typeof op !== 'object') throw badOp();
  switch (op.type ?? op.kind) {
    case 'setInner': return planSetInner(index, op);
    case 'setStyle': return planSetStyle(index, op);
    case 'insert': return planInsert(index, op, nextId);
    case 'remove': return planRemove(index, op);
    default: throw badOp('Unknown change type.');
  }
}
