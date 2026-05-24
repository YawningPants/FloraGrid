const SAVE_DEBOUNCE_MS = 900;

let saveTimer = null;
let pendingSave = null;

export async function loadDay(date) {
  if (!isTauriRuntime()) {
    return loadDayFromBrowser(date);
  }

  return window.__TAURI__.core.invoke('load_day', { date });
}

export function scheduleSaveDay(day) {
  pendingSave = structuredClone(day);
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    flushDaySave();
  }, SAVE_DEBOUNCE_MS);
}

export async function flushDaySave() {
  window.clearTimeout(saveTimer);
  saveTimer = null;

  if (!pendingSave) {
    return;
  }

  const day = pendingSave;
  pendingSave = null;
  await saveDay(day);
}

async function saveDay(day) {
  if (!isTauriRuntime()) {
    saveDayToBrowser(day);
    return;
  }

  await window.__TAURI__.core.invoke('save_day', { day });
}

function isTauriRuntime() {
  return Boolean(window.__TAURI__?.core?.invoke);
}

function loadDayFromBrowser(date) {
  const raw = window.localStorage.getItem(getBrowserStorageKey(date));
  return raw ? JSON.parse(raw) : null;
}

function saveDayToBrowser(day) {
  window.localStorage.setItem(getBrowserStorageKey(day.date), JSON.stringify(day));
}

function getBrowserStorageKey(date) {
  return `desktop-calendar:day:${date}`;
}
