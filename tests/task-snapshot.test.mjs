import test from 'node:test';
import assert from 'node:assert/strict';
import { getPersistableTasks } from '../src/domain/task-snapshot.mjs';

const task = (id, title = '', status = 'active', children = []) => ({
  id,
  title,
  status,
  children,
  tags: [],
});

test('unchanged tasks are shared until the storage queue takes its single deep snapshot', () => {
  const items = [
    { ...task('root', '阅读'), tags: [{ text: '日常', color: '#abc' }], children: [task('child', '笔记')] },
  ];
  const before = structuredClone(items);
  assert.equal(getPersistableTasks(items), items);
  assert.deepEqual(items, before);
});

test('pruning only copies changed ancestors and preserves meaningful blank tasks', () => {
  const child = task('child', '有内容'),
    valid = task('valid', '保留');
  const parent = task('parent', '', 'active', [task('empty'), child]);
  const tagged = { ...task('tagged'), tags: [{ text: '以后处理' }] };
  const items = [
    task('draft'),
    parent,
    valid,
    tagged,
    task('done', '', 'completed'),
    task('failed', '', 'failed'),
  ];
  const before = structuredClone(items),
    result = getPersistableTasks(items);
  assert.deepEqual(
    result.map((t) => t.id),
    ['parent', 'valid', 'tagged', 'done', 'failed'],
  );
  assert.notEqual(result[0], parent);
  assert.equal(result[0].children[0], child);
  assert.equal(result[1], valid);
  assert.equal(result[2], tagged);
  assert.deepEqual(items, before);
});

test('one synchronous clone isolates queued saves, subsequent edits and failed-write retries', async () => {
  const previousWindow = globalThis.window,
    previousStorage = globalThis.localStorage,
    clone = globalThis.structuredClone,
    navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  // Exercise the storage adapter's deterministic fallback; real browser locks have integration coverage.
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {} });
  const values = new Map(),
    timers = new Set();
  let failNext = false,
    clones = 0;
  globalThis.localStorage = {
    getItem: (key) => values.get(key) || null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => {
      if (failNext && key.startsWith('desktop-calendar:day:')) {
        failNext = false;
        throw Error('temporary write failure');
      }
      values.set(key, value);
    },
  };
  globalThis.window = Object.assign(new EventTarget(), {
    setTimeout: (callback, ms) => {
      const timer = setTimeout(callback, ms);
      timers.add(timer);
      return timer;
    },
    clearTimeout: (timer) => {
      clearTimeout(timer);
      timers.delete(timer);
    },
  });
  try {
    const { scheduleSaveDay, flushDaySave } = await import('../src/storage/day-storage.mjs?snapshot-test');
    const source = [
      {
        ...task('root', '原始标题', 'active', [task('child', '子任务')]),
        tags: [{ text: '原始标签', color: '#abc' }],
      },
    ];
    globalThis.structuredClone = (value) => {
      clones++;
      return clone(value);
    };
    scheduleSaveDay({ date: '2026-10-25', note: '原始笔记', tasks: getPersistableTasks(source) });
    assert.equal(clones, 1, 'only the storage queue clones the full task data');
    source[0].title = '之后的编辑';
    source[0].tags[0].text = '之后的标签';
    source[0].children[0].title = '之后的子任务';
    await flushDaySave();
    let stored = JSON.parse(values.get('desktop-calendar:day:2026-10-25'));
    assert.equal(stored.tasks[0].title, '原始标题');
    assert.equal(stored.tasks[0].tags[0].text, '原始标签');
    assert.equal(stored.tasks[0].children[0].title, '子任务');
    clones = 0;
    scheduleSaveDay({ date: '2026-10-25', note: '再次保存', tasks: getPersistableTasks(source) });
    assert.equal(clones, 1);
    failNext = true;
    await assert.rejects(flushDaySave(), /temporary write failure/);
    source[0].title = '重试期间的新编辑';
    await flushDaySave();
    stored = JSON.parse(values.get('desktop-calendar:day:2026-10-25'));
    assert.equal(stored.tasks[0].title, '之后的编辑');
    assert.equal(stored.note, '再次保存');
  } finally {
    timers.forEach(clearTimeout);
    globalThis.structuredClone = clone;
    if (navigatorDescriptor) Object.defineProperty(globalThis, 'navigator', navigatorDescriptor);
    else delete globalThis.navigator;
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
    if (previousStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = previousStorage;
  }
});
