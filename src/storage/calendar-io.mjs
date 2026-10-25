import { getTodayDateKey } from '../domain/date.mjs';
import { normalizeReminderStore, mergeSavedReminderDay } from '../domain/reminders.mjs';
const dayPrefix = 'desktop-calendar:day:';
const ruleKey = 'desktop-calendar:reminders';
const journalKey = 'desktop-calendar:reminder-transaction';
export const isNative = () => Boolean(window.__TAURI__?.core?.invoke);
let queue = Promise.resolve();
let clock = 0;
const stamp = () => `${Date.now()}-${++clock}`;
function locked(action) {
  if (navigator.locks?.request) return navigator.locks.request('desktop-calendar-data', action);
  const result = queue.then(action);
  queue = result.catch(() => {});
  return result;
}
function recover() {
  const journal = JSON.parse(localStorage.getItem(journalKey) || 'null');
  if (!journal) return;
  for (const day of journal.days) localStorage.setItem(dayPrefix + day.date, JSON.stringify(day));
  localStorage.setItem(ruleKey, JSON.stringify(journal.store));
  localStorage.removeItem(journalKey);
}
function transact(days, store) {
  localStorage.setItem(journalKey, JSON.stringify({ days, store }));
  recover();
}
const browserStore = () => normalizeReminderStore(JSON.parse(localStorage.getItem(ruleKey) || 'null'));
const browserDay = (date) => JSON.parse(localStorage.getItem(dayPrefix + date) || 'null');
export async function readDayRaw(date) {
  if (isNative()) return window.__TAURI__.core.invoke('load_day', { date });
  return locked(() => {
    recover();
    return browserDay(date);
  });
}
export async function readCalendarDays(from, through) {
  if (isNative()) return window.__TAURI__.core.invoke('read_calendar_days', { from, through });
  return locked(() => {
    recover();
    return Object.keys(localStorage)
      .filter((key) => key.startsWith(dayPrefix))
      .map((key) => key.slice(dayPrefix.length))
      .filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date) && date >= from && date <= through)
      .sort()
      .map(browserDay);
  });
}
export async function readReminderStore() {
  if (isNative()) {
    const raw = await window.__TAURI__.core.invoke('load_reminder_state');
    return { ...normalizeReminderStore(raw?.state || raw), storageIdentity: raw?.identity || null };
  }
  return locked(() => {
    recover();
    return browserStore();
  });
}
export async function saveDayRaw(day, baseReminderIds) {
  if (isNative())
    return window.__TAURI__.core.invoke('save_day', { day, baseReminderIds, today: getTodayDateKey() });
  return locked(() => {
    recover();
    const store = browserStore(),
      before = JSON.stringify(store);
    const saved = mergeSavedReminderDay(day, browserDay(day.date), baseReminderIds, store, getTodayDateKey());
    saved.updatedAt = stamp();
    if (JSON.stringify(store) !== before) {
      store.revision++;
      transact([saved], store);
    } else localStorage.setItem(dayPrefix + day.date, JSON.stringify(saved));
    return saved;
  });
}
export async function commitReminderPlan({ expectedRevision, identity, next, days, bases }) {
  if (isNative())
    return window.__TAURI__.core.invoke('commit_reminder_plan', {
      expectedRevision,
      identity,
      next,
      days,
      bases,
    });
  return locked(() => {
    recover();
    const old = browserStore();
    if (
      old.revision !== expectedRevision ||
      days.some((day) => (browserDay(day.date)?.updatedAt || null) !== bases[day.date])
    )
      throw new Error('REMINDERS_CONFLICT');
    const changed = days
      .filter((day) => {
        const before = browserDay(day.date);
        return before
          ? JSON.stringify(before.tasks) !== JSON.stringify(day.tasks) || before.note !== day.note
          : day.tasks.length || day.note;
      })
      .map((day) => ({ ...day, updatedAt: stamp() }));
    if (!changed.length && JSON.stringify(next) === JSON.stringify(old))
      return { store: old, changedDates: [] };
    next.revision = expectedRevision + 1;
    transact(changed, next);
    return { store: next, changedDates: changed.map((day) => day.date) };
  });
}
