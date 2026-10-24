import {
  getMonthDisplayMeta,
  getMonthGridDates,
  getMonthKeyFromDateKey,
  getTodayDateKey,
  shiftMonthKey,
} from '../domain/date.mjs';
import {
  applyThemeSettings,
  defaultTheme,
  loadThemeSettings,
  saveThemeSettings,
  getThemePresets,
} from '../domain/theme.mjs';
import {
  canMoveTask,
  createBlankTask,
  getRenderableTasks,
  normalizeTaskTree,
  taskStatusMeta,
} from '../domain/tasks.mjs';
import {
  cloneTemplateAsSnapshot,
  createTagSnapshot,
  getTagColor as getSnapshotTagColor,
  getTagText,
  normalizeTagTemplates,
  tagColors,
} from '../domain/tags.mjs';
import {
  canPasteToDate,
  copyTask,
  createPastedTaskFromClipboard,
} from '../domain/task-clipboard.mjs';
import { loadDay, saveDayNow } from '../storage/day-storage.mjs';
import {
  loadStorageLocation,
  pickDataDirectory,
  resetStorageLocation,
  setStorageLocation,
} from '../storage/storage-location.mjs';
import { loadLongTasks, saveLongTasks } from '../storage/long-task-storage.mjs';
import { loadTagTemplates } from '../storage/tag-template-storage.mjs';
import { el, escapeHtml, truncateText } from '../ui/dom.mjs';
import { icon } from '../ui/icons.mjs';
import { completionMarkup, createBotanicalEmpty, sproutMarkup } from '../ui/botanical.mjs';
import { createWindowTitleBar } from '../ui/window-titlebar.mjs';
import { openSettingsWindow as openSharedSettingsWindow } from '../ui/settings-window.mjs';
import { createTaskDragController } from '../ui/task-drag-controller.mjs';
import { createMonthSearch } from './month-search.mjs';
import { createReminderCenter } from './reminder-center.mjs';
import { ensureReminders, bindReminderRefresh } from '../storage/reminder-service.mjs';
import { openDay, bindCalendarNavigation } from '../ui/calendar-navigation.mjs';
import { lunarDate } from '../domain/reminders.mjs';

const WEEKDAY_LABELS = ['一', '二', '三', '四', '五', '六', '日'];
const MAX_TASKS_PER_DAY = 8;
let monthTaskResizeObserver = null;
let activePanel = null;
let searchMode = false;
let monthSearch = null;
let reminderCenter = null;
let currentMonthKey = getMonthKeyFromDateKey(getTodayDateKey());
let monthDays = new Map();
let isMonthLoading = true;
let loadErrorMessage = '';
let showLunarDates = false;
let isAlwaysOnTop = false;
let isDayUpdateHandlerBound = false;
let isThemeUpdateHandlerBound = false;
let isStorageUpdateHandlerBound = false;
let isTagTemplateUpdateHandlerBound = false;
let editingMonth = false;
let monthInputValue = '';
let themeSettings = applyThemeSettings(loadThemeSettings());
let storageLocation = null;
let monthContextMenu = null;
let longTasks = [];
let tagTemplates = normalizeTagTemplates(null);
let isLongTasksLoading = true;
let editingLongTaskId = null;
let draftLongTaskId = null;
let longTaskEditOriginal = '';
let longTaskSaving = false;
let longTaskEditError = '';
let activeLongTaskTagPopoverId = null;
let activeLongTaskTagGroupId = null;
let activeLongTaskTagGroupPage = 0;
let temporaryLongTaskTagText = '';
let temporaryLongTaskTagColor = tagColors[0];
let showDeletedLongTasks = false;
let longTaskDragController = null;
let isLongTaskTagPopoverHandlerBound = false;

export function createMonthView(options = {}) {
  if (!window.__TAURI__?.core?.invoke) window.name = 'month-view';
  applyThemeSettings(themeSettings);
  currentMonthKey = options.month || currentMonthKey;
  const root = el('section', 'month-window');
  monthTaskResizeObserver?.disconnect();
  monthTaskResizeObserver = new ResizeObserver(entries => entries.forEach(({ target }) => fitMonthTaskList(target)));
  monthSearch = createMonthSearch({
    onClose: () => { searchMode = false; renderMonthView(root); },
    onLocate: async date => {
      closeMonthPanel(root); searchMode = false; currentMonthKey = getMonthKeyFromDateKey(date);
      renderMonthView(root); await loadMonth(root);
      const cell = [...root.querySelectorAll('.month-day-cell')].find(cell => cell.dataset.date === date);
      cell?.classList.add('is-search-located'); setTimeout(() => cell?.classList.remove('is-search-located'), 2600);
    },
    onOpen: result => {
      if (result.type === 'long') {
        closeMonthPanel(root); searchMode = false;
        activePanel = 'long'; renderMonthView(root);
        const item = [...root.querySelectorAll('.long-task-item')].find(item => item.dataset.taskId === result.taskId);
        item?.scrollIntoView({ block: 'center' }); item?.classList.add('is-search-located');
        setTimeout(() => item?.classList.remove('is-search-located'), 2600);
      } else openDay(result.date, { taskId: result.taskId, note: result.type === 'note', includeDeleted: result.status === 'deleted' }).catch(console.error);
    },
  });
  reminderCenter = createReminderCenter({ onChanged: () => loadMonth(root), onOpenDay: date => openDayWindow(date) });
  root.append(createTitleBar(), createMonthHeader(root), createMonthLayout(root));
  longTaskDragController = createTaskDragController({
    root,
    flat: true,
    getItems: () => longTasks,
    getOptions: () => ({ showDeletedTasks: showDeletedLongTasks }),
    getList: () => root.querySelector('.long-task-list'),
    getTree: () => root.querySelector('.long-task-list'),
    rowSelector: '.long-task-item',
    canStart: () => activePanel === 'long' && !editingLongTaskId && !isLongTasksLoading,
    createPreview: (task) => createLongTaskItem(task),
    onPrepare: () => {
      closeMonthContextMenu();
      closeLongTaskTagPopover();
    },
    onCommit: (items) => {
      longTasks = items;
      persistLongTasksSoon();
      renderMonthView(root);
    },
  });
  root.addEventListener('contextmenu', (event) => {
    event.preventDefault();
  });
  document.addEventListener('pointerdown', event => {
    if (!root.isConnected || !activePanel || !(event.target instanceof Element)) return;
    if (event.target.closest('.month-tools-drawer, .month-long-toggle, .month-reminder-toggle, .tag-popover-layer, .task-context-menu, .dialog-overlay, .task-color-palette')) return;
    // Keep the clicked calendar/header node alive so its click still runs after closing.
    closeMonthPanel(root);
  }, true);
  bindDayUpdateHandler(root);
  bindThemeUpdateHandler(root);
  bindStorageUpdateHandler(root);
  bindTagTemplateUpdateHandler(root);
  bindLongTaskTagPopoverHandlers();
  bindReminderRefresh(() => { reminderCenter.refresh(); loadMonth(root); if (searchMode) monthSearch.refresh(); });
  bindCalendarNavigation(target => {
    if (!['long', 'reminders'].includes(target.panel)) return;
    closeMonthPanel(root);
    activePanel = target.panel; renderMonthView(root);
    if (target.ruleId) reminderCenter.focusRule(target.ruleId);
  });
  loadMonth(root);
  loadLongTaskPanel(root);
  return root;
}

function createTitleBar() {
  return createWindowTitleBar({
    title: '月视图',
    className: 'month-titlebar',
    pin: {
      active: isAlwaysOnTop,
      label: isAlwaysOnTop ? '取消置顶' : '置顶窗口',
      onToggle: async (button) => {
        const nextState = !isAlwaysOnTop;
        try {
          await window.calendarShell?.setAlwaysOnTop?.(nextState);
          isAlwaysOnTop = nextState;
          button.classList.toggle('is-active', isAlwaysOnTop);
          button.setAttribute('aria-pressed', String(isAlwaysOnTop));
          button.title = isAlwaysOnTop ? '取消置顶' : '置顶窗口';
          button.setAttribute('aria-label', button.title);
        } catch (error) {
          console.error(error);
        }
      },
    },
    onMinimize: () => window.calendarShell?.minimize?.(),
    onClose: () => window.calendarShell?.close?.(),
  });
}

