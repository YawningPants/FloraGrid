import test from 'node:test';
import assert from 'node:assert/strict';
import { createBrowserBackup, restoreBrowserBackup, validateBackup } from '../src/domain/backup.mjs';
class Store {
  data = new Map();
  fail = null;
  get length() {
    return this.data.size;
  }
  key(i) {
    return [...this.data.keys()][i];
  }
  getItem(key) {
    return this.data.get(key) || null;
  }
  setItem(key, value) {
    if (this.fail === key) {
      this.fail = null;
      throw Error('quota');
    }
    this.data.set(key, value);
  }
  removeItem(key) {
    this.data.delete(key);
  }
}
const day = (title = '保留花朵') => ({
  date: '2026-10-25',
  note: '随笔',
  tasks: [
    {
      id: 'a',
      title,
      status: 'completed',
      tags: [],
      flower: { variant: 'cosmos', tone: 'rose' },
      children: [{ id: 'b', title: '子任务', status: 'active', children: [] }],
    },
  ],
});
function fixture() {
  const store = new Store();
  store.setItem('desktop-calendar:day:2026-10-25', JSON.stringify(day()));
  store.setItem('unrelated', 'keep');
  store.setItem(
    'desktop-calendar:reminders',
    JSON.stringify({
      rules: [
        {
          id: 'r',
          segments: [
            {
              from: '2026-10-25',
              through: null,
              spec: { title: '生日', frequency: 'yearly', calendar: 'lunar', month: 8, day: 15 },
            },
          ],
        },
      ],
      exceptions: { 'r|2026-10-25': 'deleted' },
    }),
  );
  return store;
}
test('backup roundtrip retains nested tasks, flowers, notes and reminder history without unrelated preferences', () => {
  const source = fixture(),
    backup = createBrowserBackup(source, { theme: { surfaceStyle: 'notebook' } });
  assert.equal(validateBackup(backup).tasks, 2);
  const target = new Store();
  target.setItem('unrelated', 'target');
  restoreBrowserBackup(target, backup);
  assert.deepEqual(JSON.parse(target.getItem('desktop-calendar:day:2026-10-25')), day());
  assert.equal(target.getItem('unrelated'), 'target');
  assert.equal(backup.preferences.theme.surfaceStyle, 'notebook');
});
test('restore validates all records before mutating and rejects duplicate dates, invalid rules and path traversal', () => {
  const store = fixture(),
    backup = createBrowserBackup(store),
    before = [...store.data];
  for (const mutate of [
    (b) => (b.version = 2),
    (b) => b.files.push(b.files[0]),
    (b) => (b.files[0].name = '../secret'),
    (b) => (b.files[0].name = 'days/2026/02/2026-02-30.json'),
    (b) => (b.files[1].data.rules[0].segments[0].spec.day = 99),
  ]) {
    const invalid = structuredClone(backup);
    mutate(invalid);
    assert.throws(() => restoreBrowserBackup(store, invalid));
    assert.deepEqual([...store.data], before);
  }
});
test('partial browser write failure restores the original complete store', () => {
  const store = fixture(),
    backup = createBrowserBackup(store),
    before = [...store.data].sort();
  backup.files[0].data = day('new');
  store.fail = 'desktop-calendar:reminders';
  assert.throws(() => restoreBrowserBackup(store, backup), /quota/);
  assert.deepEqual([...store.data].sort(), before);
});
