import { generateReminderTasks } from './reminders.mjs';
export function searchCalendar({
  days,
  longTasks,
  store,
  query,
  from,
  through,
  includeDeleted = false,
  types = ['task', 'reminder', 'note', 'long'],
}) {
  const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const matches = (text) => words.every((word) => text.toLocaleLowerCase().includes(word));
  const results = [],
    seen = new Set();
  const visit = (tasks, date, parents = [], inherited = []) => {
    for (const task of tasks) {
      seen.add(task.id);
      if (task.status === 'deleted' && !includeDeleted) continue;
      const tags = [
        ...inherited,
        ...(task.tags || []).map((tag) => (typeof tag === 'string' ? tag : tag.text || '')),
      ];
      const type = task.reminder ? 'reminder' : 'task';
      if (types.includes(type) && matches([task.title, ...tags].join(' ')))
        results.push({
          id: `${date}:${task.id}`,
          type,
          date,
          taskId: task.id,
          title: task.title || '未命名任务',
          status: task.status,
          breadcrumb: parents.join(' / '),
          snippet: tags.join(' · '),
          pinned: task.pinned,
          ruleId: task.reminder?.ruleId,
        });
      visit(task.children || [], date, [...parents, task.title || '未命名任务'], tags);
    }
  };
  for (const day of days) {
    visit(day.tasks || [], day.date);
    if (types.includes('note') && day.note && matches(day.note))
      results.push({
        id: `${day.date}:note`,
        type: 'note',
        date: day.date,
        title: '当日随笔',
        snippet: day.note,
      });
  }
  if (types.includes('reminder'))
    for (const [date, tasks] of generateReminderTasks(store, from, through)) {
      for (const task of tasks) if (!seen.has(task.id)) visit([task], date);
    }
  if (types.includes('long'))
    for (const task of longTasks) {
      if (task.status === 'deleted' && !includeDeleted) continue;
      const text = [task.title, ...(task.tags || []).map((tag) => tag.text || tag)].join(' ');
      if (matches(text))
        results.push({
          id: `long:${task.id}`,
          type: 'long',
          date: null,
          taskId: task.id,
          title: task.title,
          status: task.status,
          snippet: '无日期 · 长期任务',
        });
    }
  return results.sort(
    (a, b) =>
      (b.date || '').localeCompare(a.date || '') ||
      Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) ||
      a.title.localeCompare(b.title),
  );
}