function createMonthHeader(root) {
  const header = el('section', 'month-header');
  const monthMeta = getMonthDisplayMeta(currentMonthKey);
  const isCurrentMonth = currentMonthKey === getMonthKeyFromDateKey(getTodayDateKey());
  const monthControlMarkup = editingMonth
    ? `<input class="month-title-input" type="text" value="${escapeHtml(monthInputValue || monthMeta.subtitle)}" aria-label="输入年月" />`
    : `<button class="month-title-button" type="button" title="输入年月跳转" aria-label="输入年月跳转">${escapeHtml(monthMeta.title)}</button>`;
  header.innerHTML = `
    <div class="month-heading">
      <div class="month-switcher" aria-label="月份切换">
        <button class="month-nav-button previous-month" type="button" title="上个月" aria-label="上个月">‹</button>
        ${monthControlMarkup}
        <button class="month-nav-button next-month" type="button" title="下个月" aria-label="下个月">›</button>
        ${isCurrentMonth ? '' : `<button class="current-date-button month-current-button" type="button" title="回到当前月" aria-label="回到当前月">${icon('restore')}</button>`}
      </div>
      <div class="month-header-actions" aria-label="月视图操作">
        <button class="header-tool month-long-toggle${activePanel === 'long' ? ' is-active' : ''}" type="button" aria-label="长期任务" aria-pressed="${activePanel === 'long'}">${icon('task-list')}<span class="header-tool-label" aria-hidden="true">长期任务</span></button>
        <button class="header-tool month-reminder-toggle${activePanel === 'reminders' ? ' is-active' : ''}" type="button" aria-label="提醒" aria-pressed="${activePanel === 'reminders'}">${icon('bell')}<span class="header-tool-label" aria-hidden="true">提醒</span></button>
        <button class="header-tool month-search-toggle${searchMode ? ' is-active' : ''}" type="button" aria-label="全局搜索" aria-pressed="${searchMode}">${icon('search')}<span class="header-tool-label" aria-hidden="true">全局搜索</span></button>
        <button class="header-tool month-settings-toggle" type="button" aria-label="设置">${icon('settings')}<span class="header-tool-label" aria-hidden="true">设置</span></button>
      </div>
    </div>
  `;
  header.querySelector('.previous-month')?.addEventListener('click', () => switchMonth(root, -1));
  header.querySelector('.next-month')?.addEventListener('click', () => switchMonth(root, 1));
  header.querySelector('.month-current-button')?.addEventListener('click', () => switchToCurrentMonth(root));
  header.querySelector('.month-title-button')?.addEventListener('click', () => startMonthEditing(root));
  header.querySelector('.month-settings-toggle')?.addEventListener('click', () => openSettingsWindow());
  header.querySelector('.month-long-toggle').onclick = () => toggleMonthPanel(root, 'long');
  header.querySelector('.month-reminder-toggle').onclick = () => toggleMonthPanel(root, 'reminders');
  header.querySelector('.month-search-toggle').onclick = () => {
    if (reminderCenter.isBusy()) return;
    closeMonthPanel(root); searchMode = !searchMode; renderMonthView(root);
    if (searchMode) { monthSearch.focus(); monthSearch.refresh(); }
  };
  const input = header.querySelector('.month-title-input');
  if (input) {
    input.addEventListener('input', () => {
      monthInputValue = input.value;
    });
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        commitMonthEditing(root);
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        cancelMonthEditing(root);
      }
    });
    input.addEventListener('blur', () => {
      commitMonthEditing(root);
    });
    queueMicrotask(() => {
      input.focus({ preventScroll: true });
      input.select();
    });
  }
  return header;
}

async function openSettingsWindow() {
  try {
    await openSharedSettingsWindow();
  } catch (error) {
    console.error(error);
  }
}

function showMonthSettingsDialog(root) {
  document.querySelector('.dialog-overlay')?.remove();
  let draftTheme = { ...themeSettings };
  let activeSettingsTab = 'theme';
  const overlay = el('div', 'dialog-overlay settings-overlay');
  overlay.innerHTML = `
    <section class="settings-dialog" role="dialog" aria-modal="true" aria-labelledby="settings-title">
      <header class="settings-header">
        <div>
          <h2 id="settings-title">设置</h2>
          <p class="settings-subtitle">调整月视图主题和背景透明度。</p>
        </div>
        <button class="icon-button settings-close" type="button" title="关闭" aria-label="关闭">×</button>
      </header>
      <div class="settings-body">
        <aside class="settings-tabs">
          <button class="settings-tab" type="button" data-settings-tab="theme">主题</button>
          <button class="settings-tab" type="button" data-settings-tab="data">数据</button>
        </aside>
        <section class="settings-panel"></section>
      </div>
      <footer class="settings-actions">
        <button class="dialog-button reset-theme" type="button">恢复默认</button>
        <button class="dialog-button primary save-settings" type="button">完成</button>
      </footer>
    </section>
  `;

  const panel = overlay.querySelector('.settings-panel');
  const resetThemeButton = overlay.querySelector('.reset-theme');

  const renderThemePresets = () => {
    const grid = overlay.querySelector('.theme-preset-grid');
    grid.replaceChildren();
    getThemePresets(draftTheme.appearance).forEach((preset) => {
      const button = el('button', `theme-preset${draftTheme.presetId === preset.id ? ' is-active' : ''}`);
      button.type = 'button';
      button.style.setProperty('--preset-base', preset.color);
      button.style.setProperty('--preset-glow', preset.glow);
      button.style.setProperty('--preset-warm', preset.warm);
      button.innerHTML = `
        <span class="theme-preset-swatch"></span>
        <span>${preset.name}</span>
      `;
      button.addEventListener('click', () => {
        draftTheme = saveAndPreviewMonthTheme(root, { ...draftTheme, presetId: preset.id });
        renderThemePresets();
      });
      grid.append(button);
    });
  };

  const renderThemePanel = () => {
    panel.innerHTML = `
      <div class="settings-section-title">背景颜色</div>
      <div class="theme-preset-grid"></div>
      <label class="theme-opacity-control">
        <span>背景不透明度</span>
        <strong class="theme-opacity-value">${Math.round(draftTheme.opacity * 100)}%</strong>
        <input class="theme-opacity-input" type="range" min="34" max="100" step="1" value="${Math.round(draftTheme.opacity * 100)}" />
      </label>
    `;
    renderThemePresets();
    const opacityInput = overlay.querySelector('.theme-opacity-input');
    const opacityValue = overlay.querySelector('.theme-opacity-value');
    opacityInput?.addEventListener('input', () => {
      const opacity = Number(opacityInput.value) / 100;
      opacityValue.textContent = `${opacityInput.value}%`;
      draftTheme = saveAndPreviewMonthTheme(root, { ...draftTheme, opacity });
    });
  };

  const renderDataPanel = async () => {
    panel.innerHTML = `
      <div class="settings-section-title">数据存储位置</div>
      <p class="storage-description">任务、随笔和长期标签会从这里读取，也保存到这里。</p>
      <div class="storage-path-card">
        <span class="storage-path-label">${getStoragePathLabel(storageLocation)}</span>
        <code class="storage-path-value">${escapeHtml(getStoragePathText(storageLocation))}</code>
      </div>
      <p class="storage-warning">切换位置不会迁移数据。要迁移，请先复制旧文件夹里的数据，再切换到新文件夹。</p>
      <div class="storage-actions">
        <button class="dialog-button choose-storage" type="button">选择文件夹</button>
        <button class="dialog-button reset-storage" type="button">恢复默认位置</button>
      </div>
    `;

    try {
      storageLocation = await loadStorageLocation();
      panel.querySelector('.storage-path-label').textContent = getStoragePathLabel(storageLocation);
      panel.querySelector('.storage-path-value').textContent = getStoragePathText(storageLocation);
    } catch (error) {
      console.error(error);
      panel.querySelector('.storage-path-value').textContent = '读取存储位置失败';
    }

    panel.querySelector('.choose-storage')?.addEventListener('click', async () => {
      try {
        const path = await pickDataDirectory();
        if (!path) {
          return;
        }
        showMonthConfirmDialog({
          title: '确认切换存储位置？',
          message: '应用会改从新文件夹读取和保存数据；旧数据不会自动迁移。',
          confirmText: '确认切换',
          onConfirm: async () => {
            storageLocation = await setStorageLocation(path);
            notifyStorageUpdated(storageLocation);
            await loadMonth(root);
            renderDataPanel();
          },
        });
      } catch (error) {
        console.error(error);
      }
    });

    panel.querySelector('.reset-storage')?.addEventListener('click', () => {
      showMonthConfirmDialog({
        title: '确认恢复默认存储位置？',
        message: '应用会改回默认文件夹读取和保存数据；当前自定义文件夹不会被移动或删除。',
        confirmText: '确认恢复',
        onConfirm: async () => {
          storageLocation = await resetStorageLocation();
          notifyStorageUpdated(storageLocation);
          await loadMonth(root);
          renderDataPanel();
        },
      });
    });
  };

  const renderSettingsTab = () => {
    overlay.querySelectorAll('.settings-tab').forEach((button) => {
      button.classList.toggle('is-active', button.dataset.settingsTab === activeSettingsTab);
    });
    resetThemeButton.hidden = activeSettingsTab !== 'theme';
    if (activeSettingsTab === 'data') {
      renderDataPanel();
      return;
    }
    renderThemePanel();
  };

  overlay.querySelector('.reset-theme')?.addEventListener('click', () => {
    draftTheme = saveAndPreviewMonthTheme(root, defaultTheme);
    renderThemePanel();
  });
  overlay.querySelectorAll('.settings-tab').forEach((button) => {
    button.addEventListener('click', () => {
      activeSettingsTab = button.dataset.settingsTab || 'theme';
      renderSettingsTab();
    });
  });

  const close = () => overlay.remove();
  overlay.querySelector('.save-settings')?.addEventListener('click', close);
  overlay.querySelector('.settings-close')?.addEventListener('click', close);
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) {
      close();
    }
  });
  overlay.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      close();
    }
  });

  document.body.append(overlay);
  renderSettingsTab();
  queueMicrotask(() => overlay.querySelector('.theme-preset.is-active, .choose-storage')?.focus({ preventScroll: true }));
}

