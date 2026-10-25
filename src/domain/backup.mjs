import { dateNumber, validateReminderSpec } from './reminders.mjs';

export const BACKUP_LIMIT = 100 * 1024 * 1024;
const metadata = new Map([
  ['long-tasks.json', 'desktop-calendar:long-tasks'],
  ['tag-templates.json', 'desktop-calendar:tag-templates'],
  ['reminders.json', 'desktop-calendar:reminders'],
]);
export function backupStorageKey(name) {
  if (metadata.has(name)) return metadata.get(name);
  const match = /^days\/(\d{4})\/(\d{2})\/(\d{4}-\d{2}-\d{2})\.json$/.exec(name);
  if (!match || !match[3].startsWith(`${match[1]}-${match[2]}-`)) throw new Error('备份包含不支持的文件路径');
  dateNumber(match[3]);
  return `desktop-calendar:day:${match[3]}`;
}
function countTasks(tasks, seen = new Set(), depth = 0) {
  if (!Array.isArray(tasks) || depth > 64) throw new Error('任务列表或层级不正确');
  return tasks.reduce((count, task) => {
    if (
      !task ||
      typeof task.id !== 'string' ||
      !task.id ||
      seen.has(task.id) ||
      typeof task.title !== 'string' ||
      !['active', 'completed', 'failed', 'deleted'].includes(task.status) ||
      (task.tags !== undefined && !Array.isArray(task.tags))
    )
      throw new Error('任务内容或编号不正确');
    seen.add(task.id);
    return count + 1 + countTasks(task.children || [], seen, depth + 1);
  }, 0);
}
export function validateBackup(backup) {
  if (
    backup?.format !== 'rizhi-backup' ||
    backup.version !== 1 ||
    !Array.isArray(backup.files) ||
    backup.files.length > 50000
  )
    throw new Error('这不是兼容的日枝备份');
  const summary = { files: backup.files.length, days: 0, tasks: 0, longTasks: 0, groups: 0, reminders: 0 };
  const names = new Set();
  for (const file of backup.files) {
    const key = backupStorageKey(file.name);
    if (names.has(key)) throw new Error('备份包含重复文件');
    names.add(key);
    const data = file.data;
    if (!data || typeof data !== 'object') throw new Error('备份文件内容不正确');
    if (file.name.startsWith('days/')) {
      if (
        data.date !== key.slice('desktop-calendar:day:'.length) ||
        (data.note !== undefined && typeof data.note !== 'string')
      )
        throw new Error('日记录日期或随笔不正确');
      summary.days++;
      summary.tasks += countTasks(data.tasks);
    } else if (file.name === 'long-tasks.json') summary.longTasks = countTasks(data.tasks);
    else if (file.name === 'tag-templates.json') {
      if (!Array.isArray(data.groups) || data.groups.some((group) => !Array.isArray(group?.tags)))
        throw new Error('长期标签分组不正确');
      summary.groups = data.groups.length;
    } else {
      if (
        !Array.isArray(data.rules) ||
        !data.exceptions ||
        typeof data.exceptions !== 'object' ||
        Array.isArray(data.exceptions)
      )
        throw new Error('提醒数据不正确');
      const ids = new Set();
      for (const rule of data.rules) {
        if (!rule.id || ids.has(rule.id)) throw new Error('提醒编号不正确');
        ids.add(rule.id);
        if (!Array.isArray(rule.segments)) throw new Error('提醒历史格式不正确');
        for (const segment of rule.segments) {
          dateNumber(segment.from);
          if (segment.through) dateNumber(segment.through);
          validateReminderSpec(segment.spec);
        }
        if (rule.lastSpec) validateReminderSpec(rule.lastSpec);
      }
      summary.reminders = data.rules.length;
    }
  }
  return summary;
}
export function createBrowserBackup(storage, preferences = {}) {
  const files = [];
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    let name = [...metadata].find(([, value]) => value === key)?.[0];
    if (key.startsWith('desktop-calendar:day:')) {
      const date = key.slice('desktop-calendar:day:'.length);
      name = `days/${date.slice(0, 4)}/${date.slice(5, 7)}/${date}.json`;
    }
    if (name) files.push({ name, data: JSON.parse(storage.getItem(key)) });
  }
  const backup = {
    format: 'rizhi-backup',
    version: 1,
    exportedAt: new Date().toISOString(),
    files,
    preferences,
  };
  validateBackup(backup);
  return backup;
}
export function restoreBrowserBackup(storage, backup) {
  validateBackup(backup);
  if (!backup.files.length) throw new Error('备份中没有可导入的数据');
  const before = createBrowserBackup(storage);
  const remove = () => {
    const keys = createBrowserBackup(storage).files.map((file) => backupStorageKey(file.name));
    keys.forEach((key) => storage.removeItem(key));
  };
  try {
    remove();
    backup.files.forEach((file) => storage.setItem(backupStorageKey(file.name), JSON.stringify(file.data)));
  } catch (error) {
    // Restore the complete snapshot if a browser quota/write fails midway.
    const known = new Set([...before.files, ...backup.files].map((file) => backupStorageKey(file.name)));
    known.forEach((key) => storage.removeItem(key));
    before.files.forEach((file) => storage.setItem(backupStorageKey(file.name), JSON.stringify(file.data)));
    throw error;
  }
  return before;
}
