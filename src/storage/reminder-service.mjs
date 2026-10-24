import { getTodayDateKey } from '../domain/date.mjs';
import { addDays, dateNumber, daysBetween, generateReminderTasks, normalizeReminderStore, reconcileReminderDay, updateReminderRule } from '../domain/reminders.mjs';
import { readCalendarDays, readReminderStore, commitReminderPlan } from './calendar-io.mjs';
export { readReminderStore } from './calendar-io.mjs';
let queue = Promise.resolve();
function serialize(action) { const result = queue.then(action); queue = result.catch(() => {}); return result; }
async function publish(result) {
  if (!result.changedDates.length && !result.changedRules) return;
  const emit = async (name, payload) => {
    window.dispatchEvent(new CustomEvent(name, { detail: payload }));
    if (window.__TAURI__?.event?.emit) await window.__TAURI__.event.emit(name, payload).catch(console.error);
  };
  for (const date of result.changedDates) await emit('calendar://day-updated', { date, originId: 'reminder-engine' });
  if (result.changedRules) await emit('calendar://reminders-updated', {});
}
async function sync(from, through, mutate = null) {
  dateNumber(from); dateNumber(through);
  const today = getTodayDateKey();
  for (let attempt = 0; attempt < 8; attempt++) {
    const original = await readReminderStore();
    if (!mutate && !original.rules.length) return original;
    const next = mutate ? mutate(original) : normalizeReminderStore(original);
    const catchupFrom = original.sealedThrough ? addDays(original.sealedThrough, 1) : today;
    const targets = generateReminderTasks(next, from, through);
    if (catchupFrom <= today) for (const [date, tasks] of generateReminderTasks(next, catchupFrom, today)) targets.set(date, tasks);
    const all = await readCalendarDays(mutate ? '0001-01-01' : (catchupFrom < from ? catchupFrom : from), mutate ? '9999-12-31' : (through > today ? through : today));
    const existing = new Map(all.map(day => [day.date, day]));
    // Edits must also reconcile previously visited future dates, without expanding
    // every intervening year into stored tasks.
    if (mutate) for (const day of all) if (day.date > today && day.tasks.some(task => JSON.stringify(task).includes('"reminder"'))) targets.set(day.date, generateReminderTasks(next, day.date, day.date).get(day.date) || []);
    const dates = new Set([...targets.keys(), ...all.filter(day => day.date >= from && day.date <= through).map(day => day.date)]);
    const bases = {}, days = [];
    for (const date of dates) {
      const day = existing.get(date) || { date, note: '', tasks: [] };
      bases[date] = day.updatedAt || null;
      days.push(reconcileReminderDay(day, targets.get(date) || [], next, today));
    }
    if (!next.sealedThrough || next.sealedThrough < today) next.sealedThrough = today;
    try {
      const result = await commitReminderPlan({ expectedRevision: original.revision, identity: original.storageIdentity, next, days, bases });
      result.changedRules = JSON.stringify(original.rules) !== JSON.stringify(next.rules);
      await publish(result); return result.store;
    } catch (error) {
      if (!String(error).includes('REMINDERS_CONFLICT') || attempt === 7) throw error;
    }
  }
}
export function ensureReminders(from = getTodayDateKey(), through = from) { return serialize(() => sync(from, through)); }
export function saveReminder(change) {
  return serialize(async () => {
    const today = getTodayDateKey();
    if (change.storageIdentity && change.storageIdentity !== (await readReminderStore()).storageIdentity) throw new Error('数据目录已更改，请返回后重新打开提醒');
    await sync(today, today); // Seal due history using the old rule before editing.
    return sync(today, today, store => {
      if (change.storageIdentity && change.storageIdentity !== store.storageIdentity) throw new Error('数据目录已更改，请返回后重新打开提醒');
      if (change.id && change.action !== 'delete' && !store.rules.some(rule => rule.id === change.id)) throw new Error('这条提醒已被删除，请返回列表');
      return updateReminderRule(store, change, today);
    });
  });
}
export function bindReminderRefresh(handler) {
  window.addEventListener('calendar://reminders-updated', handler);
  if (window.__TAURI__?.event?.listen) window.__TAURI__.event.listen('calendar://reminders-updated', handler).catch(console.error);
  window.addEventListener('storage', event => { if (event.key === 'desktop-calendar:reminders') handler(); });
}
export function startReminderClock() {
  let today = '';
  const check = () => {
    const date = getTodayDateKey(); if (today === date) return;
    ensureReminders(date).then(() => { today = date; }).catch(console.error);
  };
  check(); const timer = setInterval(check, 30000);
  window.addEventListener('focus', check);
  window.addEventListener('beforeunload', () => clearInterval(timer), { once: true });
}