function showMonthConfirmDialog({ title, message, confirmText, onConfirm }) {
  const overlay = el('div', 'dialog-overlay confirm-overlay');
  overlay.innerHTML = `
    <section class="confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="confirm-title">
      <h2 id="confirm-title">${escapeHtml(title)}</h2>
      <p>${escapeHtml(message)}</p>
      <div class="dialog-actions">
        <button class="dialog-button cancel" type="button">取消</button>
        <button class="dialog-button confirm-action primary" type="button">${escapeHtml(confirmText)}</button>
      </div>
    </section>
  `;

  const close = () => overlay.remove();
  overlay.querySelector('.cancel')?.addEventListener('click', close);
  overlay.querySelector('.confirm-action')?.addEventListener('click', async () => {
    await onConfirm?.();
    close();
  });
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) {
      close();
    }
  });
  overlay.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      close();
    }
  });

  document.body.append(overlay);
  queueMicrotask(() => overlay.querySelector('.cancel')?.focus({ preventScroll: true }));
}

function saveAndPreviewMonthTheme(root, settings) {
  themeSettings = saveThemeSettings(settings);
  applyThemeSettings(themeSettings);
  notifyThemeUpdated(themeSettings);
  renderMonthView(root);
  return { ...themeSettings };
}

function notifyThemeUpdated(settings) {
  const payload = { settings };
  window.dispatchEvent(new CustomEvent('calendar://theme-updated', { detail: payload }));

  if (!window.__TAURI__?.event?.emit) {
    return;
  }

  window.__TAURI__.event.emit('calendar://theme-updated', payload).catch((error) => {
    console.error(error);
  });
}

function notifyStorageUpdated(location) {
  const payload = { location };
  window.dispatchEvent(new CustomEvent('calendar://storage-updated', { detail: payload }));

  if (!window.__TAURI__?.event?.emit) {
    return;
  }

  window.__TAURI__.event.emit('calendar://storage-updated', payload).catch((error) => {
    console.error(error);
  });
}

function getStoragePathText(location) {
  if (!location) {
    return '正在读取存储位置...';
  }
  return location.effectivePath || '读取存储位置失败';
}

function getStoragePathLabel(location) {
  if (!location) {
    return '当前存储位置';
  }
  return location.isDefault ? '默认位置' : '自定义位置';
}

function createMonthLayout(root) {
  const layout = el('section', 'month-layout');
  const calendar = createCalendarPanel(root); calendar.hidden = searchMode;
  monthSearch.element.hidden = !searchMode;
  const drawer = el('aside', 'month-tools-drawer'); drawer.hidden = !activePanel;
  drawer.innerHTML = `<div class="month-drawer-header"><button class="quiet-button ${activePanel === 'long' ? 'is-active' : ''}" type="button" data-panel="long">长期任务</button><button class="quiet-button ${activePanel === 'reminders' ? 'is-active' : ''}" type="button" data-panel="reminders">提醒</button><button class="icon-button month-drawer-close" type="button" aria-label="收起工具面板">${icon('close')}</button></div>`;
  const long = createLongTaskPlaceholder(); long.hidden = activePanel !== 'long';
  reminderCenter.element.hidden = activePanel !== 'reminders';
  drawer.append(long, reminderCenter.element);
  drawer.querySelectorAll('[data-panel]').forEach(button => { button.onclick = () => {
    if (!reminderCenter.isBusy() && activePanel !== button.dataset.panel) toggleMonthPanel(root, button.dataset.panel);
  }; });
  drawer.querySelector('.month-drawer-close').onclick = () => toggleMonthPanel(root, activePanel);
  layout.append(calendar, monthSearch.element, drawer);
  return layout;
}

function toggleMonthPanel(root, panel) {
  if (reminderCenter.isBusy()) return;
  const next = activePanel === panel ? null : panel;
  closeMonthPanel(root);
  activePanel = next;
  closeLongTaskTagPopover(); closeMonthContextMenu(); renderMonthView(root);
  if (activePanel === 'reminders') reminderCenter.refresh();
}

function closeMonthPanel(root) {
  if (activePanel === 'reminders') reminderCenter?.onPanelClose();
  activePanel = null;
  const drawer = root?.querySelector('.month-tools-drawer');
  if (drawer) drawer.hidden = true;
  root?.querySelectorAll('.month-long-toggle, .month-reminder-toggle').forEach(button => {
    button.classList.remove('is-active'); button.setAttribute('aria-pressed', 'false');
  });
  closeLongTaskTagPopover(); closeMonthContextMenu();
}

function createLongTaskPlaceholder() {
  const aside = el('aside', 'month-long-task-placeholder');
  aside.innerHTML = `
    <div class="month-pane-title">
      <div class="month-pane-heading"><h2>${sproutMarkup('long-task-bud')}长期任务</h2><p>随时加入日任务</p></div>
      <button class="workspace-primary add-long-task" type="button" aria-label="添加长期任务">${icon('plus')}新建任务</button>
    </div>
    <div class="long-task-title-actions">
        <button class="deleted-toggle long-task-deleted-toggle" type="button" aria-pressed="${showDeletedLongTasks}" title="显示已删除">
          <span>显示已删除：${showDeletedLongTasks ? '开' : '关'}</span>
          <span class="switch${showDeletedLongTasks ? ' is-on' : ''}"></span>
        </button>
    </div>
    <div class="long-task-list" aria-live="polite"></div>
  `;
  aside.querySelector('.long-task-deleted-toggle')?.addEventListener('click', () => {
    showDeletedLongTasks = !showDeletedLongTasks;
    renderMonthView(document.querySelector('.month-window'));
  });
  aside.querySelector('.add-long-task')?.addEventListener('click', () => addLongTask());
  const list = aside.querySelector('.long-task-list');
  list.addEventListener('scroll', () => {
    if (list.isConnected) {
      closeLongTaskTagPopover();
    }
  }, { passive: true });
  renderLongTaskList(list);
  return aside;
}

