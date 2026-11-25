import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parse, serialize } from 'parse5';
import {
  anchorSource, indexSource, planOp, applySplices, invertSplices, canonicalFragment, rebaseRanges,
} from '../../src/server/source-patch.js';

const ANCHOR_RE = /^ data-ai-id="dh\d+"/;

function onlyAnchorsAdded(original, anchored) {
  let i = 0;
  let j = 0;
  while (i < original.length || j < anchored.length) {
    const m = ANCHOR_RE.exec(anchored.slice(j, j + 40));
    if (m && !original.startsWith(m[0], i)) { j += m[0].length; continue; }
    if (original[i] === anchored[j]) { i++; j++; continue; }
    return `differs at original ${i} / anchored ${j}: ${JSON.stringify(anchored.slice(j, j + 40))}`;
  }
  return true;
}

function elementsWithIds(src) {
  const out = [];
  const walk = (n) => {
    if (n.tagName && n.sourceCodeLocation) {
      const id = n.attrs.find((a) => a.name === 'data-ai-id')?.value;
      if (id) out.push({ id, node: n });
    }
    for (const c of n.childNodes || []) walk(c);
  };
  walk(parse(src, { sourceCodeLocationInfo: true }));
  return out;
}

const CORPUS = {
  basic: '<!doctype html><html><head><title>T</title></head><body><section class="slide"><h1>Title</h1><p>Intro text</p></section></body></html>',
  unquoted: '<!DOCTYPE html><body><SECTION CLASS=slide data-x=1><H2 class=big>Shouting</H2><P id=p1 title=a>Para <B>bold</B></P></SECTION></body>',
  comments: '<body><!-- <p>not real</p> --><section class="slide"><!--x--><h1>Real<!-- inline --></h1></section><!-- trailing --></body>',
  rawText: '<head><style>p > h1 { content: "<p>"; }</style><script>if (a < b && c > d) document.write("<p>fake</p>")</script></head><body><section class="slide"><p>After script</p><script>var s = "</p><p>";</script><p>Second</p></section></body>',
  entities: '<body><section class="slide"><h1>Caf&eacute; &amp; cr&#232;me &lt;b&gt; &nbsp;space</h1><p title="&quot;q&quot;">A&nbsp;B</p></section></body>',
  crlf: '<!doctype html>\r\n<html>\r\n<body>\r\n<section class="slide">\r\n  <h1>Line one</h1>\r\n  <p>Line\r\ntwo</p>\r\n</section>\r\n</body>\r\n</html>\r\n',
  bom: '﻿<!doctype html><html><body><section class="slide"><h1>With BOM</h1></section></body></html>',
  unclosed: '<body><section class="slide"><p>One<p>Two<ul><li>a<li>b<li>c</ul><p>Three</section></body>',
  template: '<body><template><section class="slide"><p>Inside template</p></section></template><section class="slide"><p>Outside</p></section></body>',
  foreign: '<body><section class="slide"><svg viewBox="0 0 10 10"><text>svg text</text><foreignObject><p>in fo</p></foreignObject></svg><math><mi>x</mi></math><p>after</p></section></body>',
  nested: '<body><section class="slide"><section data-slide><div data-editable><h3>Deep</h3></div><blockquote>Quote<figcaption>cap</figcaption></blockquote></section></section></body>',
  selfClosing: '<body><section class="slide"><img src="a.png"/><img/src="b.png"><br/><p>x<br>y</p><img src=c.png></section></body>',
  misnested: '<body><section class="slide"><b><p>x</b>y</p><p>clean</p></section></body>',
  existingIds: '<body><section class="slide" data-ai-id="dh4"><h1 data-ai-id="hero">Hero</h1><p>New one</p><p data-ai-id="dh9">Nine</p></section></body>',
  noBody: '<h1>Bare heading</h1><p>Bare para',
  attrsWithGt: '<body><section class="slide"><p title="a > b" data-k=\'<p>\'>Tricky</p><p\nclass="multi"\n>Multiline tag</p></section></body>',
};

