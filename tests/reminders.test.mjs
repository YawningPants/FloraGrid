import test from 'node:test';
import assert from 'node:assert/strict';
import {
  occurrenceDates,
  lunarDate,
  normalizeReminderStore,
  updateReminderRule,
  generateReminderTasks,
  reconcileReminderDay,
  markCustomizedReminders,
  mergeSavedReminderDay,
  reminderIds,
} from '../src/domain/reminders.mjs';
import { searchCalendar } from '../src/domain/calendar-search.mjs';
import { createPastedTaskFromClipboard, copyTask } from '../src/domain/task-clipboard.mjs';

const today = '2026-10-24';
const spec = (patch = {}) => ({
  title: '生日',
  kind: 'birthday',
  frequency: 'yearly',
  calendar: 'solar',
  month: 10,
  day: 24,
  weekdays: [1],
  leapMonth: false,
  color: '#c5b985',
  pinned: false,
  ...patch,
});
const create = (patch = {}) =>
  updateReminderRule(
    normalizeReminderStore(null),
    { id: 'rule-test', spec: spec(patch), startDate: today },
    today,
  );
const tasks = (store, date) => generateReminderTasks(store, date, date).get(date) || [];
test('Gregorian short months and leap birthdays use the last valid day', () => {
  assert.deepEqual(occurrenceDates(spec({ frequency: 'monthly', day: 31 }), '2024-02-01', '2024-04-30'), [
    '2024-02-29',
    '2024-03-31',
    '2024-04-30',
  ]);
  assert.deepEqual(occurrenceDates(spec({ month: 2, day: 29 }), '2023-01-01', '2024-12-31'), [
    '2023-02-28',
    '2024-02-29',
  ]);
});
test('Chinese calendar recognizes New Year and leap second month', () => {
  assert.deepEqual(lunarDate('2024-02-10'), { year: 2024, month: 1, day: 1, leap: false });
  assert.deepEqual(lunarDate('2023-03-22'), { year: 2023, month: 2, day: 1, leap: true });
  assert.deepEqual(
    occurrenceDates(spec({ calendar: 'lunar', month: 2, day: 1 }), '2023-01-01', '2023-12-31'),
    ['2023-02-20'],
  );
  assert.deepEqual(
    occurrenceDates(
      spec({ calendar: 'lunar', month: 2, day: 1, leapMonth: true }),
      '2023-01-01',
      '2023-12-31',
    ),
    ['2023-03-22'],
  );
  assert.deepEqual(
    occurrenceDates(
      spec({ calendar: 'lunar', month: 2, day: 1, leapMonth: true }),
      '2024-01-01',
      '2024-12-31',
    ),
    ['2024-03-10'],
  );
});
test('lunar monthly reminders include the leap month and clamp small-month day 30', () => {
  const dates = occurrenceDates(
    spec({ calendar: 'lunar', frequency: 'monthly', day: 30 }),
    '2023-01-22',
    '2024-02-09',
  );
  assert.equal(dates.length, 13);
  assert.equal(new Set(dates).size, 13);
  for (const date of dates) assert.ok([29, 30].includes(lunarDate(date).day));
});
test('weekly multiple weekdays and effective date boundaries', () => {
  assert.deepEqual(
    occurrenceDates(spec({ frequency: 'weekly', weekdays: [1, 5] }), '2026-10-24', '2026-11-01'),
    ['2026-10-26', '2026-10-30'],
  );
  const store = create({ frequency: 'weekly', weekdays: [6] });
  assert.equal(tasks(store, '2026-10-17').length, 0);
  assert.equal(tasks(store, today).length, 1);
});
test('stopping preserves today and past; removes untouched future instances; protects user work', () => {
  const store = create({ frequency: 'weekly', weekdays: [6] });
  const stopped = updateReminderRule(store, { id: 'rule-test', action: 'stop' }, today);
  assert.equal(tasks(stopped, today).length, 1);
  assert.equal(tasks(stopped, '2026-10-31').length, 0);
  const future = tasks(store, '2026-10-31')[0];
  assert.equal(
    reconcileReminderDay({ date: '2026-10-31', tasks: [future] }, [], stopped, today).tasks.length,
    0,
  );
  for (const patch of [
    { title: '我的修改' },
    { status: 'completed' },
    { status: 'failed' },
    { children: [{ id: 'child', title: '子任务', status: 'active', children: [] }] },
  ]) {
    const preserved = reconcileReminderDay(
      { date: '2026-10-31', tasks: [{ ...future, ...patch }] },
      [],
      stopped,
      today,
    ).tasks[0];
    assert.ok(preserved);
    assert.equal(preserved.reminder, undefined);
    assert.deepEqual(preserved.children, patch.children || []);
  }
});
test('editing future rules keeps history; appearance-only edits apply today; restoring does not fill the disabled gap', () => {
  const store = create();
  const edited = updateReminderRule(store, { id: 'rule-test', spec: spec({ title: '新名称' }) }, today);
  assert.equal(tasks(edited, today)[0].title, '生日');
  assert.equal(tasks(edited, '2027-10-24')[0].title, '新名称');
  const colored = updateReminderRule(store, { id: 'rule-test', spec: spec({ color: '#99b888' }) }, today);
  assert.equal(tasks(colored, today)[0].color, '#99b888');
  const stopped = updateReminderRule(
    create({ frequency: 'weekly', weekdays: [6] }),
    { id: 'rule-test', action: 'stop' },
    today,
  );
  const restored = updateReminderRule(
    stopped,
    { id: 'rule-test', action: 'restore', startDate: '2026-11-07' },
    '2026-11-01',
  );
  assert.equal(tasks(restored, '2026-10-31').length, 0);
  assert.equal(tasks(restored, '2026-11-07').length, 1);
});