function renderLongTaskList(container) {
  container.replaceChildren();
  if (isLongTasksLoading) {
    const loading = el('div', 'long-task-empty');
    loading.textContent = '正在读取长期任务';
    container.append(loading);
    return;
  }

  const visibleTasks = getRenderableTasks(longTasks, showDeletedLongTasks);
  if (visibleTasks.length === 0) {
    const empty = el('div', 'long-task-empty');
    if (showDeletedLongTasks) empty.textContent = '暂无已删除长期任务';
    else {
      empty.append(createBotanicalEmpty('为想做的事，留一枝', '先记在这里，准备好时再加入某一天。'));
      const original = el('span', 'minimal-empty'); original.textContent = '暂无长期任务'; empty.append(original);
    }
    container.append(empty);
    return;
  }

  visibleTasks.forEach((task) => container.append(createLongTaskItem(task)));
}

function createLongTaskItem(task) {
  const item = el('article', `long-task-item${task.status === 'deleted' ? ' is-deleted' : ''}`);
  item.dataset.taskId = task.id;
  const isDeleted = task.status === 'deleted';
  const isEditing = task.id === editingLongTaskId;
  const titleControl = isEditing
    ? `<input class="long-task-title-input" type="text" value="${escapeHtml(task.title)}" aria-label="编辑长期任务" ${longTaskSaving ? 'disabled' : ''}/>`
    : `<button class="long-task-title" type="button" title="点击编辑">${escapeHtml(task.title || '未命名任务')}</button>`;
  const actionsMarkup = isDeleted
    ? ''
    : isEditing ? `<button class="quiet-button long-task-cancel" type="button" ${longTaskSaving ? 'disabled' : ''}>取消</button><button class="workspace-primary long-task-save" type="button" ${longTaskSaving ? 'disabled' : ''}>${icon('check')}${longTaskSaving ? '保存中…' : '保存任务'}</button>`
    : `
      <button class="action-button add-long-tag" type="button" title="添加标签" aria-label="添加标签">${icon('tag')}</button>
      <button class="quiet-button add-long-to-day" type="button" title="加入今天的日任务" aria-label="加入今天的日任务">${icon('calendar-arrow-down')}<span>加入今天</span></button>
    `;
  item.innerHTML = `
    <button class="long-task-drag-handle" type="button" title="拖拽排序" aria-label="拖拽排序">${icon('drag')}</button>
    <div class="long-task-main">
      ${titleControl}
    </div>
    <div class="long-task-tags"></div>
    <div class="long-task-actions${isEditing ? ' long-task-editor-actions' : ''}">${actionsMarkup}</div>
    ${isEditing && longTaskEditError ? `<p class="long-task-edit-error" role="status">${escapeHtml(longTaskEditError)}</p>` : ''}
  `;
  renderLongTaskTags(item.querySelector('.long-task-tags'), task);
  bindLongTaskItem(item, task);
  item.addEventListener('contextmenu', (event) => {
    if (event.target.closest('button')) {
      return;
    }
    openLongTaskContextMenu(event, task);
  });
  return item;
}

function renderLongTaskTags(container, task) {
  container.replaceChildren();
  (task.tags || []).forEach((tag) => {
    const chip = el('span', 'tag-chip');
    chip.style.setProperty('--tag-color', getSnapshotTagColor(tag, '#9aa8b5'));
    chip.append(document.createTextNode(getTagText(tag)));
    const remove = el('button', 'tag-remove');
    remove.type = 'button';
    remove.title = '移除标签';
    remove.textContent = '×';
    remove.addEventListener('click', (event) => {
      event.stopPropagation();
      task.tags = (task.tags || []).filter((item) => item.id !== tag.id);
      persistLongTasksSoon();
      renderMonthView(document.querySelector('.month-window'));
    });
    chip.append(remove);
    container.append(chip);
  });
}

function createLongTaskTagPopover(task) {
  const popover = el('section', 'tag-popover long-task-tag-popover');
  popover.innerHTML = `
    <div class="tag-popover-head">
      <h3>添加标签</h3>
      <button class="icon-button tag-popover-close" type="button" title="关闭" aria-label="关闭">×</button>
    </div>
    <div class="tag-popover-section">
      <label>临时标签</label>
      <div class="tag-create-row">
        <input class="tag-create-input" type="text" value="${escapeHtml(temporaryLongTaskTagText)}" placeholder="输入标签名" aria-label="输入标签名" />
        <button class="dialog-button tag-create-submit" type="button">添加</button>
      </div>
      <div class="tag-color-row"></div>
    </div>
    <div class="tag-popover-section">
      <div class="tag-section-title">
        <label>长期标签</label>
        <button class="tag-manage-link" type="button">管理长期标签</button>
      </div>
      <div class="tag-group-pager"></div>
      <div class="tag-template-list"></div>
    </div>
  `;

  popover.querySelector('.tag-popover-close')?.addEventListener('click', () => {
    closeLongTaskTagPopover();
  });

  const input = popover.querySelector('.tag-create-input');
  const submitTemporaryTag = () => {
    const text = input.value.trim();
    if (!text) {
      return;
    }
    temporaryLongTaskTagText = '';
    addTagToLongTask(task, createTagSnapshot(text, temporaryLongTaskTagColor, 'custom'));
  };
  popover.querySelector('.tag-create-submit')?.addEventListener('click', submitTemporaryTag);
  input?.addEventListener('input', () => {
    temporaryLongTaskTagText = input.value;
  });
  input?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      submitTemporaryTag();
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      closeLongTaskTagPopover(true);
    }
  });

  const colorRow = popover.querySelector('.tag-color-row');
  tagColors.forEach((color) => {
    const swatch = el('button', `tag-color-swatch${temporaryLongTaskTagColor === color ? ' is-selected' : ''}`);
    swatch.type = 'button';
    swatch.style.setProperty('--swatch', color);
    swatch.setAttribute('aria-label', `选择颜色 ${color}`);
    swatch.addEventListener('click', () => {
      temporaryLongTaskTagColor = color;
      colorRow.querySelectorAll('.tag-color-swatch').forEach((button) => {
        button.classList.toggle('is-selected', button === swatch);
      });
    });
    colorRow.append(swatch);
  });

  renderLongTaskTagGroups(popover, task);
  popover.querySelector('.tag-manage-link')?.addEventListener('click', () => {
    closeLongTaskTagPopover();
    openLongTagManagerWindow();
  });

  queueMicrotask(() => {
    if (!popover.isConnected) return;
    // Measure the mounted pager so long group names paginate within the popup.
    renderLongTaskTagGroups(popover, task);
    input?.focus({ preventScroll: true });
  });
  return popover;
}

function getActiveLongTaskTagGroup() {
  const group = tagTemplates.groups.find((item) => item.id === activeLongTaskTagGroupId)
    || tagTemplates.groups[0] || null;
  activeLongTaskTagGroupId = group?.id || null;
  return group;
}

