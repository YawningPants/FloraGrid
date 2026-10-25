import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ensureTaskFlower,
  flowerTones,
  flowerVariants,
  getTaskFlower,
  isTaskFlower,
} from '../src/domain/flowers.mjs';
import { normalizeTaskTree } from '../src/domain/tasks.mjs';
import { copyTask, createPastedTaskFromClipboard } from '../src/domain/task-clipboard.mjs';

test('random assignment covers the full flower pool and tones, and survives undo and serialization', () => {
  const shapes = new Set(),
    tones = new Set();
  for (let i = 0; i < flowerVariants.length; i++) {
    const task = { id: `flower-${i}`, status: 'active', children: [] };
    const values = [(i + 0.1) / flowerVariants.length, ((i % flowerTones.length) + 0.1) / flowerTones.length];
    const flower = ensureTaskFlower(task, () => values.shift());
    shapes.add(flower.variant);
    tones.add(flower.tone);
    task.status = 'completed';
    task.status = 'active';
    assert.equal(
      ensureTaskFlower(task, () => {
        throw Error('must not reroll');
      }),
      flower,
    );
    assert.deepEqual(getTaskFlower(normalizeTaskTree(JSON.parse(JSON.stringify([task])))[0]), flower);
  }
  assert.deepEqual(shapes, new Set(flowerVariants));
  assert.deepEqual(tones, new Set(flowerTones));
});

test('historical tasks get stable varied flowers without modifying data', () => {
  const samples = Array.from({ length: 40 }, (_, i) => ({ id: `historical-${i}`, status: 'completed' }));
  const before = structuredClone(samples);
  for (const task of samples) assert.deepEqual(getTaskFlower(task), getTaskFlower(structuredClone(task)));
  assert.deepEqual(samples, before);
  assert.ok(new Set(samples.map((task) => getTaskFlower(task).variant)).size >= 4);
  assert.ok(new Set(samples.map((task) => getTaskFlower(task).tone)).size >= 4);
});

test('invalid persisted flower metadata is ignored and repaired on completion', () => {
  const task = { id: 'invalid', flower: { variant: '<svg>', tone: 'unknown' } };
  assert.equal(isTaskFlower(task.flower), false);
  assert.equal(isTaskFlower(getTaskFlower(task)), true);
  assert.deepEqual(
    ensureTaskFlower(task, () => 0.99),
    { variant: 'aster', tone: 'sage' },
  );
});

test('copying a tree preserves task content and statuses while giving new tasks fresh flowers', () => {
  const previousWindow = globalThis.window,
    storage = new Map();
  globalThis.window = {
    localStorage: {
      setItem: (key, value) => storage.set(key, value),
      getItem: (key) => storage.get(key),
      removeItem: (key) => storage.delete(key),
    },
  };
  try {
    const source = {
      id: 'source',
      title: '读书',
      status: 'completed',
      completedAt: 100,
      color: '#9cbfd0',
      tags: [{ id: 't', text: '阅读' }],
      flower: { variant: 'daisy', tone: 'rose' },
      children: [
        {
          id: 'child',
          title: '记笔记',
          status: 'completed',
          completedAt: 99,
          flower: { variant: 'wild', tone: 'sage' },
          children: [],
        },
      ],
    };
    const original = structuredClone(source);
    copyTask({ sourceDate: '2026-10-23', task: source });
    const pasted = createPastedTaskFromClipboard();
    assert.notEqual(pasted.id, source.id);
    assert.notEqual(pasted.children[0].id, source.children[0].id);
    assert.equal(pasted.flower, undefined);
    assert.equal(pasted.children[0].flower, undefined);
    assert.equal(pasted.completedAt, undefined);
    assert.equal(pasted.children[0].completedAt, undefined);
    assert.equal(pasted.status, 'completed');
    assert.equal(pasted.color, source.color);
    assert.deepEqual(pasted.tags, source.tags);
    assert.equal(pasted.children[0].status, 'completed');
    assert.deepEqual(source, original);
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
});
