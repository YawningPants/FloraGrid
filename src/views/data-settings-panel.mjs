import { el, escapeHtml } from '../ui/dom.mjs';
import { loadStorageLocation, pickDataDirectory } from '../storage/storage-location.mjs';
import {
  chooseBackup,
  inspectStorageTarget,
  nativeDataTransfer,
  transferData,
} from '../storage/data-transfer.mjs';

export function createDataSettingsPanel({
  canProceed = () => true,
  onBusy = () => {},
  onTheme = () => {},
  onLocation = () => {},
} = {}) {
  const element = el('div', 'data-settings');
  let busy = false,
    location = null;
  element.innerHTML = `
    <div class="settings-section-title">存储文件夹</div>
    <p class="storage-description">日程、随笔、长期任务、标签和提醒，都保存在本机。</p>
    <div class="storage-path-card"><span class="storage-path-label">当前存储位置</span><code class="storage-path-value">正在读取…</code></div>
    <div class="storage-actions"><button class="dialog-button choose-storage" type="button">更换文件夹</button><button class="dialog-button reset-storage" type="button">恢复默认位置</button></div>
    <section class="backup-settings"><div class="settings-section-title">导入与导出</div>
      <p class="storage-description">将全部数据和外观设置打包为一个备份文件，便于备份或换电脑。</p>
      <div class="storage-actions"><button class="dialog-button primary export-data" type="button">导出备份</button><button class="dialog-button import-data" type="button">导入备份</button></div>
      <p class="storage-description data-restore-hint">导入会替换当前日枝数据。恢复前会自动保存一份原数据备份。</p>
    </section>
    <div class="data-operation-status" role="status" aria-live="polite" hidden><span></span><progress max="1" value="0" hidden></progress><small></small></div>`;
  const status = element.querySelector('.data-operation-status');
  function message(text, error = false, detail = '') {
    status.hidden = false;
    status.classList.toggle('is-error', error);
    status.querySelector('span').textContent = text;
    status.querySelector('small').textContent = detail;
  }
  function setBusy(value) {
    busy = value;
    element.querySelectorAll('button').forEach((button) => {
      button.disabled = value;
    });
    onBusy(value);
  }
  async function refresh() {
    location = await loadStorageLocation();
    element.querySelector('.storage-path-label').textContent = location.isDefault ? '默认位置' : '自定义位置';
    element.querySelector('.storage-path-value').textContent = location.effectivePath;
  }
  async function run(request) {
    setBusy(true);
    message('正在等待各窗口保存…');
    const progress = status.querySelector('progress');
    progress.hidden = false;
    progress.value = 0;
    const modalProgress = document.querySelector('.data-dialog-overlay .data-dialog-progress');
    if (modalProgress) {
      modalProgress.hidden = false;
      modalProgress.querySelector('span').textContent = '正在等待各窗口保存…';
      modalProgress.querySelector('progress').value = 0;
      modalProgress.querySelector('small').textContent = '';
      document.querySelector('.data-dialog-error').hidden = true;
      modalProgress.scrollIntoView({ block: 'nearest' });
    }
    try {
      const result = await transferData(request, (payload) => {
        message(`${payload.label} · ${Math.round(payload.progress * 100)}%`, false, payload.file || '');
        progress.value = payload.progress;
        if (modalProgress) {
          modalProgress.querySelector('span').textContent =
            `${payload.label} · ${Math.round(payload.progress * 100)}%`;
          modalProgress.querySelector('progress').value = payload.progress;
          modalProgress.querySelector('small').textContent = payload.file || '';
        }
      });
      progress.value = 1;
      return { ok: true, result };
    } catch (error) {
      const text = `操作未完成：${error.message || error}`;
      message(text, true);
      const field = document.querySelector('.data-dialog-overlay .data-dialog-error');
      if (field) {
        field.hidden = false;
        field.textContent = text;
      }
      return { ok: false };
    } finally {
      setBusy(false);
      progress.hidden = true;
      if (modalProgress) modalProgress.hidden = true;
    }
  }
  // Dialogs keep the destructive choice explicit and leave Cancel focused by default.
  function dialog({ title, body, confirm, onConfirm, danger = false, cancel = '取消' }) {
    const previous = document.activeElement;
    const overlay = el('div', 'dialog-overlay confirm-overlay data-dialog-overlay');
    overlay.innerHTML = `<section class="confirm-dialog data-confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="data-dialog-title"><h2 id="data-dialog-title">${escapeHtml(title)}</h2>${body}<div class="data-dialog-progress" role="status" aria-live="polite" hidden><span></span><progress max="1" value="0"></progress><small></small></div><p class="data-dialog-error" role="alert" hidden></p><div class="dialog-actions"><button type="button" class="dialog-button cancel">${escapeHtml(cancel)}</button><button type="button" class="dialog-button confirm-action ${danger ? 'danger' : 'primary'}">${escapeHtml(confirm)}</button></div></section>`;
    let working = false;
    const close = () => {
      if (working) return;
      overlay.remove();
      previous?.focus?.({ preventScroll: true });
    };
    overlay.querySelector('.cancel').onclick = close;
    overlay.onclick = (event) => {
      if (event.target === overlay) close();
    };
    overlay.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        close();
      }
      if (event.key === 'Tab') {
        const nodes = [...overlay.querySelectorAll('button:not(:disabled),input:not(:disabled)')];
        if (event.shiftKey && document.activeElement === nodes[0]) {
          event.preventDefault();
          nodes.at(-1).focus();
        } else if (!event.shiftKey && document.activeElement === nodes.at(-1)) {
          event.preventDefault();
          nodes[0].focus();
        }
      }
    });
    overlay.querySelector('.confirm-action').onclick = async () => {
      working = true;
      const disabledBefore = new Map(
        [...overlay.querySelectorAll('button,input')].map((node) => [node, node.disabled]),
      );
      disabledBefore.forEach((_, node) => {
        node.disabled = true;
      });
      try {
        const done = await onConfirm(overlay);
        working = false;
        if (done !== false) close();
      } catch (error) {
        const field = overlay.querySelector('.data-dialog-error');
        field.hidden = false;
        field.textContent = String(error.message || error);
        working = false;
      } finally {
        if (overlay.isConnected)
          disabledBefore.forEach((disabled, node) => {
            node.disabled = disabled;
          });
      }
    };
    document.body.append(overlay);
    overlay.querySelector('.cancel').focus({ preventScroll: true });
    return overlay;
  }
  async function offerCleanup(result) {
    if (!result.cleanupToken) return;
    dialog({
      title: '迁移完成，保留原数据吗？',
      body: `<p>新文件夹已开始使用，原数据仍然保留。</p><code class="storage-path-value">${escapeHtml(result.sourcePath)}</code><p>清理只删除本次迁移并核验一致的日枝文件；其他文件和文件夹会保留。</p>`,
      cancel: '保留原数据',
      confirm: '清理原数据…',
      danger: true,
      onConfirm: () => {
        // A second explicit choice prevents an accidental click after a successful move.
        setTimeout(
          () =>
            dialog({
              title: '确认清理原数据？',
              body: `<p>将清理以下位置中已迁移的日枝文件：</p><code class="storage-path-value">${escapeHtml(result.sourcePath)}</code><p>如果任一原文件或对应的新文件发生变化，将保留原数据。</p>`,
              confirm: '确认清理',
              danger: true,
              onConfirm: async () => {
                const outcome = await run({ kind: 'cleanup', token: result.cleanupToken });
                if (!outcome.ok) return false;
                message(`已清理 ${outcome.result.deleted} 个原数据文件。`);
                return true;
              },
            }),
          0,
        );
      },
    });
  }
  async function changeFolder(useDefault = false) {
    if (busy || !canProceed()) return;
    if (!nativeDataTransfer()) {
      message('更换存储文件夹请使用桌面版日枝。');
      return;
    }
    try {
      const path = useDefault ? null : await pickDataDirectory();
      if (!useDefault && !path) return;
      const info = await inspectStorageTarget(path);
      if (info.sameRoot) {
        message('当前已经使用这个文件夹。');
        return;
      }
      dialog({
        title: useDefault ? '恢复默认存储位置' : '更换存储文件夹',
        body: `
        <code class="storage-path-value">${escapeHtml(info.path)}</code>
        ${info.empty ? '<p>目标文件夹为空。</p>' : `<p class="storage-warning">此文件夹不为空，包含 ${info.files} 个日枝数据文件。请确认选中了正确的位置。</p>`}
        <label class="data-option"><input class="migrate-data" type="checkbox" ${info.related ? '' : 'checked'}/>将当前数据一并迁移</label>
        <p class="data-migration-hint">${info.related ? '两个文件夹互相包含，不能迁移。可仅切换位置，原数据保留。' : '迁移后原数据保留。同一天的记录、长期任务库、标签和提醒规则如有冲突，以当前数据为准，覆盖前自动备份；目标中其他日期和无关文件保留。'}</p>
        <p class="data-switch-hint" hidden>仅切换后，日枝会显示目标文件夹中的数据；当前数据仍保留在原位置。</p>`,
        confirm: '确认切换',
        onConfirm: async (overlay) => {
          const migrate = overlay.querySelector('.migrate-data').checked;
          if (migrate && info.related) throw new Error('原位置与目标位置不能互相包含，请选择独立文件夹');
          const outcome = await run({
            kind: migrate ? 'move' : 'switch',
            path: info.path,
            useDefault,
            migrate,
            targetStamp: info.stamp,
          });
          if (!outcome.ok) return false;
          await refresh();
          onLocation(outcome.result.location);
          message(
            migrate ? '数据已迁移，存储位置已切换。' : '存储位置已切换，原数据已保留。',
            false,
            outcome.result.backupPath ? `覆盖前备份：${outcome.result.backupPath}` : '',
          );
          setTimeout(() => offerCleanup(outcome.result), 0);
          return true;
        },
      });
      const overlay = document.querySelector('.data-dialog-overlay');
      const input = overlay.querySelector('.migrate-data');
      if (info.related) input.disabled = true;
      const hints = () => {
        overlay.querySelector('.data-migration-hint').hidden = !input.checked;
        overlay.querySelector('.data-switch-hint').hidden = input.checked;
      };
      input.onchange = hints;
      hints();
    } catch (error) {
      message(String(error.message || error), true);
    }
  }
  element.querySelector('.choose-storage').onclick = () => changeFolder(false);
  element.querySelector('.reset-storage').onclick = () => changeFolder(true);
  element.querySelector('.export-data').onclick = async () => {
    if (busy || !canProceed()) return;
    try {
      const selected = await chooseBackup(true);
      if (!selected) return;
      const outcome = await run({ kind: 'export', path: selected.path });
      if (outcome.ok) message('备份已导出。', false, outcome.result.path);
    } catch (error) {
      message(String(error.message || error), true);
    }
  };
  element.querySelector('.import-data').onclick = async () => {
    if (busy || !canProceed()) return;
    try {
      const selected = await chooseBackup(false);
      if (!selected) return;
      const summary = selected.summary;
      if (!summary.files) throw new Error('备份中没有可导入的数据');
      dialog({
        title: '从备份恢复',
        body: `<code class="storage-path-value">${escapeHtml(selected.path)}</code><div class="backup-summary"><span>${summary.days} 天日程</span><span>${summary.tasks} 个任务</span><span>${summary.longTasks} 个长期任务</span><span>${summary.groups} 个标签分组</span><span>${summary.reminders} 条提醒</span></div><p class="storage-warning">当前日枝数据将被这份备份替换，包括随笔、长期标签和提醒。恢复前会保存当前数据的安全副本。</p><label class="data-option"><input type="checkbox" class="restore-theme" checked/>同时恢复备份中的外观设置</label>`,
        confirm: '确认恢复',
        onConfirm: async (overlay) => {
          const restoreTheme = overlay.querySelector('.restore-theme').checked;
          const outcome = await run({
            kind: 'import',
            path: selected.path,
            backup: selected.backup,
            fingerprint: summary.fingerprint,
          });
          if (!outcome.ok) return false;
          if (restoreTheme && outcome.result.preferences?.theme) onTheme(outcome.result.preferences.theme);
          onLocation(location);
          message(
            '备份已恢复。',
            false,
            outcome.result.backupPath ? `导入前备份：${outcome.result.backupPath}` : '',
          );
          return true;
        },
      });
    } catch (error) {
      message(String(error.message || error), true);
    }
  };
  refresh().catch((error) => message(`读取存储位置失败：${error}`, true));
  return { element, refresh, isBusy: () => busy };
}