function renderLongTaskTagGroups(popover, task) {
  getActiveLongTaskTagGroup();
  const pager = popover.querySelector('.tag-group-pager');
  const visibleName = (group) => Array.from(group.name).slice(0, 5).join('');
  const tabWidth = (group) => {
    const textWidth = Array.from(visibleName(group)).reduce((width, char) => width + (/[\u4e00-\u9fff]/.test(char) ? 14 : 8), 0);
    return Math.min(90, Math.max(34, textWidth + 18));
  };
  const availableWidth = Math.max(0, (pager.getBoundingClientRect().width || 286) - 93);
  const pages = [[]];
  let usedWidth = 0;
  tagTemplates.groups.forEach((group) => {
    const width = tabWidth(group);
    const page = pages.at(-1);
    if (page.length && usedWidth + 5 + width > availableWidth) {
      pages.push([]);
      usedWidth = 0;
    }
    const currentPage = pages.at(-1);
    usedWidth += width + (currentPage.length ? 5 : 0);
    currentPage.push(group);
  });
  const selectedPage = pages.findIndex((page) => page.some((group) => group.id === activeLongTaskTagGroupId));
  activeLongTaskTagGroupPage = selectedPage >= 0 ? selectedPage : 0;
  pager.replaceChildren();
  const pageButton = (text, label, step) => {
    const button = el('button', 'tag-page-button');
    button.type = 'button';
    button.textContent = text;
    button.setAttribute('aria-label', label);
    button.disabled = !pages[activeLongTaskTagGroupPage + step];
    button.addEventListener('click', () => {
      activeLongTaskTagGroupId = pages[activeLongTaskTagGroupPage + step][0].id;
      renderLongTaskTagGroups(popover, task);
    });
    return button;
  };
  pager.append(pageButton('‹', '上一页标签分组', -1));
  pages[activeLongTaskTagGroupPage].forEach((group) => {
    const button = el('button', `tag-group-tab${group.id === activeLongTaskTagGroupId ? ' is-active' : ''}`);
    button.type = 'button';
    button.textContent = visibleName(group);
    button.title = group.name;
    button.setAttribute('aria-pressed', String(group.id === activeLongTaskTagGroupId));
    button.style.setProperty('--tag-group-width', `${tabWidth(group)}px`);
    button.addEventListener('click', () => {
      activeLongTaskTagGroupId = group.id;
      renderLongTaskTagGroups(popover, task);
    });
    pager.append(button);
  });
  pager.append(pageButton('›', '下一页标签分组', 1));
  const counter = el('span', 'tag-page-counter');
  counter.textContent = `${activeLongTaskTagGroupPage + 1}/${pages.length}`;
  pager.append(counter);
  renderLongTaskTemplateTags(popover.querySelector('.tag-template-list'), task);
  if (popover.isConnected) {
    const item = [...document.querySelectorAll('.month-window .long-task-item')]
      .find((node) => node.dataset.taskId === task.id);
    const anchor = item?.querySelector('.add-long-tag');
    if (anchor) positionLongTaskTagPopover(popover, anchor);
  }
}

function renderLongTaskTemplateTags(container, task) {
  container.replaceChildren();
  const templates = getActiveLongTaskTagGroup()?.tags || [];
  if (!templates.length) {
    const empty = el('div', 'tag-template-empty');
    empty.textContent = '该分组暂无长期标签';
    container.append(empty);
    return;
  }
  templates.forEach((template) => {
    const button = el('button', 'tag-template-button');
    button.type = 'button';
    button.style.setProperty('--tag-color', template.color || tagColors[0]);
    button.textContent = template.text || '未命名标签';
    button.addEventListener('click', () => addTagToLongTask(task, cloneTemplateAsSnapshot(template)));
    container.append(button);
  });
}

function addTagToLongTask(task, tag) {
  task.tags ||= [];
  task.tags.push(tag);
  activeLongTaskTagPopoverId = null;
  persistLongTasksSoon();
  renderMonthView(document.querySelector('.month-window'));
}

function bindLongTaskItem(item, task) {
  item.querySelector('.long-task-title')?.addEventListener('click', () => {
    if (task.status === 'deleted') {
      return;
    }
    editingLongTaskId = task.id;
    longTaskEditOriginal = task.title; longTaskEditError = '';
    refreshLongTaskList();
  });
    const input = item.querySelector('.long-task-title-input');
    if (input) {
      input.addEventListener('input', () => {
        task.title = input.value;
      });
      input.addEventListener('keydown', (event) => {
        if (event.isComposing) return;
        if (event.key === 'Enter') { event.preventDefault(); finishLongTaskEditing(task); }
        if (event.key === 'Escape') { event.preventDefault(); cancelLongTaskEditing(task); }
      });
      input.addEventListener('blur', event => {
        if (event.relatedTarget?.closest('.long-task-editor-actions')) return;
        if (input.isConnected) finishLongTaskEditing(task);
      });
    queueMicrotask(() => {
      input.focus({ preventScroll: true });
      input.select();
    });
  }

  item.querySelector('.long-task-save')?.addEventListener('click', () => finishLongTaskEditing(task));
  item.querySelector('.long-task-cancel')?.addEventListener('click', () => cancelLongTaskEditing(task));

  item.querySelector('.add-long-to-day')?.addEventListener('click', () => addLongTaskToToday(task));
  item.querySelector('.add-long-tag')?.addEventListener('click', () => {
    activeLongTaskTagPopoverId = activeLongTaskTagPopoverId === task.id ? null : task.id;
    renderLongTaskTagPopover(document.querySelector('.month-window'));
  });

  item.querySelector('.long-task-drag-handle')?.addEventListener('pointerdown', (event) => {
    if (!canMoveTask(task, '')) {
      return;
    }
    longTaskDragController?.start(event, task.id, item);
  });
}

function openLongTaskContextMenu(event, task) {
  if (!task) {
    return;
  }

  event.preventDefault();
  closeMonthContextMenu();
  const menu = el('div', 'task-context-menu');
  menu.setAttribute('role', 'menu');
  menu.append(createMonthContextMenuItem('复制', () => {
    copyLongTask(task);
    showMonthToast('已复制长期任务');
  }));
  if (task.status !== 'deleted') menu.append(createMonthContextMenuItem('加入指定日期', () => chooseLongTaskDate(task)));
  if (task.status === 'deleted') {
    menu.append(createMonthContextMenuItem('恢复', () => restoreLongTask(task.id)));
    menu.append(createMonthContextMenuItem('彻底删除', () => destroyLongTask(task.id)));
  } else {
    menu.append(createMonthContextMenuItem('删除', () => softDeleteLongTask(task.id)));
  }
  openMonthContextMenuElement(menu, event.clientX, event.clientY);
}

async function openLongTagManagerWindow() {
  try {
    await openSharedSettingsWindow('tags');
  } catch (error) {
    console.error(error);
  }
}

function copyLongTask(task) {
  const copiedTask = structuredClone(task);
  delete copiedTask.color;
  copyTask({
    sourceDate: `long-task:${task.id}`,
    task: {
      ...copiedTask,
      status: 'active',
      children: [],
    },
  });
}

function softDeleteLongTask(taskId) {
  const task = longTasks.find((item) => item.id === taskId);
  if (!task) {
    return;
  }
  task.status = 'deleted';
  persistLongTasksSoon();
  renderMonthView(document.querySelector('.month-window'));
}

function restoreLongTask(taskId) {
  const task = longTasks.find((item) => item.id === taskId);
  if (!task || task.status !== 'deleted') {
    return;
  }
  task.status = 'active';
  persistLongTasksSoon();
  renderMonthView(document.querySelector('.month-window'));
}

function destroyLongTask(taskId) {
  longTasks = longTasks.filter((task) => task.id !== taskId);
  persistLongTasksSoon();
  renderMonthView(document.querySelector('.month-window'));
}

function createCalendarPanel(root) {
  const panel = el('section', 'month-calendar-panel');
  panel.append(createCalendarGrid(root));
  return panel;
}

function createCalendarGrid(root) {
  monthTaskResizeObserver?.disconnect();
  const calendar = el('div', 'month-calendar');
  const weekdays = el('div', 'month-weekdays');
  WEEKDAY_LABELS.forEach((label) => {
    const item = el('span', 'month-weekday');
    item.textContent = label;
    weekdays.append(item);
  });

  const grid = el('div', 'month-grid');
  const dates = getMonthGridDates(currentMonthKey);
  grid.style.setProperty('--month-week-count', dates.length / 7);
  if (loadErrorMessage) {
    grid.append(createGridMessage(loadErrorMessage, 'is-error'));
  } else {
    dates.forEach((day) => {
      const cell = createMonthDayCell(day);
      if (isMonthLoading) {
        cell.classList.add('is-loading');
        cell.setAttribute('aria-busy', 'true');
      }
      grid.append(cell);
    });
  }

  calendar.append(weekdays, grid);
  return calendar;
}

