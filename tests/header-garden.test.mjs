import test from 'node:test';
import assert from 'node:assert/strict';
import {
  gardenCapacity,
  gardenFrontCapacity,
  gardenTaskLayers,
  gardenFoliageGeometry,
  gardenPlantGeometry,
  gardenPlantProfile,
  gardenSlotCount,
  reconcileGardenSlots,
  recordTaskCompletion,
  selectGardenTasks,
} from '../src/domain/header-garden.mjs';

const task = (id, completedAt, status = 'completed', children = []) => ({
  id,
  status,
  completedAt,
  children,
});

test('garden stays bounded at all window widths and keeps the newest completed tasks', () => {
  const items = Array.from({ length: 5000 }, (_, i) => task(`task-${i}`, i + 1));
  items.push(
    task('active', 6000, 'active'),
    task('failed', 6001, 'failed'),
    task('deleted', 6002, 'deleted'),
  );
  for (const width of [320, 390, 600]) {
    const capacity = gardenCapacity(width),
      result = selectGardenTasks(items, capacity);
    assert.equal(result.total, 5000);
    assert.equal(result.tasks.length, capacity);
    assert.deepEqual(
      result.tasks.map((t) => t.id),
      Array.from({ length: capacity }, (_, i) => `task-${4999 - i}`),
    );
  }
  assert.equal(gardenCapacity(320), 10);
  assert.equal(gardenCapacity(390), 14);
  assert.equal(gardenCapacity(600), 18);
});

test('legacy and nested tasks have a stable selection regardless of tree ordering or collapse', () => {
  const items = [
    task('root', undefined, 'active', [task('child', undefined), task('new', 50)]),
    task('older', undefined),
  ];
  items[0].collapsed = true;
  const before = structuredClone(items),
    selected = selectGardenTasks(items, 2);
  assert.equal(selected.total, 3);
  assert.equal(selected.tasks[0].id, 'new');
  assert.deepEqual(
    selectGardenTasks([...items].reverse(), 2).tasks.map((t) => t.id),
    selected.tasks.map((t) => t.id),
  );
  assert.deepEqual(items, before, 'rendering legacy flowers never rewrites task data');
});

test('overflow uses a distant reserve and undo backfills without moving other flowers', () => {
  const items = Array.from({ length: 9 }, (_, i) => task(String(i), i + 1));
  const first = reconcileGardenSlots(selectGardenTasks(items.slice(0, 8), 8).tasks, new Map(), 8);
  const next = reconcileGardenSlots(selectGardenTasks(items, 8).tasks, first, 8);
  assert.notEqual(next.get('8'), first.get('0'));
  assert.ok(
    Math.abs(
      gardenPlantGeometry('8', next.get('8'), 8, 390, 150).x -
        gardenPlantGeometry('0', first.get('0'), 8, 390, 150).x,
    ) > 78,
  );
  for (let i = 1; i < 8; i++) assert.equal(next.get(String(i)), first.get(String(i)));
  items[8].status = 'active';
  const restored = reconcileGardenSlots(selectGardenTasks(items, 8).tasks, next, 8);
  assert.notEqual(restored.get('0'), next.get('8'));
  for (let i = 1; i < 8; i++) assert.equal(restored.get(String(i)), first.get(String(i)));
  assert.deepEqual(
    reconcileGardenSlots(
      selectGardenTasks(items, 8).tasks,
      new Map(JSON.parse(JSON.stringify([...restored]))),
      8,
    ),
    restored,
  );
});

test('bad cached slots are discarded and narrow layouts never exceed the slot boundary', () => {
  const items = Array.from({ length: 12 }, (_, i) => task(String(i), i + 1));
  const result = reconcileGardenSlots(
    selectGardenTasks(items, 6).tasks,
    new Map([
      ['11', -1],
      ['10', 3],
      ['9', 3],
      ['8', 99],
    ]),
    6,
  );
  assert.equal(result.size, 6);
  assert.equal(new Set(result.values()).size, 6);
  for (const [id, slot] of result) {
    assert.ok(slot >= 0 && slot < gardenSlotCount(6));
    const p = gardenPlantGeometry(id, slot, 6, 320, 150);
    assert.ok(p.x > 10 && p.x < 310 && p.height < 150);
  }
});