describe('anchorSource', () => {
  for (const [name, src] of Object.entries(CORPUS)) {
    test(`only inserts anchors: ${name}`, () => {
      const { source } = anchorSource(src);
      assert.equal(onlyAnchorsAdded(src, source), true);
      assert.equal(anchorSource(source).added, 0, 'anchoring is idempotent');
      assert.deepEqual(indexSource(source).duplicates, []);
    });
  }

  test('anchors the expected elements and nothing else', () => {
    const { source } = anchorSource(CORPUS.template + CORPUS.foreign.replace('<body>', ''));
    const tags = elementsWithIds(source).map((e) => e.node.tagName);
    assert.ok(!source.slice(0, source.indexOf('</template>')).includes('data-ai-id'), 'template content untouched');
    assert.ok(!tags.includes('svg') && !tags.includes('text') && !tags.includes('mi'));
    assert.ok(tags.includes('p') && tags.includes('section'));
  });

  test('anchors uppercase tags, data-editable, data-slide and .slide', () => {
    const { source } = anchorSource(CORPUS.unquoted + CORPUS.nested);
    assert.match(source, /<SECTION data-ai-id="dh\d+" CLASS=slide/);
    assert.match(source, /<H2 data-ai-id="dh\d+" class=big>/);
    assert.match(source, /<div data-ai-id="dh\d+" data-editable>/);
    assert.match(source, /<section data-ai-id="dh\d+" data-slide>/);
  });

  test('continues numbering after the highest dhN and keeps existing ids', () => {
    const { source } = anchorSource(CORPUS.existingIds);
    assert.match(source, /data-ai-id="dh4"/);
    assert.match(source, /data-ai-id="hero"/);
    assert.match(source, /<p data-ai-id="dh10">New one/);
  });

  test('renames duplicate ids after the first and changes nothing else', () => {
    const src = '<body><section class="slide" data-ai-id="dh1"><p data-ai-id="dh2">A</p><p data-ai-id="dh2">B</p><p data-ai-id="">C</p></section></body>';
    const { source, renamed } = anchorSource(src);
    assert.equal(renamed, 2);
    const ids = elementsWithIds(source).map((e) => e.id);
    assert.equal(new Set(ids).size, ids.length);
    assert.match(source, /<p data-ai-id="dh2">A<\/p>/);
    const norm = (s) => s.replace(/data-ai-id="[^"]*"/g, 'data-ai-id="X"');
    assert.equal(norm(source), norm(src));
  });

  test('a misnested element without its own location is not anchored', () => {
    const { source } = anchorSource(CORPUS.misnested);
    assert.equal(onlyAnchorsAdded(CORPUS.misnested, source), true);
  });
});

function domInner(src, aiId) {
  const el = elementsWithIds(src).find((e) => e.id === aiId).node;
  return serialize(el);
}

function opsFor(index, aiId) {
  const info = index.get(aiId);
  return [
    { type: 'setInner', aiId, tag: info.tag, before: domInner(index.source, aiId), after: domInner(index.source, aiId) + ' edited &amp; <em>new</em>' },
    { type: 'setStyle', aiId, tag: info.tag, props: { transform: 'translate(100px, 0px)' } },
    { type: 'remove', aiId, tag: info.tag },
    { type: 'insert', parentAiId: aiId, html: '<p>Inserted</p>' },
  ];
}

const VOID = new Set(['img', 'br', 'hr', 'input']);

describe('ops keep every untouched byte', () => {
  for (const [name, src] of Object.entries(CORPUS)) {
    test(`every op on every anchor: ${name}`, () => {
      const anchored = anchorSource(src).source;
      const index = indexSource(anchored);
      let applied = 0;
      for (const aiId of index.ids.keys()) {
        const info = index.get(aiId);
        for (const op of opsFor(index, aiId)) {
          if (op.type === 'insert' && VOID.has(info.tag)) continue;
          let plan;
          let source;
          let done;
          try {
            plan = planOp(index, op, { nextId: () => 'dh999' });
            ({ source, applied: done } = applySplices(anchored, plan.splices));
            plan.verify(indexSource(source));
          } catch (e) {
            assert.ok([400, 409].includes(e.status), `${name} ${op.type} ${aiId}: ${e.stack}`);
            continue;
          }
          assert.equal(done.length >= 1, true);
          const first = Math.min(...done.map((s) => s.start));
          const last = Math.max(...done.map((s) => s.end));
          const delta = source.length - anchored.length;
          assert.equal(source.slice(0, first), anchored.slice(0, first), `${name} ${op.type} ${aiId} prefix`);
          assert.equal(source.slice(last + delta), anchored.slice(last), `${name} ${op.type} ${aiId} suffix`);
          if (op.type === 'setInner') {
            assert.equal(first, info.innerStart);
            assert.equal(last, info.innerEnd);
          } else if (op.type === 'remove') {
            assert.deepEqual([first, last], [info.start, info.end]);
          } else if (op.type === 'setStyle') {
            assert.ok(first >= info.start && last <= info.startTagEnd, 'style edit stays in the start tag');
          } else if (op.type === 'insert') {
            assert.deepEqual([first, last], [info.innerEnd, info.innerEnd]);
          }
          assert.equal(applySplices(source, invertSplices(done)).source, anchored, `${name} ${op.type} ${aiId} inverse`);
          applied++;
        }
      }
      assert.ok(applied > 0, 'at least one op applied');
    });
  }
});

