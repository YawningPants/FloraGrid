import {
  BACKUP_LIMIT,
  createBrowserBackup,
  restoreBrowserBackup,
  validateBackup,
} from '../domain/backup.mjs';
import { loadThemeSettings } from '../domain/theme.mjs';
import { flushReminderWork } from './reminder-service.mjs';

export const nativeDataTransfer = () => Boolean(window.__TAURI__?.core?.invoke);
const invoke = (name, args) => window.__TAURI__.core.invoke(name, args);
export const inspectStorageTarget = (path) => invoke('inspect_storage_target', { path });
export async function chooseBackup(save) {
  if (nativeDataTransfer()) {
    const path = await invoke('pick_backup_path', { save });
    return path
      ? { path, ...(!save ? { summary: await invoke('preview_backup_file', { path }) } : {}) }
      : null;
  }
  if (save) return { path: `日枝备份-${new Date().toISOString().slice(0, 10)}.json` };
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.addEventListener(
      'cancel',
      () => {
        input.remove();
        resolve(null);
      },
      { once: true },
    );
    input.addEventListener(
      'change',
      async () => {
        try {
          const file = input.files[0];
          if (!file) {
            resolve(null);
            return;
          }
          if (file.size > BACKUP_LIMIT) throw new Error('备份超过 100 MiB，暂不支持');
          const backup = JSON.parse(await file.text());
          resolve({ path: file.name, backup, summary: validateBackup(backup) });
        } catch (error) {
          reject(error);
        } finally {
          input.remove();
        }
      },
      { once: true },
    );
    input.hidden = true;
    document.body.append(input);
    input.click();
  });
}
function download(backup, name) {
  const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
  if (blob.size > BACKUP_LIMIT) throw new Error('备份超过 100 MiB，暂不支持');
  const url = URL.createObjectURL(blob),
    link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export async function transferData(request, onProgress = () => {}) {
  const id = crypto.randomUUID();
  const preferences = { theme: loadThemeSettings() };
  window.calendarDataTransferBusy = true;
  let unlisten;
  try {
    await flushReminderWork();
    if (nativeDataTransfer()) {
      const label = window.__TAURI__.window?.getCurrentWindow?.().label;
      unlisten = await window.__TAURI__.event.listen(
        'calendar://data-transfer-progress',
        ({ payload }) => {
          if (payload.id === id) onProgress(payload);
        },
        label ? { target: label } : undefined,
      );
      return await invoke('perform_data_transfer', { request: { ...request, id, preferences } });
    }
    onProgress({ progress: 0.1, label: '检查数据' });
    const action = () => {
      if (request.kind === 'export') {
        const backup = createBrowserBackup(localStorage, preferences);
        download(backup, request.path);
        return { path: request.path, files: backup.files.length };
      }
      if (request.kind === 'import') {
        const before = createBrowserBackup(localStorage, preferences);
        // Browser preview also provides a downloadable safety copy before replacement.
        if (before.files.length) download(before, `日枝导入前备份-${Date.now()}.json`);
        restoreBrowserBackup(localStorage, request.backup);
        return { files: request.backup.files.length, preferences: request.backup.preferences };
      }
      throw new Error('更换存储文件夹请使用桌面版日枝');
    };
    const result = navigator.locks?.request
      ? await navigator.locks.request('desktop-calendar-data', action)
      : action();
    onProgress({ progress: 1, label: '操作完成' });
    return result;
  } finally {
    unlisten?.();
    window.calendarDataTransferBusy = false;
  }
}
