import { markCustomizedReminders, reminderIds } from '../domain/reminders.mjs';
import { readDayRaw, saveDayRaw } from './calendar-io.mjs';
const baseIds = new Map();
const SAVE_DEBOUNCE_MS = 900;
const dayStorageOriginId = crypto.randomUUID();

let saveTimer = null;
let pendingSave = null;
let saveInFlight = null;

export async function loadDay(date) {
  const day = await readDayRaw(date);
  baseIds.set(date, reminderIds(day?.tasks || []));
  return day;
}

export function scheduleSaveDay(day) {
  pendingSave = structuredClone(day);
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    flushDaySave().catch(console.error);
  }, SAVE_DEBOUNCE_MS);
}

export async function flushDaySave() {
  window.clearTimeout(saveTimer);
  saveTimer = null;

  if (saveInFlight) {
    await saveInFlight;
    return flushDaySave();
  }

  if (!pendingSave) {
    return;
  }

  const day = pendingSave;
  pendingSave = null;
  saveInFlight = saveDay(day);
  try { await saveInFlight; }
  catch (error) {
    if (!pendingSave) pendingSave = day;
    window.dispatchEvent(new CustomEvent('calendar://save-error', { detail: { date: day.date } }));
    throw error;
  }
  finally { saveInFlight = null; }
  if (pendingSave) await flushDaySave();
}

export async function saveDayNow(day) {
  await saveDay(structuredClone(day));
}

export function getDayStorageOriginId() {
  return dayStorageOriginId;
}

async function saveDay(day) {
  const prepared = { ...day, tasks: markCustomizedReminders(day.tasks || []) };
  const saved = await saveDayRaw(prepared, baseIds.get(day.date) || []);
  baseIds.set(day.date, reminderIds(saved?.tasks || day.tasks || []));
  notifyDayUpdated(day);
}

function notifyDayUpdated(day) {
  const payload = { date: day.date, originId: dayStorageOriginId };
  window.dispatchEvent(new CustomEvent('calendar://day-updated', { detail: payload }));

  if (!window.__TAURI__?.event?.emit) {
    return;
  }

  window.__TAURI__.event.emit('calendar://day-updated', payload).catch((error) => {
    console.error(error);
  });
}