function createGridMessage(text, className = '') {
  const message = el('div', `month-grid-message ${className}`.trim());
  message.textContent = text;
  return message;
}

function createMonthDayCell(day) {
  const button = el('button', `month-day-cell${day.isCurrentMonth ? '' : ' is-outside'}${day.isToday ? ' is-today' : ''}`);
  button.type = 'button';
  button.dataset.date = day.dateKey;
  button.setAttribute('aria-label', `打开 ${day.dateKey} 的日视图`);
  button.innerHTML = `
    <span class="month-day-number">${day.day}</span>
    <span class="month-day-lunar${showLunarDates ? '' : ' is-hidden'}"></span>
  `;

  if (day.isCurrentMonth && !isMonthLoading) {
    button.append(createTaskList(day.dateKey));
  }

  button.addEventListener('contextmenu', (event) => {
    if (event.target.closest('.month-task-chip')) {
      return;
    }
    openMonthDateContextMenu(event, day.dateKey);
  });
  button.addEventListener('click', () => {
    openDayWindow(day.dateKey);
  });
  return button;
}

async function loadLongTaskPanel(root) {
  isLongTasksLoading = true;
  renderMonthView(root);
  try {
    const [storedTasks, storedTemplates] = await Promise.all([
      loadLongTasks({}),
      loadTagTemplates(),
    ]);
    longTasks = removeEmptyLongTasks(storedTasks);
    tagTemplates = storedTemplates;
  } catch (error) {
    console.error(error);
    longTasks = [];
  } finally {
    isLongTasksLoading = false;
    renderMonthView(root);
  }
}

function addLongTask() {
  if (editingLongTaskId) {
    document.querySelector('.long-task-title-input')?.focus();
    return;
  }
  const task = createBlankTask();
  task.children = [];
  longTasks.unshift(task);
  editingLongTaskId = task.id;
  draftLongTaskId = task.id;
  longTaskEditOriginal = ''; longTaskEditError = '';
  activeLongTaskTagPopoverId = null;
  renderMonthView(document.querySelector('.month-window'));
}

function refreshLongTaskList() {
  const list = document.querySelector('.month-window .long-task-list');
  if (list) { const scrollTop = list.scrollTop; renderLongTaskList(list); list.scrollTop = scrollTop; }
}

function cancelLongTaskEditing(task) {
  if (longTaskSaving || editingLongTaskId !== task.id) return;
  if (draftLongTaskId === task.id) longTasks = longTasks.filter(item => item.id !== task.id);
  else task.title = longTaskEditOriginal;
  editingLongTaskId = null; draftLongTaskId = null; longTaskEditError = '';
  refreshLongTaskList();
}

async function finishLongTaskEditing(task) {
  if (longTaskSaving || editingLongTaskId !== task.id) return;
  const normalizedTitle = task.title.trim();
  if (!normalizedTitle) { cancelLongTaskEditing(task); return; }
  task.title = normalizedTitle; longTaskSaving = true; longTaskEditError = '';
  document.querySelectorAll('.long-task-title-input, .long-task-save, .long-task-cancel').forEach(control => { control.disabled = true; });
  const saved = await persistLongTasksSoon();
  longTaskSaving = false;
  if (saved) { draftLongTaskId = null; editingLongTaskId = null; }
  else longTaskEditError = '保存失败，请重试。';
  refreshLongTaskList();
}

async function persistLongTasksSoon() {
  try {
    longTasks = removeEmptyLongTasks(longTasks);
    await saveLongTasks(longTasks);
    return true;
  } catch (error) {
    console.error(error);
    showMonthToast('长期任务保存失败，请重试');
    return false;
  }
}

function removeEmptyLongTasks(tasks) {
  return (tasks || []).filter((task) => {
    const hasTitle = typeof task.title === 'string' && task.title.trim();
    const hasTags = Array.isArray(task.tags) && task.tags.length > 0;
    return hasTitle || hasTags || task.status === 'deleted';
  });
}

async function addLongTaskToToday(task) {
  const today = getTodayDateKey();
  const dayTask = createDayTaskFromLongTask(task);
  try {
    const storedDay = await loadDay(today);
    const nextDay = {
      date: storedDay?.date || today,
      note: storedDay?.note || '',
      tasks: normalizeTaskTree([...(storedDay?.tasks || []), dayTask]),
    };
    await saveDayNow(nextDay);
    showMonthToast('已添加到日任务');
  } catch (error) {
    console.error(error);
  }
}

function createDayTaskFromLongTask(task) {
  const clone = structuredClone(task);
  delete clone.color;
  return {
    ...clone,
    id: `task-${crypto.randomUUID()}`,
    status: 'active',
    children: [],
  };
}

function chooseLongTaskDate(task) {
  const overlay = el('div', 'dialog-overlay');
  overlay.innerHTML = `<form class="confirm-dialog"><h2>加入日任务</h2><label class="calendar-date-label">选择日期<input type="date" value="${getTodayDateKey()}" aria-label="长期任务目标日期" required/></label><div class="dialog-actions"><button type="button" class="dialog-button cancel">取消</button><button type="submit" class="dialog-button primary">添加</button></div><p class="reminder-form-error" role="status"></p></form>`;
  overlay.querySelector('.cancel').onclick = () => overlay.remove();
  overlay.querySelector('form').onsubmit = async event => {
    event.preventDefault(); const date = overlay.querySelector('input').value;
    try {
      await ensureReminders(date); const day = await loadDay(date) || { date, tasks: [], note: '' };
      await saveDayNow({ ...day, tasks: [...day.tasks, createDayTaskFromLongTask(task)] });
      overlay.remove(); showMonthToast(`已添加到 ${date}`);
    } catch (error) { overlay.querySelector('.reminder-form-error').textContent = `添加失败：${error.message || error}`; }
  };
  document.body.append(overlay); overlay.querySelector('input').focus();
}

function createTaskList(dateKey) {
  const day = monthDays.get(dateKey);
  const rootTasks = getMonthRootTasks(day?.tasks || []);
  const list = el('span', 'month-task-list');
  list.dataset.total = rootTasks.length;
  rootTasks.slice(0, MAX_TASKS_PER_DAY).forEach((task) => {
    list.append(createTaskChip(task, dateKey));
  });
  const more = el('span', 'month-more-tasks'); more.hidden = true; list.append(more);
  monthTaskResizeObserver?.observe(list);
  return list;
}

function fitMonthTaskList(list) {
  if (!list.isConnected || list.clientHeight <= 0) return;
  const styles = getComputedStyle(list);
  const height = list.clientHeight;
  const gap = parseFloat(styles.rowGap) || 0;
  const chipHeight = parseFloat(styles.getPropertyValue('--month-task-height')) || 18;
  const moreHeight = parseFloat(styles.getPropertyValue('--month-more-height')) || 14;
  const total = Number(list.dataset.total);
  const chips = [...list.querySelectorAll('.month-task-chip')];
  let count = Math.min(chips.length, Math.max(0, Math.floor((height + gap) / (chipHeight + gap))));
  if (count < total) count = Math.min(chips.length, Math.max(0, Math.floor((height - moreHeight) / (chipHeight + gap))));
  chips.forEach((chip, index) => { chip.hidden = index >= count; });
  const more = list.querySelector('.month-more-tasks');
  more.hidden = count >= total; more.textContent = count < total ? `还有 ${total - count} 项` : '';
}

function getMonthRootTasks(tasks) {
  return getRenderableTasks(tasks, false).filter((task) => ['active', 'completed', 'failed'].includes(task.status));
}