describe('setInner', () => {
  const src = anchorSource(CORPUS.basic).source;
  const index = indexSource(src);
  const h1 = [...index.ids].find(([, tag]) => tag === 'h1')[0];

  test('splices the new inner HTML in place', () => {
    const plan = planOp(index, { type: 'setInner', aiId: h1, tag: 'h1', before: 'Title', after: 'New title' });
    const out = applySplices(src, plan.splices).source;
    assert.equal(out, src.replace('>Title<', '>New title<'));
  });

  test('refuses when the runtime content differs from the source (script owned)', () => {
    assert.throws(
      () => planOp(index, { type: 'setInner', aiId: h1, tag: 'h1', before: 'Title<span class="added">!</span>', after: 'x' }),
      (e) => e.status === 409 && e.code === 'script_owned',
    );
  });

  test('ignores harmless serialisation differences', () => {
    const s = anchorSource('<body><section class="slide"><p>Caf&eacute; <B CLASS=x>b</B><br/>&nbsp;</p></section></body>').source;
    const idx = indexSource(s);
    const p = [...idx.ids].find(([, t]) => t === 'p')[0];
    const plan = planOp(idx, { type: 'setInner', aiId: p, tag: 'p', before: 'Café <b class="x">b</b><br>&nbsp;', after: 'Done' });
    assert.ok(plan.splices.length);
  });

  test('tag mismatch and missing anchors are refused', () => {
    assert.throws(() => planOp(index, { type: 'setInner', aiId: h1, tag: 'p', before: 'Title', after: 'x' }), (e) => e.code === 'anchor_mismatch');
    assert.throws(() => planOp(index, { type: 'setInner', aiId: 'dh404', tag: 'p', before: '', after: 'x' }), (e) => e.code === 'anchor_missing');
  });

  test('an after that breaks out of the element is refused by verify', () => {
    const plan = planOp(index, { type: 'setInner', aiId: h1, tag: 'h1', before: 'Title', after: 'x</h1></section><section><h1>y' });
    const out = applySplices(src, plan.splices).source;
    assert.throws(() => plan.verify(indexSource(out)), (e) => e.status === 400 && e.code === 'bad_op');
  });

  test('an after that duplicates an existing anchor is refused by verify', () => {
    const p = [...index.ids].find(([, t]) => t === 'p')[0];
    const plan = planOp(index, { type: 'setInner', aiId: h1, tag: 'h1', before: 'Title', after: `<span data-ai-id="${p}">x</span>` });
    assert.throws(() => plan.verify(indexSource(applySplices(src, plan.splices).source)), (e) => e.code === 'bad_op');
  });

  test('a misnested element is refused rather than corrupted', () => {
    const s = anchorSource(CORPUS.misnested).source;
    const idx = indexSource(s);
    for (const [aiId, tag] of idx.ids) {
      try {
        const plan = planOp(idx, { type: 'remove', aiId, tag });
        plan.verify(indexSource(applySplices(s, plan.splices).source));
      } catch (e) {
        assert.ok([400, 409].includes(e.status));
      }
    }
  });
});