test('permanent deletion requires a stopped rule and preserves generated history without future regeneration', () => {
  const store = create({ frequency: 'weekly', weekdays: [6] });
  const historical = {
    date: today,
    note: '保留随笔',
    tasks: [{ ...tasks(store, today)[0], status: 'completed' }],
  };
  assert.throws(() => updateReminderRule(store, { id: 'rule-test', action: 'delete' }, today), /先停用/);
  const stopped = updateReminderRule(store, { id: 'rule-test', action: 'stop' }, today);
  stopped.exceptions['rule-test|2026-10-17'] = 'deleted';
  stopped.exceptions['other-rule|2026-10-17'] = 'deleted';
  const deleted = updateReminderRule(stopped, { id: 'rule-test', action: 'delete' }, today);
  assert.equal(deleted.rules.length, 0);
  assert.deepEqual(deleted.exceptions, { 'other-rule|2026-10-17': 'deleted' });
  assert.deepEqual(reconcileReminderDay(historical, [], deleted, today), historical);
  assert.equal(tasks(deleted, '2026-10-31').length, 0);
  assert.deepEqual(updateReminderRule(deleted, { id: 'rule-test', action: 'delete' }, today), deleted);
});
test('generation is idempotent and single deletion cannot resurrect', () => {
  const store = create(),
    generated = tasks(store, today);
  const day = { date: today, note: '笔记', tasks: generated };
  assert.deepEqual(reconcileReminderDay(day, generated, store, today), day);
  const changed = markCustomizedReminders([{ ...generated[0], status: 'deleted' }]);
  mergeSavedReminderDay({ ...day, tasks: changed }, day, reminderIds(day.tasks), store, today);
  assert.equal(tasks(store, today).length, 0);
  const restored = mergeSavedReminderDay(
    day,
    { ...day, tasks: changed },
    reminderIds(day.tasks),
    store,
    today,
  );
  assert.equal(restored.tasks[0].status, 'active');
  assert.equal(tasks(store, today).length, 1);
});
test('stale day saves keep newly generated tasks and cannot resurrect removed future instances', () => {
  const store = create({ frequency: 'weekly', weekdays: [6] });
  const generated = tasks(store, '2026-10-31')[0];
  const ordinary = { id: 'manual', title: '普通任务', status: 'active', children: [], tags: [] };
  const stale = { date: '2026-10-31', note: '', tasks: [ordinary] };
  assert.equal(
    mergeSavedReminderDay(stale, { ...stale, tasks: [ordinary, generated] }, [], store, today).tasks.length,
    2,
  );
  const stopped = updateReminderRule(store, { id: 'rule-test', action: 'stop' }, today);
  assert.equal(
    mergeSavedReminderDay({ ...stale, tasks: [generated] }, stale, [generated.id], stopped, today).tasks
      .length,
    0,
  );
  const edited = markCustomizedReminders([{ ...generated, title: '用户编辑' }]);
  const saved = mergeSavedReminderDay({ ...stale, tasks: edited }, stale, [generated.id], stopped, today);
  assert.equal(saved.tasks[0].title, '用户编辑');
  assert.equal(saved.tasks[0].reminder, undefined);
});
test('search includes nested tasks, inherited tags, notes and undated tasks without leaking deleted subtrees', () => {
  const day = {
    date: today,
    note: '计划复盘',
    tasks: [
      {
        id: 'parent',
        title: '工作',
        tags: [{ text: '计划' }],
        status: 'active',
        children: [{ id: 'child', title: '复盘', status: 'completed' }],
      },
      {
        id: 'gone',
        title: '复盘',
        status: 'deleted',
        children: [{ id: 'hidden', title: '复盘', status: 'active' }],
      },
    ],
  };
  const found = searchCalendar({
    days: [day],
    longTasks: [{ id: 'long', title: '复盘', status: 'active' }],
    store: normalizeReminderStore(null),
    query: '复盘',
    from: today,
    through: today,
  });
  assert.deepEqual(found.map((item) => item.type).sort(), ['long', 'note', 'task']);
  assert.equal(found.find((item) => item.taskId === 'child').breadcrumb, '工作');
});
