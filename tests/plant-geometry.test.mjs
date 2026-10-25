import test from 'node:test';
import assert from 'node:assert/strict';
import { cubicPoint, cubicTangent, taskBranchGeometry } from '../src/domain/plant-geometry.mjs';

test('forks stay on the continuous stem and leave with the same tangent after changes in row heights', () => {
  for (const heights of [[42], [45, 78, 38], [140, 45, 96, 40], [45, 40, 38, 42, 90]]) {
    let y = 50;
    const leaves = heights.map((height, i) => ({ id: `task-${i}`, x: 59, y: (y += height) }));
    const shape = taskBranchGeometry({ x: 30, y: 25 }, leaves);
    for (const fork of shape.forks) {
      const attachment = cubicPoint(shape.curve, fork.t),
        tangent = cubicTangent(shape.curve, fork.t);
      const direction = { x: fork.curve[1].x - fork.curve[0].x, y: fork.curve[1].y - fork.curve[0].y };
      assert.ok(Math.hypot(attachment.x - fork.curve[0].x, attachment.y - fork.curve[0].y) < 1e-8);
      assert.ok(Math.abs(tangent.x * direction.y - tangent.y * direction.x) < 1e-6, 'no corner at the fork');
      assert.ok(tangent.x * direction.x + tangent.y * direction.y > 0, 'fork cannot reverse along the stem');
    }
  }
});

test('the last fork continues from the exact end of the stem, without a leftover stub', () => {
  const shape = taskBranchGeometry({ x: 31, y: 28 }, [
    { id: 'one', x: 55, y: 80 },
    { id: 'two', x: 55, y: 180 },
  ]);
  assert.equal(shape.forks.at(-1).t, 1);
  assert.deepEqual(shape.forks.at(-1).curve[0], shape.curve.at(-1));
  assert.equal(taskBranchGeometry({ x: 31, y: 28 }, []), null);
});