describe('setStyle', () => {
  const style = (src, props) => {
    const s = anchorSource(src).source;
    const idx = indexSource(s);
    const [aiId, tag] = [...idx.ids].find(([, t]) => t === 'img' || t === 'h1');
    const plan = planOp(idx, { type: 'setStyle', aiId, tag, props });
    return { before: s, after: applySplices(s, plan.splices).source, plan };
  };

  test('adds a style attribute after the anchor when there is none', () => {
    const { before, after } = style('<body><h1 class="t">Hi</h1></body>', { transform: 'translate(100px, 0px)' });
    assert.equal(after, before.replace(/(<h1 data-ai-id="dh\d+")/, '$1 style="transform: translate(100px, 0px);"'));
  });

  test('merges declarations and keeps the others byte for byte', () => {
    const { before, after } = style('<body><h1 style="color:RED;  font-size : 2em">Hi</h1></body>', { transform: 'translate(5px, 6px)' });
    assert.equal(after, before.replace('font-size : 2em"', 'font-size : 2em; transform: translate(5px, 6px);"'));
  });

  test('replaces an existing declaration in place', () => {
    const { before, after } = style('<body><img style="width: 10px; border: 1px solid; height:20px;" src=a.png></body>', { width: '240px', height: '120px' });
    assert.equal(after, before.replace('width: 10px', 'width: 240px').replace('height:20px', 'height: 120px'));
  });

  test('null removes a declaration', () => {
    const { before, after } = style('<body><h1 style="transform: translate(1px, 2px); color: red">Hi</h1></body>', { transform: null });
    assert.equal(after, before.replace('transform: translate(1px, 2px); ', ''));
  });

  test('unquoted and single-quoted style values', () => {
    const a = style('<body><h1 style=color:red>Hi</h1></body>', { width: '5px' });
    assert.match(a.after, /style="color:red; width: 5px;"/);
    const b = style("<body><h1 style='color: red;'>Hi</h1></body>", { width: '5px' });
    assert.match(b.after, /style='color: red; width: 5px;'/);
  });

  test('rejects unsafe values and unknown properties', () => {
    for (const props of [{ transform: 'x" onclick="evil' }, { width: '1px; background: url(x)' }, { color: 'red' }, { width: '</style>' }]) {
      assert.throws(() => style('<body><h1>Hi</h1></body>', props), (e) => e.status === 400 && e.code === 'bad_op', JSON.stringify(props));
    }
  });

  test('returns the exact new style value so the client can mirror it', () => {
    const { after, plan } = style('<body><h1 style="color:#FFF;margin:0">Hi</h1></body>', { transform: 'translate(1px, 2px)' });
    plan.verify(indexSource(after));
    assert.equal(plan.result.style, 'color:#FFF;margin:0; transform: translate(1px, 2px);');
  });

  test('reports the layout tweak for moves and resizes', () => {
    assert.deepEqual(style('<body><h1>Hi</h1></body>', { transform: 'translate(100px, -20px)' }).plan.tweak.next, { kind: 'move', tag: 'h1', dx: 100, dy: -20 });
    assert.deepEqual(style('<body><img src=a.png></body>', { width: '240px', height: '120px' }).plan.tweak.next, { kind: 'resize', tag: 'img', w: 240, h: 120 });
  });
});

describe('insert and remove', () => {
  const src = anchorSource('<body><section class="slide"><h1>Title</h1></section></body>').source;
  const index = indexSource(src);
  const section = [...index.ids].find(([, t]) => t === 'section')[0];

  test('insert adds a fresh anchor to the root and splices before the parent end tag', () => {
    const plan = planOp(index, { type: 'insert', parentAiId: section, html: '<p class="dh-text">New text</p>' }, { nextId: () => 'dh77' });
    assert.equal(plan.result.aiId, 'dh77');
    const out = applySplices(src, plan.splices).source;
    assert.equal(out, src.replace('</h1></section>', '</h1><p data-ai-id="dh77" class="dh-text">New text</p></section>'));
    plan.verify(indexSource(out));
  });

  test('insert with no parent goes before </body>', () => {
    const plan = planOp(index, { type: 'insert', parentAiId: null, html: '<img src="deckhand-assets/1-a.png">' }, { nextId: () => 'dh78' });
    const out = applySplices(src, plan.splices).source;
    assert.equal(out, src.replace('</body>', '<img data-ai-id="dh78" src="deckhand-assets/1-a.png"></body>'));
  });

  test('insert refuses more than one root, scripts, handlers and nested anchors', () => {
    for (const html of ['<p>a</p><p>b</p>', 'text only', '<script>x()</script>', '<img src=x onerror=alert(1)>', '<a href="javascript:alert(1)">x</a>', '<div><p data-ai-id="dh1">x</p></div>', '<iframe src=x></iframe>']) {
      assert.throws(() => planOp(index, { type: 'insert', parentAiId: section, html }, { nextId: () => 'dh79' }), (e) => e.code === 'bad_op', html);
    }
  });

  test('insert that the parser would move elsewhere is refused by verify', () => {
    const s = anchorSource('<body><section class="slide"><p>Para</p></section></body>').source;
    const idx = indexSource(s);
    const p = [...idx.ids].find(([, t]) => t === 'p')[0];
    const plan = planOp(idx, { type: 'insert', parentAiId: p, html: '<div>block</div>' }, { nextId: () => 'dh80' });
    assert.throws(() => plan.verify(indexSource(applySplices(s, plan.splices).source)), (e) => e.code === 'bad_op');
  });

  test('remove cuts exactly the element', () => {
    const h1 = [...index.ids].find(([, t]) => t === 'h1')[0];
    const plan = planOp(index, { type: 'remove', aiId: h1, tag: 'h1' });
    const out = applySplices(src, plan.splices).source;
    assert.equal(out, src.replace(/<h1[^>]*>Title<\/h1>/, ''));
  });

  test('unknown op types are refused', () => {
    assert.throws(() => planOp(index, { type: 'setOuter', aiId: section }), (e) => e.code === 'bad_op');
  });
});