test('rapid replacement leaves exiting anchors free at each capacity without extra visible plants', () => {
  for (const capacity of [6, 8, 12, 10, 14, 18]) {
    assert.ok(gardenSlotCount(capacity) >= capacity + 3);
    const items = Array.from({ length: capacity }, (_, i) => task(String(i), i + 1));
    let previous = reconcileGardenSlots(selectGardenTasks(items, capacity).tasks, new Map(), capacity),
      exiting = [];
    for (let i = capacity; i < capacity + 40; i++) {
      items.push(task(String(i), i + 1));
      const selected = selectGardenTasks(items, capacity).tasks,
        ids = new Set(selected.map((t) => t.id));
      const outgoing = [...previous].filter(([id]) => !ids.has(id)).map(([, slot]) => slot);
      const next = reconcileGardenSlots(selected, previous, capacity, { reserved: exiting });
      assert.equal(next.size, capacity);
      assert.equal(new Set(next.values()).size, capacity);
      assert.equal([...outgoing, ...exiting].includes(next.get(String(i))), false);
      for (const [id, slot] of previous) if (ids.has(id)) assert.equal(next.get(id), slot);
      exiting = outgoing;
      previous = next;
    }
  }
});

test('completion order survives serialization, equal clocks, undo and a backwards clock', () => {
  const a = task('a', undefined, 'active'),
    b = task('b', undefined, 'active'),
    items = [a, b];
  recordTaskCompletion(a, items, 100);
  a.status = 'completed';
  recordTaskCompletion(b, items, 100);
  b.status = 'completed';
  assert.equal(a.completedAt, 100);
  assert.equal(b.completedAt, 101);
  a.status = 'active';
  recordTaskCompletion(a, items, 80);
  a.status = 'completed';
  assert.equal(a.completedAt, 102);
  assert.deepEqual(
    selectGardenTasks(JSON.parse(JSON.stringify(items)), 8).tasks.map((t) => t.id),
    ['a', 'b'],
  );
});

test('foliage varies between tasks but remains stable through reloads and unrelated updates', () => {
  const profiles = Array.from({ length: 100 }, (_, i) => gardenPlantProfile(`plant-${i}`));
  assert.equal(new Set(profiles.map((p) => p.family)).size, 4);
  assert.equal(new Set(profiles.map((p) => JSON.stringify(p))).size, 100);
  profiles.forEach((profile, i) => {
    assert.deepEqual(gardenPlantProfile(`plant-${i}`), profile);
    assert.ok(profile.leaves.length >= 4 && profile.leaves.length <= 7);
    assert.ok(profile.leaves.every((leaf) => leaf.length <= 16 && leaf.width < 4));
    const left = profile.leaves.filter((leaf) => leaf.side === -1).length;
    assert.ok(Math.abs(left - (profile.leaves.length - left)) <= 1, 'foliage stays balanced across the stem');
  });
});

test('many small blades remain two compound paths, with finite geometry at short and tall heights', () => {
  for (let i = 0; i < 60; i++)
    for (const height of [34, 55, 100, 140]) {
      const profile = gardenPlantProfile(`specimen-${i}`),
        shape = gardenFoliageGeometry(profile, height, (i % 19) - 9);
      assert.ok(shape.leafCount >= 4 && shape.leafCount <= 7);
      assert.equal(
        (shape.front.match(/M/g) || []).length + (shape.back.match(/M/g) || []).length,
        shape.leafCount,
      );
      assert.equal(/NaN|Infinity|undefined/.test(shape.stem + shape.front + shape.back), false);
      assert.deepEqual(gardenFoliageGeometry(profile, height, (i % 19) - 9), shape);
    }
});

test('overflow retires a back-row flower and undo backfills the back row', () => {
  for (const capacity of [10, 14, 18]) {
    const tasks = Array.from({ length: capacity + 3 }, (_, i) => task(String(i), i + 1));
    const first = selectGardenTasks(tasks.slice(0, capacity), capacity).tasks,
      layers = gardenTaskLayers(first, capacity);
    assert.equal(
      [...layers.values()].filter((layer) => layer === 'front').length,
      gardenFrontCapacity(capacity),
    );
    const next = selectGardenTasks(tasks.slice(0, capacity + 1), capacity).tasks;
    const outgoing = first.filter((t) => !next.includes(t));
    assert.equal(outgoing.length, 1);
    assert.equal(layers.get(outgoing[0].id), 'back');
    tasks[capacity].status = 'active';
    const restored = selectGardenTasks(tasks.slice(0, capacity + 1), capacity).tasks;
    const newcomers = restored.filter((t) => !next.includes(t));
    assert.equal(newcomers.length, 1);
    assert.equal(gardenTaskLayers(restored, capacity).get(newcomers[0].id), 'back');
  }
});
