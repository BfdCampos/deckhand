import { test } from 'node:test';
import assert from 'node:assert/strict';
import { anchorSource, indexSource, planOp } from '../../src/server/source-patch.js';

const SRC = '<!DOCTYPE html><html><body><section class="slide"><p>Hi</p></section><section style="position: absolute"><p>x</p></section><div class="slide"><p>y</p></div></body></html>';

function setup() {
  const index = indexSource(anchorSource(SRC).source);
  const ids = [...index.ids.entries()];
  const idOf = (tag, n = 0) => ids.filter(([, t]) => t === tag)[n][0];
  return { index, idOf };
}

const op = (aiId, tag, value) => ({ type: 'setStyle', aiId, tag, props: { position: value } });

test('position: relative is allowed on a slide that has no inline position', () => {
  const { index, idOf } = setup();
  const plan = planOp(index, op(idOf('section'), 'section', 'relative'));
  assert.equal(plan.splices.length, 1);
  assert.match(plan.splices[0].text, /position: relative;/);
  const div = planOp(index, op(idOf('div'), 'div', 'relative'));
  assert.equal(div.splices.length, 1);
});

test('position is refused for other values, non-slides and slides that already set one', () => {
  const { index, idOf } = setup();
  for (const value of ['absolute', 'fixed', 'sticky', 'static', 'relative !important']) {
    assert.throws(() => planOp(index, op(idOf('section'), 'section', value)), (e) => e.code === 'bad_op', value);
  }
  assert.throws(() => planOp(index, op(idOf('p'), 'p', 'relative')), (e) => e.code === 'bad_op');
  assert.throws(() => planOp(index, op(idOf('section', 1), 'section', 'relative')), (e) => e.code === 'bad_op');
});

test('position: relative can be removed again', () => {
  const { index, idOf } = setup();
  const plan = planOp(index, op(idOf('section'), 'section', null));
  assert.equal(plan.splices.length, 0);
});
