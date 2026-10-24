import test from 'node:test';
import assert from 'node:assert/strict';
import { applyTaskDrop, flattenDragTree, getOriginDropTarget, isValidTaskDrop, locateDragSlot, projectTaskDrop } from '../src/domain/task-drag.mjs';

const task = (id, status = 'active', children = [], collapsed = false) => ({ id, title: id, status, children, tags: [], collapsed });
const target = (parentId, beforeId, depth = 0) => ({ parentId, beforeId, depth });
const ids = (items) => items.map((item) => item.id);

test('upward and downward reorder use anchors after excluding the source', () => {
  const items = [task('A'), task('B'), task('C'), task('done', 'completed')];
  const snapshot = structuredClone(items);
  assert.deepEqual(ids(applyTaskDrop(items, 'A', target(null, 'C')).items), ['B', 'A', 'C', 'done']);
  assert.deepEqual(ids(applyTaskDrop(items, 'C', target(null, 'A')).items), ['C', 'A', 'B', 'done']);
  assert.deepEqual(items, snapshot);
});

test('failed/deleted tasks and filtered search cannot start a move', () => {
  const items = [task('A'), task('F', 'failed'), task('D', 'deleted')];
  assert.equal(applyTaskDrop(items, 'F', target(null, 'A'), { showDeletedTasks: true }), null);
  assert.equal(applyTaskDrop(items, 'D', target(null, 'A'), { showDeletedTasks: true }), null);
  assert.equal(applyTaskDrop(items, 'A', target(null, null), { searchQuery: 'A' }), null);
});

test('cross-status drops are rejected instead of redirected to a different slot', () => {
  const items = [task('A'), task('B'), task('done', 'completed'), task('F', 'failed')];
  assert.equal(applyTaskDrop(items, 'A', target(null, 'F')), null);
  assert.equal(applyTaskDrop(items, 'done', target(null, 'A')), null);
  assert.ok(applyTaskDrop(items, 'A', target(null, 'done')));
  assert.ok(applyTaskDrop(items, 'done', target(null, 'F')));
});

test('a parent moves as a complete subtree without changing statuses or data', () => {
  const items = [task('P', 'active', [task('C'), task('F', 'failed', [task('G', 'deleted')])]), task('B')];
  const result = applyTaskDrop(items, 'P', target(null, null));
  assert.deepEqual(ids(result.items), ['B', 'P']);
  assert.deepEqual(result.items[1].children, items[0].children);
  assert.equal(items[0].id, 'P');
});

test('self, descendant, missing-parent, and stale-anchor drops never detach the source', () => {
  const items = [task('P', 'active', [task('C')]), task('B')];
  const snapshot = structuredClone(items);
  for (const drop of [target('P', null, 1), target('C', null, 2), target('missing', null, 1), target(null, 'missing')]) {
    assert.equal(applyTaskDrop(items, 'P', drop), null);
    assert.deepEqual(items, snapshot);
  }
});

test('new children require an active parent; existing siblings under a completed parent can reorder', () => {
  const items = [task('A'), task('P', 'completed', [task('C1', 'completed'), task('C2', 'completed')])];
  assert.equal(applyTaskDrop(items, 'A', target('P', 'C1', 1)), null);
  const result = applyTaskDrop(items, 'C2', target('P', 'C1', 1));
  assert.deepEqual(ids(result.items[1].children), ['C2', 'C1']);
});

test('dropping into a leaf creates children only in the committed copy', () => {
  const items = [task('A'), { id: 'P', title: 'P', status: 'active', collapsed: true }];
  const result = applyTaskDrop(items, 'A', target('P', null, 1));
  assert.equal(items[1].children, undefined);
  assert.equal(items[1].collapsed, true);
  assert.deepEqual(ids(result.items[0].children), ['A']);
  assert.equal(result.items[0].collapsed, false);
});

test('flattening respects collapsed branches and excludes the entire dragged subtree', () => {
  const items = [task('P', 'active', [task('C', 'active', [task('G')])], true), task('B')];
  assert.deepEqual(ids(flattenDragTree(items)), ['P', 'B']);
  assert.deepEqual(ids(flattenDragTree(items, { expandedIds: new Set(['P']) })), ['P', 'C', 'G', 'B']);
  assert.deepEqual(ids(flattenDragTree(items, { excludedId: 'P', expandedIds: new Set(['P']) })), ['B']);
});

test('hierarchy projection requires an explicit depth and never silently increases it', () => {
  const items = [task('A'), task('P', 'active', [task('C')]), task('B')];
  const rows = flattenDragTree(items, { excludedId: 'A' });
  assert.equal(projectTaskDrop(items, 'A', rows, 1, 0), null);
  const nested = projectTaskDrop(items, 'A', rows, 1, 1);
  assert.equal(nested.parentId, 'P');
  assert.equal(nested.beforeId, 'C');
  const sibling = projectTaskDrop(items, 'A', rows, 2, 0);
  assert.equal(sibling.parentId, null);
  assert.equal(sibling.beforeId, 'B');
});

test('a child can outdent only at a genuine ancestor boundary', () => {
  const items = [task('P', 'active', [task('C1'), task('C2')]), task('B')];
  const rows = flattenDragTree(items, { excludedId: 'C1' });
  assert.equal(projectTaskDrop(items, 'C1', rows, 1, 0), null);
  const projected = projectTaskDrop(items, 'C1', rows, 2, 0);
  assert.deepEqual(ids(applyTaskDrop(items, 'C1', projected).items), ['P', 'C1', 'B']);
});

test('insertion slots are monotonic through tall and short cards', () => {
  const rows = [{ id: 'A', top: 0, bottom: 40 }, { id: 'B', top: 45, bottom: 205 }, { id: 'C', top: 210, bottom: 250 }];
  assert.deepEqual([-5, 19, 20, 70, 124, 125, 229, 230, 280].map((y) => locateDragSlot(rows, y)), [0, 0, 1, 1, 1, 2, 2, 3, 3]);
});

test('pointer inside the result preview keeps its logical boundary while surrounding cards move', () => {
  const rows = [{ id: 'B', top: 0, bottom: 50 }, { id: 'C', top: 160, bottom: 210 }];
  assert.equal(locateDragSlot(rows, 140, { top: 55, bottom: 155 }, { slotBeforeId: 'C' }), 1);
  assert.equal(locateDragSlot(rows, 186, { top: 55, bottom: 155 }, { slotBeforeId: 'C' }), 2);
});

test('no-op drops need no copy or save; hidden deleted tasks are preserved', () => {
  const items = [task('A'), task('B'), task('D', 'deleted')];
  const origin = getOriginDropTarget(items, 'A');
  assert.deepEqual(origin, { parentId: null, beforeId: 'B', depth: 0, slotBeforeId: 'B' });
  assert.deepEqual(applyTaskDrop(items, 'A', origin), { items, changed: false });
  const result = applyTaskDrop(items, 'A', target(null, null));
  assert.equal(result.items.find((item) => item.id === 'D').status, 'deleted');
  assert.deepEqual(ids(flattenDragTree(result.items)), ['B', 'A']);
});

test('single-task and flat-list modes support a stable preview without inventing parents', () => {
  const items = [task('A')];
  const projected = projectTaskDrop(items, 'A', [], 0, 0, { flat: true });
  assert.ok(projected);
  assert.equal(applyTaskDrop(items, 'A', projected).changed, false);
  assert.equal(isValidTaskDrop([task('A'), task('P')], 'A', target('P', null, 1), { flat: true }), false);
});