function createTaskChip(task, dateKey) {
  const chip = el('span', `month-task-chip is-${task.status}${task.color ? ' has-custom-color' : ''}`);
  chip.classList.toggle('is-reminder', Boolean(task.reminder));
  chip.classList.toggle('is-pinned-task', Boolean(task.pinned));
  chip.dataset.taskId = task.id;
  chip.dataset.date = dateKey;
  chip.style.setProperty('--task-color', getTaskChipColor(task));
  if (task.reminder) chip.insertAdjacentHTML('beforeend', icon(task.kind === 'birthday' ? 'cake' : task.kind === 'anniversary' ? 'heart' : 'bell'));
  if (taskStatusMeta[task.status].symbol) {
    const status = el('span', 'month-task-status');
    status.setAttribute('aria-label', taskStatusMeta[task.status].label);
    if (task.status === 'completed') status.innerHTML = completionMarkup();
    else status.textContent = taskStatusMeta[task.status].symbol;
    chip.append(status);
  }
  const title = el('span', 'month-task-title');
  title.textContent = truncateText(task.title || '未命名任务', 12);
  chip.append(title);
  chip.title = task.title || '未命名任务';
  chip.addEventListener('click', (event) => {
    event.stopPropagation();
    openDay(dateKey, { taskId: task.id }).catch(console.error);
  });
  chip.addEventListener('contextmenu', (event) => {
    event.stopPropagation();
    openMonthTaskContextMenu(event, task);
  });
  return chip;
}

function getTaskChipColor(task) {
  return task.color || 'rgb(var(--theme-border-rgb))';
}

function openMonthTaskContextMenu(event, task) {
  if (!task || task.status === 'deleted') {
    return;
  }

  event.preventDefault();
  const sourceDate = event.currentTarget.closest('.month-day-cell')?.dataset.date;
  closeMonthContextMenu();
  const menu = el('div', 'task-context-menu');
  menu.setAttribute('role', 'menu');
  menu.append(createMonthContextMenuItem('复制', () => {
    copyTask({ sourceDate, task });
    showMonthToast('已复制任务');
  }));
  if (canPasteToDate(sourceDate)) {
    menu.append(createMonthContextMenuItem('粘贴', () => pasteTaskToMonthDate(sourceDate)));
  }
  openMonthContextMenuElement(menu, event.clientX, event.clientY);
}

function openMonthDateContextMenu(event, dateKey) {
  event.preventDefault();
  event.stopPropagation();
  closeMonthContextMenu();
  const menu = el('div', 'task-context-menu');
  menu.setAttribute('role', 'menu');
  if (canPasteToDate(dateKey)) menu.append(createMonthContextMenuItem('粘贴', () => pasteTaskToMonthDate(dateKey)));
  menu.append(createMonthContextMenuItem('为这一天添加提醒', () => {
    activePanel = 'reminders'; renderMonthView(document.querySelector('.month-window')); reminderCenter.create(dateKey);
  }));
  openMonthContextMenuElement(menu, event.clientX, event.clientY);
}

function createMonthContextMenuItem(label, onClick) {
  const button = el('button', 'task-context-menu-item');
  button.type = 'button';
  button.setAttribute('role', 'menuitem');
  button.innerHTML = `<span>${escapeHtml(label)}</span>`;
  button.addEventListener('click', () => {
    closeMonthContextMenu();
    onClick?.();
  });
  return button;
}

function openMonthContextMenuElement(menu, clientX, clientY) {
  document.body.append(menu);
  positionMonthContextMenu(menu, clientX, clientY);
  monthContextMenu = menu;

  window.addEventListener('keydown', handleMonthContextMenuKeydown, true);
  window.addEventListener('resize', closeMonthContextMenu);
  window.addEventListener('blur', closeMonthContextMenu);
  document.addEventListener('pointerdown', handleMonthContextMenuOutsidePointerDown, true);
  document.addEventListener('scroll', closeMonthContextMenu, true);
}

function positionMonthContextMenu(menu, clientX, clientY) {
  const margin = 8;
  const rect = menu.getBoundingClientRect();
  const left = Math.min(clientX, window.innerWidth - rect.width - margin);
  const top = Math.min(clientY, window.innerHeight - rect.height - margin);
  menu.style.left = `${Math.max(margin, left)}px`;
  menu.style.top = `${Math.max(margin, top)}px`;
}

function closeMonthContextMenu() {
  if (!monthContextMenu) {
    return;
  }

  monthContextMenu.remove();
  monthContextMenu = null;
  window.removeEventListener('keydown', handleMonthContextMenuKeydown, true);
  window.removeEventListener('resize', closeMonthContextMenu);
  window.removeEventListener('blur', closeMonthContextMenu);
  document.removeEventListener('pointerdown', handleMonthContextMenuOutsidePointerDown, true);
  document.removeEventListener('scroll', closeMonthContextMenu, true);
}

function handleMonthContextMenuKeydown(event) {
  if (event.key !== 'Escape') {
    return;
  }
  event.preventDefault();
  closeMonthContextMenu();
}

function handleMonthContextMenuOutsidePointerDown(event) {
  if (monthContextMenu?.contains(event.target)) {
    return;
  }
  closeMonthContextMenu();
}

async function pasteTaskToMonthDate(dateKey) {
  const task = createPastedTaskFromClipboard();
  if (!task || !canPasteToDate(dateKey)) {
    return;
  }

  try {
    const storedDay = await loadDay(dateKey);
    const nextDay = {
      date: storedDay?.date || dateKey,
      note: storedDay?.note || '',
      tasks: normalizeTaskTree([...(storedDay?.tasks || []), task]),
    };
    await saveDayNow(nextDay);
  } catch (error) {
    console.error(error);
  }
}

function showMonthToast(message) {
  document.querySelector('.toast')?.remove();
  const toast = el('div', 'toast');
  toast.textContent = message;
  document.body.append(toast);
  window.setTimeout(() => {
    toast.classList.add('is-hiding');
    toast.addEventListener('animationend', () => toast.remove(), { once: true });
    window.setTimeout(() => toast.remove(), 240);
  }, 1800);
}

async function switchMonth(root, offsetMonths) {
  if (isMonthLoading) {
    return;
  }
  editingMonth = false;
  currentMonthKey = shiftMonthKey(currentMonthKey, offsetMonths);
  await loadMonth(root);
}

async function switchToCurrentMonth(root) {
  if (isMonthLoading) {
    return;
  }
  const todayMonthKey = getMonthKeyFromDateKey(getTodayDateKey());
  if (currentMonthKey === todayMonthKey) {
    return;
  }
  editingMonth = false;
  currentMonthKey = todayMonthKey;
  await loadMonth(root);
}

function startMonthEditing(root) {
  editingMonth = true;
  monthInputValue = currentMonthKey;
  renderMonthView(root);
}

function cancelMonthEditing(root) {
  editingMonth = false;
  monthInputValue = '';
  renderMonthView(root);
}

async function commitMonthEditing(root) {
  if (!editingMonth) {
    return;
  }
  const nextMonthKey = parseMonthInput(monthInputValue);
  editingMonth = false;
  monthInputValue = '';
  if (!nextMonthKey || nextMonthKey === currentMonthKey) {
    renderMonthView(root);
    return;
  }
  currentMonthKey = nextMonthKey;
  await loadMonth(root);
}

function parseMonthInput(value) {
  const normalized = value.trim().replace(/[年月/.\s]+/g, '-').replace(/-+$/g, '');
  const match = normalized.match(/^(\d{4})-(\d{1,2})$/);
  if (!match) {
    return null;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
    return null;
  }
  return `${year}-${String(month).padStart(2, '0')}`;
}

async function loadMonth(root) {
  isMonthLoading = true;
  loadErrorMessage = '';
  renderMonthCalendar(root);

  try {
    const currentMonthDates = getMonthGridDates(currentMonthKey)
      .filter((day) => day.isCurrentMonth)
      .map((day) => day.dateKey);
    const uniqueDates = [...new Set(currentMonthDates)];
    await ensureReminders(uniqueDates[0], uniqueDates.at(-1)).catch(error => { console.error(error); showMonthToast('提醒暂未生成，请稍后重试'); });
    const loadedDays = await Promise.all(uniqueDates.map(async (dateKey) => [dateKey, await loadDay(dateKey)]));
    monthDays = new Map(loadedDays.map(([dateKey, day]) => [dateKey, normalizeMonthDay(day, dateKey)]));
  } catch (error) {
    console.error(error);
    loadErrorMessage = '读取本月数据失败';
    monthDays = new Map();
  } finally {
    isMonthLoading = false;
    renderMonthCalendar(root);
  }
}

