import test from 'node:test';
import assert from 'node:assert/strict';
import { reopenCompletedAncestors } from '../src/domain/tasks.mjs';
const node = (id, status, children = []) => ({
  id,
  status,
  children,
  flower: { variant: 'cosmos', tone: 'rose' },
});
test('reopening a leaf reopens every completed ancestor and preserves flower identity', () => {
  const leaf = node('leaf', 'active'),
    parent = node('parent', 'completed', [leaf]),
    root = node('root', 'completed', [parent]);
  assert.deepEqual(
    reopenCompletedAncestors([root], 'leaf').map((t) => t.id),
    ['parent', 'root'],
  );
  assert.equal(parent.status, 'active');
  assert.equal(root.status, 'active');
  assert.equal(root.flower.variant, 'cosmos');
  assert.deepEqual(reopenCompletedAncestors([root], 'leaf'), []);
  assert.deepEqual(reopenCompletedAncestors([root], 'missing'), []);
});
test('explicit failed and deleted states are preserved while completed ancestors reopen', () => {
  for (const status of ['failed', 'deleted']) {
    const root = node('root', 'completed', [node('mid', status, [node('leaf', 'active')])]);
    reopenCompletedAncestors([root], 'leaf');
    assert.equal(root.status, 'active');
    assert.equal(root.children[0].status, status);
  }
});
