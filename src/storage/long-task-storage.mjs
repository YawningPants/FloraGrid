import { normalizeTaskTags } from '../domain/tags.mjs';
import { normalizeTaskTree } from '../domain/tasks.mjs';

const browserStorageKey = 'desktop-calendar:long-tasks';

export async function loadLongTasks(fallbackPalette = {}) {
  const data = await loadLongTasksData();
  return normalizeLongTasks(data, fallbackPalette);
}

export async function saveLongTasks(tasks) {
  const data = {
    version: 1,
    tasks: normalizeTaskTree(tasks).map(normalizeLongTask),
  };

  if (!isTauriRuntime()) {
    window.localStorage.setItem(browserStorageKey, JSON.stringify(data));
    return data.tasks;
  }

  await window.__TAURI__.core.invoke('save_long_tasks', { tasks: data });
  return data.tasks;
}

async function loadLongTasksData() {
  if (!isTauriRuntime()) {
    const raw = window.localStorage.getItem(browserStorageKey);
    return raw ? JSON.parse(raw) : null;
  }

  return window.__TAURI__.core.invoke('load_long_tasks');
}

function normalizeLongTasks(data, fallbackPalette) {
  const tasks = Array.isArray(data?.tasks) ? structuredClone(data.tasks) : [];
  normalizeTaskTags(tasks, fallbackPalette);
  return normalizeTaskTree(tasks).map(normalizeLongTask);
}

function normalizeLongTask(task) {
  return {
    ...task,
    status: task.status === 'deleted' ? 'deleted' : 'active',
    children: [],
  };
}

function isTauriRuntime() {
  return Boolean(window.__TAURI__?.core?.invoke);
}