describe('canonicalFragment', () => {
  test('normalises entities, quotes, case and style whitespace', () => {
    assert.equal(canonicalFragment('Caf&eacute; <B CLASS=x STYLE="color:red;width : 2px">b</B>', 'p'), canonicalFragment('Café <b class="x" style="color: red; width: 2px;">b</b>', 'p'));
  });
  test('sees structural differences', () => {
    assert.notEqual(canonicalFragment('a<span>b</span>', 'p'), canonicalFragment('a<span class="x">b</span>', 'p'));
  });
});

describe('rebaseRanges', () => {
  test('shifts ranges past earlier edits and leaves later ones alone', () => {
    const ranges = [{ start: 10, end: 15 }];
    assert.deepEqual(rebaseRanges(ranges, [[{ start: 0, end: 2, text: 'abcd', old: 'xy' }]]), [{ start: 12, end: 17 }]);
    assert.deepEqual(rebaseRanges(ranges, [[{ start: 20, end: 22, text: '', old: 'xy' }]]), [{ start: 10, end: 15 }]);
    assert.deepEqual(rebaseRanges(ranges, [[{ start: 10, end: 10, text: 'ins', old: '' }]]), [{ start: 13, end: 18 }]);
    assert.deepEqual(rebaseRanges(ranges, [[{ start: 15, end: 15, text: 'ins', old: '' }]]), [{ start: 10, end: 15 }]);
  });
  test('returns null when a later edit overlaps', () => {
    assert.equal(rebaseRanges([{ start: 10, end: 15 }], [[{ start: 12, end: 20, text: '', old: 'x'.repeat(8) }]]), null);
    assert.equal(rebaseRanges([{ start: 10, end: 15 }], [[{ start: 12, end: 12, text: 'x', old: '' }]]), null);
  });
});

describe('large decks', () => {
  test('a 100-slide, 10 MB deck anchors and patches quickly', () => {
    const filler = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit. '.repeat(1700);
    const slides = Array.from({ length: 100 }, (_, i) => `<section class="slide"><h2>Slide ${i}</h2><p>${filler}</p><ul><li>a<li>b</ul></section>\n`).join('');
    const src = `<!doctype html><html><head><style>.slide{height:100vh}</style></head><body>\n${slides}</body></html>`;
    assert.ok(src.length > 9_000_000);
    const cpu0 = process.cpuUsage();
    const anchored = anchorSource(src).source;
    const index = indexSource(anchored);
    const [aiId] = [...index.ids].find(([, t]) => t === 'h2');
    const plan = planOp(index, { type: 'setInner', aiId, tag: 'h2', before: 'Slide 0', after: 'First' });
    const out = applySplices(anchored, plan.splices).source;
    plan.verify(indexSource(out));
    const { user, system } = process.cpuUsage(cpu0);
    const ms = Math.round((user + system) / 1000);
    assert.ok(ms < 5000, `took ${ms} ms of CPU`);
    assert.equal(out.length, anchored.length - 2);
  });
});
