import { getTodayDateKey } from './date.mjs';

const DAY = 86400000;
const lunarFormatter = new Intl.DateTimeFormat('en-US-u-ca-chinese', { year: 'numeric', month: 'numeric', day: 'numeric', timeZone: 'UTC' });
const lunarYears = new Map();
export const reminderKinds = { birthday: '生日', anniversary: '纪念日', routine: '周期提醒' };
export function dateNumber(key) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key || '')) throw new Error('日期格式不正确');
  const [y, m, d] = key.split('-').map(Number);
  const date = new Date(0); date.setUTCFullYear(y, m - 1, d); date.setUTCHours(12, 0, 0, 0);
  if (date.toISOString().slice(0, 10) !== key) throw new Error('日期不存在');
  return date.getTime();
}
export const dateKey = (time) => new Date(time).toISOString().slice(0, 10);
export const addDays = (key, count) => dateKey(dateNumber(key) + count * DAY);
export function daysBetween(from, through) {
  const a = dateNumber(from), b = dateNumber(through);
  if (a > b) return [];
  if ((b - a) / DAY > 36600) throw new Error('日期范围请控制在 100 年以内');
  return Array.from({ length: Math.round((b - a) / DAY) + 1 }, (_, i) => dateKey(a + i * DAY));
}
export function lunarDate(key) {
  if (lunarFormatter.resolvedOptions().calendar !== 'chinese') throw new Error('当前运行环境不支持农历，请更新 WebView2');
  const parts = Object.fromEntries(lunarFormatter.formatToParts(new Date(dateNumber(key))).map(p => [p.type, p.value]));
  const month = /^(\d+)(bis)?$/.exec(parts.month);
  if (!month || !parts.relatedYear) throw new Error('当前运行环境无法识别农历日期');
  return { year: Number(parts.relatedYear), month: Number(month[1]), day: Number(parts.day), leap: Boolean(month[2]) };
}
function lunarMonths(year) {
  if (lunarYears.has(year)) return lunarYears.get(year);
  const months = [];
  for (const key of daysBetween(`${year}-01-01`, `${year + 1}-03-01`)) {
    const lunar = lunarDate(key);
    if (lunar.year !== year) continue;
    let month = months.at(-1);
    if (!month || month.month !== lunar.month || month.leap !== lunar.leap) {
      month = { month: lunar.month, leap: lunar.leap, dates: [] }; months.push(month);
    }
    month.dates.push(key);
  }
  lunarYears.set(year, months);
  if (lunarYears.size > 110) lunarYears.delete(lunarYears.keys().next().value);
  return months;
}
export function normalizeReminderStore(data) {
  return { version: 1, revision: Number(data?.revision) || 0, sealedThrough: data?.sealedThrough || null,
    rules: structuredClone(data?.rules || []), exceptions: { ...(data?.exceptions || {}) } };
}
export function validateReminderSpec(spec) {
  if (!spec.title?.trim()) throw new Error('请输入提醒名称');
  if (!['yearly', 'monthly', 'weekly'].includes(spec.frequency)) throw new Error('请选择重复频率');
  if (!['solar', 'lunar'].includes(spec.calendar)) throw new Error('请选择公历或农历');
  if (spec.frequency === 'weekly') {
    if (!spec.weekdays?.length || spec.weekdays.some(d => !Number.isInteger(d) || d < 0 || d > 6)) throw new Error('至少选择一个星期');
  } else {
    if (!Number.isInteger(spec.day) || spec.day < 1 || spec.day > (spec.calendar === 'lunar' ? 30 : 31)) throw new Error('日期超出范围');
    if (spec.frequency === 'yearly' && (!Number.isInteger(spec.month) || spec.month < 1 || spec.month > 12)) throw new Error('月份超出范围');
    if (spec.frequency === 'yearly' && spec.calendar === 'solar' && spec.day > new Date(Date.UTC(2024, spec.month, 0)).getUTCDate()) throw new Error('该月份不存在指定日期');
  }
}
export function describeReminder(spec) {
  const calendar = spec.calendar === 'lunar' ? '农历' : '公历';
  if (spec.frequency === 'weekly') return `每周 ${(spec.weekdays || []).map(d => ['日', '一', '二', '三', '四', '五', '六'][d]).join('、')}`;
  return spec.frequency === 'monthly' ? `${calendar}每月 ${spec.day} 日` : `${calendar}每年 ${spec.leapMonth && spec.calendar === 'lunar' ? '闰' : ''}${spec.month} 月 ${spec.day} 日`;
}
export function occurrenceDates(spec, from, through) {
  validateReminderSpec(spec);
  if (from > through) return [];
  dateNumber(from); dateNumber(through);
  const dates = [];
  const include = key => { if (key >= from && key <= through) dates.push(key); };
  if (spec.frequency === 'weekly') return daysBetween(from, through).filter(key => spec.weekdays.includes(new Date(dateNumber(key)).getUTCDay()));
  const firstYear = Number(from.slice(0, 4)), lastYear = Number(through.slice(0, 4));
  if (lastYear - firstYear > 100) throw new Error('日期范围请控制在 100 年以内');
  if (spec.calendar === 'lunar') {
    for (let year = firstYear - 1; year <= lastYear; year++) {
      const months = lunarMonths(year);
      const selected = spec.frequency === 'monthly' ? months : [months.find(m => m.month === spec.month && m.leap === Boolean(spec.leapMonth)) || months.find(m => m.month === spec.month && !m.leap)].filter(Boolean);
      selected.forEach(month => include(month.dates[Math.min(spec.day, month.dates.length) - 1]));
    }
  } else {
    for (let year = firstYear; year <= lastYear; year++) {
      const months = spec.frequency === 'monthly' ? Array.from({ length: 12 }, (_, i) => i + 1) : [spec.month];
      months.forEach(month => {
        const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
        include(`${year}-${String(month).padStart(2, '0')}-${String(Math.min(spec.day, last)).padStart(2, '0')}`);
      });
    }
  }
  return [...new Set(dates)].sort();
}
export const occurrenceKey = (ruleId, date) => `${ruleId}|${date}`;
export function taskBaseline(task) {
  return { title: task.title || '', color: task.color || null, pinned: Boolean(task.pinned), kind: task.kind || 'routine' };
}
export function isPristineReminder(task) {
  return Boolean(task.reminder && !task.reminder.edited && task.status === 'active' && !(task.children || []).length && !(task.tags || []).length && JSON.stringify(taskBaseline(task)) === JSON.stringify(task.reminder.baseline));
}
export function markCustomizedReminders(tasks, depth = 0) {
  return tasks.map(task => {
    const next = { ...task, children: markCustomizedReminders(task.children || [], depth + 1) };
    if (next.reminder && (depth > 0 || !isPristineReminder(next))) next.reminder = { ...next.reminder, edited: true };
    return next;
  });
}
export function markMovedReminders(before, after) {
  const positions = new Map();
  const index = (tasks, parent = '') => tasks.forEach((task, i) => { positions.set(task.id, `${parent}:${i}`); index(task.children || [], task.id); });
  index(before);
  const mark = (tasks, parent = '') => tasks.map((task, i) => ({ ...task,
    ...(task.reminder && positions.get(task.id) !== `${parent}:${i}` ? { reminder: { ...task.reminder, edited: true } } : {}), children: mark(task.children || [], task.id) }));
  return mark(after);
}
export function generateReminderTasks(store, from, through) {
  const result = new Map();
  for (const rule of store.rules) for (const segment of rule.segments) {
    const start = from > segment.from ? from : segment.from;
    const end = segment.through && segment.through < through ? segment.through : through;
    if (start > end) continue;
    for (const date of occurrenceDates(segment.spec, start, end)) {
      if (store.exceptions[occurrenceKey(rule.id, date)]) continue;
      const spec = segment.spec;
      const task = { id: `reminder-${rule.id}-${date}`, title: spec.title, status: 'active', tags: [], children: [], collapsed: false,
        kind: spec.kind || 'routine', color: spec.color || '#c5b985', pinned: Boolean(spec.pinned) };
      task.reminder = { ruleId: rule.id, date, schedule: describeReminder(spec), signature: JSON.stringify(spec), baseline: taskBaseline(task), edited: false };
      if (!result.has(date)) result.set(date, []);
      if (!result.get(date).some(item => item.id === task.id)) result.get(date).push(task);
    }
  }
  return result;
}
export function reconcileReminderDay(day, desired, store, today = getTodayDateKey()) {
  const pending = new Map(desired.map(task => [task.id, task]));
  const visit = (tasks) => tasks.flatMap(task => {
    const next = { ...task, children: visit(task.children || []) };
    if (!task.reminder) { pending.delete(task.id); return [next]; }
    const replacement = pending.get(task.id); pending.delete(task.id);
    const key = occurrenceKey(task.reminder.ruleId, day.date);
    if (task.status === 'deleted') { store.exceptions[key] ||= 'deleted'; return [next]; }
    if (replacement?.reminder.signature === task.reminder.signature) return [next];
    if (replacement && isPristineReminder(task)) return [{ ...replacement, collapsed: task.collapsed }];
    if (day.date <= today) return [next];
    if (isPristineReminder(task)) return [];
    store.exceptions[key] = 'detached';
    delete next.reminder;
    return [next];
  });
  const tasks = visit(day.tasks || []);
  tasks.push(...[...pending.values()].filter(task => !store.exceptions[occurrenceKey(task.reminder.ruleId, day.date)]));
  return { ...day, tasks };
}
export function updateReminderRule(store, { id, spec, startDate, action = 'save' }, today = getTodayDateKey()) {
  const next = normalizeReminderStore(store);
  const rule = next.rules.find(rule => rule.id === id);
  if (action === 'delete') {
    if (!rule) return next;
    if (!rule.archived) throw new Error('请先停用提醒，再彻底删除');
    next.rules = next.rules.filter(item => item.id !== id);
    for (const key of Object.keys(next.exceptions)) if (key.startsWith(`${id}|`)) delete next.exceptions[key];
    return next;
  }
  if (!rule) {
    validateReminderSpec(spec); dateNumber(startDate || today);
    if ((startDate || today) < today) throw new Error('新提醒的启用日期不能早于今天');
    next.rules.push({ id: id || `rule-${crypto.randomUUID()}`, createdDate: today, archived: false,
      segments: [{ from: startDate || today, through: null, spec: { ...spec, title: spec.title.trim() } }] });
    return next;
  }
  const old = rule.segments.at(-1);
  if (action === 'stop') {
    if (rule.archived) return next;
    if (old.from > today) rule.segments.pop(); else old.through = today;
    rule.archived = true; rule.lastSpec = old.spec;
  } else {
    const replacement = spec || rule.lastSpec || old?.spec;
    validateReminderSpec(replacement);
    let from = rule.archived ? startDate || addDays(today, 1) : addDays(today, 1);
    if (!rule.archived && old) {
      const { color: a, pinned: b, ...oldContent } = old.spec;
      const { color: c, pinned: d, ...newContent } = replacement;
      if (JSON.stringify(oldContent) === JSON.stringify(newContent)) from = today;
      if (old.from > from) from = old.from;
      if (old.from >= from) rule.segments.pop(); else old.through = addDays(from, -1);
    }
    if (from <= today && rule.archived) throw new Error('恢复提醒请从明天或以后开始');
    rule.segments.push({ from, through: null, spec: { ...replacement, title: replacement.title.trim() } }); rule.archived = false;
  }
  return next;
}