function normalizeMonthDay(day, dateKey) {
  const tasks = Array.isArray(day?.tasks) ? day.tasks : [];
  return {
    date: day?.date || dateKey,
    tasks: normalizeTaskTree(tasks),
  };
}

function renderMonthView(root) {
  if (!root) {
    return;
  }
  longTaskDragController?.cancel();
  const longTaskScrollTop = root.querySelector('.long-task-list')?.scrollTop || 0;
  const focus = document.activeElement;
  root.replaceChildren(createTitleBar(), createMonthHeader(root), createMonthLayout(root));
  root.querySelector('.long-task-list').scrollTop = longTaskScrollTop;
  if (focus?.isConnected && focus.closest('.reminder-center,.month-search-workspace')) focus.focus({ preventScroll: true });
  renderLongTaskTagPopover(root);
}

function renderLongTaskTagPopover(root) {
  document.querySelector('.long-task-tag-layer')?.remove();
  root?.querySelectorAll('.long-task-item').forEach(item => item.classList.toggle('has-tag-popover', item.dataset.taskId === activeLongTaskTagPopoverId));
  if (!activeLongTaskTagPopoverId || !root?.isConnected) {
    return;
  }

  const task = longTasks.find((item) => item.id === activeLongTaskTagPopoverId);
  const item = Array.from(root.querySelectorAll('.long-task-item'))
    .find((element) => element.dataset.taskId === activeLongTaskTagPopoverId);
  const anchor = item?.querySelector('.add-long-tag');
  if (!task || !anchor) {
    activeLongTaskTagPopoverId = null;
    return;
  }

  const layer = el('div', 'tag-popover-layer long-task-tag-layer');
  const popover = createLongTaskTagPopover(task);
  layer.append(popover);
  document.body.append(layer);
  positionLongTaskTagPopover(popover, anchor);
}

function positionLongTaskTagPopover(popover, anchor) {
  const margin = 12;
  const gap = 8;
  const anchorRect = anchor.getBoundingClientRect();
  const width = Math.min(320, window.innerWidth - margin * 2);
  popover.style.width = `${width}px`;
  popover.style.maxHeight = `${window.innerHeight - margin * 2}px`;

  const preferredHeight = popover.getBoundingClientRect().height;
  const spaceBelow = window.innerHeight - anchorRect.bottom - gap - margin;
  const spaceAbove = anchorRect.top - gap - margin;
  const openBelow = spaceBelow >= preferredHeight || spaceBelow >= spaceAbove;
  popover.style.maxHeight = `${Math.max(0, openBelow ? spaceBelow : spaceAbove)}px`;
  const height = popover.getBoundingClientRect().height;
  const left = Math.max(margin, Math.min(anchorRect.right - width, window.innerWidth - width - margin));
  const top = openBelow ? anchorRect.bottom + gap : anchorRect.top - height - gap;
  popover.style.left = `${left}px`;
  popover.style.top = `${Math.max(margin, Math.min(top, window.innerHeight - height - margin))}px`;
}

function closeLongTaskTagPopover(restoreFocus = false) {
  const taskId = activeLongTaskTagPopoverId;
  activeLongTaskTagPopoverId = null;
  document.querySelectorAll('.long-task-item.has-tag-popover').forEach(item => item.classList.remove('has-tag-popover'));
  document.querySelector('.long-task-tag-layer')?.remove();
  if (restoreFocus && taskId) {
    const item = Array.from(document.querySelectorAll('.long-task-item'))
      .find((element) => element.dataset.taskId === taskId);
    item?.querySelector('.add-long-tag')?.focus({ preventScroll: true });
  }
}

function bindLongTaskTagPopoverHandlers() {
  if (isLongTaskTagPopoverHandlerBound) {
    return;
  }
  isLongTaskTagPopoverHandlerBound = true;
  document.addEventListener('pointerdown', (event) => {
    if (!activeLongTaskTagPopoverId) {
      return;
    }
    const target = event.target instanceof Element ? event.target : null;
    if (!target?.closest('.long-task-tag-popover, .add-long-tag')) {
      closeLongTaskTagPopover();
    }
  }, true);
  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && activeLongTaskTagPopoverId) {
      closeLongTaskTagPopover(true);
    }
  });
  window.addEventListener('resize', () => closeLongTaskTagPopover());
}

function renderMonthCalendar(root) {
  if (!root) {
    return;
  }
  root.querySelector('.month-header')?.replaceWith(createMonthHeader(root));
  root.querySelector('.month-calendar')?.replaceWith(createCalendarGrid(root));
}

function bindDayUpdateHandler(root) {
  if (isDayUpdateHandlerBound) {
    return;
  }

  isDayUpdateHandlerBound = true;
  const refreshUpdatedDay = async (event) => {
    const dateKey = event?.payload?.date || event?.detail?.date;
    if (!dateKey || getMonthKeyFromDateKey(dateKey) !== currentMonthKey) {
      return;
    }
    await reloadMonthDay(root, dateKey);
  };

  if (window.__TAURI__?.event?.listen) {
    window.__TAURI__.event.listen('calendar://day-updated', refreshUpdatedDay);
  }
  window.addEventListener('calendar://day-updated', refreshUpdatedDay);
  window.addEventListener('storage', event => {
    if (event.key?.startsWith('desktop-calendar:day:')) refreshUpdatedDay({ detail: { date: event.key.slice('desktop-calendar:day:'.length) } });
  });
}

function bindThemeUpdateHandler(root) {
  if (isThemeUpdateHandlerBound) {
    return;
  }

  isThemeUpdateHandlerBound = true;
  const refreshTheme = (event) => {
    applyThemeSettings(event?.payload?.settings || event?.detail?.settings || loadThemeSettings());
    renderMonthView(root);
  };

  if (window.__TAURI__?.event?.listen) {
    window.__TAURI__.event.listen('calendar://theme-updated', refreshTheme);
  }
  window.addEventListener('calendar://theme-updated', refreshTheme);
}

function bindStorageUpdateHandler(root) {
  if (isStorageUpdateHandlerBound) {
    return;
  }

  isStorageUpdateHandlerBound = true;
  const refreshStorage = async () => {
    reminderCenter.refresh();
    await Promise.all([loadMonth(root), loadLongTaskPanel(root)]);
  };

  if (window.__TAURI__?.event?.listen) {
    window.__TAURI__.event.listen('calendar://storage-updated', refreshStorage);
  }
  window.addEventListener('calendar://storage-updated', refreshStorage);
}

function bindTagTemplateUpdateHandler(root) {
  if (isTagTemplateUpdateHandlerBound) {
    return;
  }

  isTagTemplateUpdateHandlerBound = true;
  const refreshTagTemplates = async () => {
    try {
      tagTemplates = await loadTagTemplates();
      renderMonthView(root);
    } catch (error) {
      console.error(error);
    }
  };

  if (window.__TAURI__?.event?.listen) {
    window.__TAURI__.event.listen('calendar://tag-templates-updated', refreshTagTemplates);
  }
  window.addEventListener('calendar://tag-templates-updated', refreshTagTemplates);
  window.addEventListener('storage', (event) => {
    if (event.key === 'desktop-calendar:tag-templates') refreshTagTemplates();
  });
}

async function reloadMonthDay(root, dateKey) {
  try {
    const day = await loadDay(dateKey);
    const nextDays = new Map(monthDays);
    nextDays.set(dateKey, normalizeMonthDay(day, dateKey));
    monthDays = nextDays;
    renderMonthView(root);
  } catch (error) {
    console.error(error);
  }
}

async function openDayWindow(dateKey) {
  try { await openDay(dateKey); } catch (error) { console.error(error); }
}