export function reminderIds(tasks) { return tasks.flatMap(task => [...(task.reminder ? [task.id] : []), ...reminderIds(task.children || [])]); }
export function mergeSavedReminderDay(incoming, current, base, store, today) {
  const flatten = tasks => tasks.flatMap(task => [task, ...flatten(task.children || [])]);
  const originals = new Map(flatten(current?.tasks || []).map(task => [task.id, task]));
  const submitted = new Set(flatten(incoming.tasks).map(task => task.id));
  for (const id of base) if (!submitted.has(id)) store.exceptions[occurrenceKey(id.slice('reminder-'.length, -11), incoming.date)] = 'deleted';
  const visit = tasks => tasks.flatMap(task => {
    const next = { ...task, children: visit(task.children || []) };
    if (!task.reminder) return [next];
    const key = occurrenceKey(task.reminder.ruleId, incoming.date), old = originals.get(task.id);
    if (task.status === 'deleted') { store.exceptions[key] = 'deleted'; return [next]; }
    if (store.exceptions[key] === 'deleted') delete store.exceptions[key];
    if (old && old.reminder?.signature !== task.reminder.signature) {
      if (isPristineReminder(task)) return [old];
      if (incoming.date > today) { delete next.reminder; store.exceptions[key] = 'detached'; }
    } else if (!old && base.includes(task.id) && incoming.date > today) {
      if (isPristineReminder(task)) return [];
      delete next.reminder; store.exceptions[key] = 'detached';
    }
    return [next];
  });
  const tasks = visit(incoming.tasks), ids = new Set(flatten(tasks).map(task => task.id));
  for (const task of current?.tasks || []) if (task.reminder && !base.includes(task.id) && !ids.has(task.id)) tasks.push(task);
  return { ...incoming, tasks };
}
