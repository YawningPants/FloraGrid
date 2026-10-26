import { taskColorInk } from '../domain/color-ink.mjs';
import { registerDataTransferParticipant, isDataTransferBusy } from '../ui/data-transfer-participant.mjs';
import { getDayDisplayMeta, getTodayDateKey, shiftDateKey } from '../domain/date.mjs';
import { ensureTaskFlower, getTaskFlower } from '../domain/flowers.mjs';
import { canPresentTaskTags } from '../domain/task-presentation.mjs';
import { recordTaskCompletion } from '../domain/header-garden.mjs';
import { getPersistableTasks } from '../domain/task-snapshot.mjs';
import {
  cloneTemplateAsSnapshot,
  createTagSnapshot,
  getTagColor as getSnapshotTagColor,
  getTagText,
  normalizeTagTemplates,
  normalizeTaskTags,
  pickUnusedColor,
  tagColors,
  legacyTagPalette,
} from '../domain/tags.mjs';
import { applyThemeSettings, loadThemeSettings } from '../domain/theme.mjs';
import {
  canAcceptChildTask,
  canEditTask,
  canMoveTask as canMoveTaskByState,
  createBlankTask,
  failActiveDescendants,
  findTask,
  flattenTasks,
  getTaskLocation,
  getVisibleTaskTree as getVisibleTaskTreeByState,
  hasActiveDescendant,
  normalizeSearchQuery,
  normalizeTaskTree,
  removeTask,
  reopenCompletedAncestors,
  taskStatusMeta,
} from '../domain/tasks.mjs';
import { canPasteToDate, copyTask, createPastedTaskFromClipboard } from '../domain/task-clipboard.mjs';
import { flushDaySave, getDayStorageOriginId, loadDay, scheduleSaveDay } from '../storage/day-storage.mjs';
import { loadTagTemplates } from '../storage/tag-template-storage.mjs';
import { appendHighlightedText, el, escapeHtml, truncateText } from '../ui/dom.mjs';
import { icon } from '../ui/icons.mjs';
import {
  botanicalMotionEnabled,
  completionFeedbackDurationMs,
  completionMarkup,
  createBotanicalEmpty,
  markNewShoot,
  sproutMarkup,
} from '../ui/botanical.mjs';
import { showNotice } from '../ui/notice.mjs';
import { createHeaderGarden } from '../ui/header-garden.mjs';
import { createScrollRegion, disposeScrollRegion } from '../ui/scroll-region.mjs';
import { applyTagLineReserve, applyTreeBranchLayout, queueTaskTreeLayout } from '../ui/task-tree-layout.mjs';
import { createTaskDragController } from '../ui/task-drag-controller.mjs';
import { createWindowTitleBar } from '../ui/window-titlebar.mjs';
import { ensureReminders } from '../storage/reminder-service.mjs';
import { markMovedReminders } from '../domain/reminders.mjs';
import { openDay, openMonth, bindCalendarNavigation } from '../ui/calendar-navigation.mjs';
import { openSettingsWindow as openSharedSettingsWindow } from '../ui/settings-window.mjs';

let currentDay = createEmptyDay(getTodayDateKey());
let taskState = currentDay.tasks;
let editingTaskId = null;
let draftTaskId = null;
let taskDragController = null;
let showDeletedTasks = false;
let isSearchOpen = false;
let searchQuery = '';
let dailyNoteText = currentDay.note;
let dailyNoteHeight = 112;
let isDailyNoteExpanded = false;
let isGlobalEscapeShortcutBound = false;
let isBeforeUnloadFlushBound = false;
let isExitRequestHandlerBound = false;
let isTagTemplateUpdateHandlerBound = false;
let isThemeUpdateHandlerBound = false;
let isStorageUpdateHandlerBound = false;
let isDayUpdateHandlerBound = false;
let isDayLoading = true;
let loadErrorMessage = '';
let tagTemplates = normalizeTagTemplates(null);
let activeTagPopoverTaskId = null;
let activeTagPopoverAnchor = null;
let activeTagGroupPage = 0;
let activeTagGroupId = tagTemplates.groups[0]?.id || null;
let temporaryTagText = '';
let temporaryTagColor = tagColors[0];
let themeSettings = applyThemeSettings(loadThemeSettings());
let isAlwaysOnTop = false;
let isTagPopoverViewportHandlerBound = false;
let isTagPopoverOutsideHandlerBound = false;
let taskContextMenu = null;
let taskColorPalette = null;
let isTaskColorPaletteHandlerBound = false;
let initialDayClaim = Promise.resolve();
let daySwitchInFlight = false;
let dayWindowRetired = false;
let dayHandoffId = null;
let pendingReveal = null;
let dayRefreshPending = false;
const pendingCompletions = new Map();
const completionMoves = new Set();
let completionSettleTimer = 0;
const childrenAnimations = new Map();
let isReplacingTaskArea = false;
let headerGarden = null;
const TAG_GROUP_VISIBLE_CHARS = 5;
const TAG_GROUP_MIN_WIDTH = 34;
const TAG_GROUP_MAX_WIDTH = 90;
const TAG_GROUP_PAGER_FALLBACK_WIDTH = 286;
const TAG_POPOVER_WIDTH = 320;
const TAG_POPOVER_MARGIN = 12;
const TAG_POPOVER_GAP = 8;
const taskColors = tagColors;
const taskColorNames = ['浅蓝', '淡紫', '柔粉', '暖橙', '沙黄', '草绿', '青绿', '蓝灰'];

export function createDayView(options = {}) {
  headerGarden?.destroy();
  applyThemeSettings(themeSettings);
  resetDayViewState(options.date);
  daySwitchInFlight = false;
  dayWindowRetired = false;
  dayHandoffId = null;
  const root = el('section', 'day-window');
  initialDayClaim = bindDayWindowHandoff(root)
    .then(() => claimDayWindowDate(currentDay.date))
    .catch(console.error);
  root.append(
    createTitleBar(),
    createHeader(root),
    createToolbar(root),
    createTaskScrollRegion(taskState),
    createNotes(),
    createTagPopoverLayer(),
  );
  headerGarden = createHeaderGarden(root, {
    getItems: () => taskState,
    getDate: () => currentDay.date,
    getSettings: () => themeSettings,
    isLoading: () => isDayLoading,
    onActivityChange: (active) => handleDayActivity(root, active),
  });
  taskDragController = createTaskDragController({
    root,
    getItems: () => taskState,
    getOptions: () => ({ showDeletedTasks, searchQuery }),
    getList: () => root.querySelector('.task-list'),
    getTree: () => root.querySelector('.task-tree'),
    rowSelector: '.task-row',
    canStart: () =>
      !editingTaskId &&
      !isDayLoading &&
      !pendingCompletions.size &&
      !root.querySelector('.children.is-animating'),
    createPreview: (task, target, items) =>
      createTaskNode(task, target.depth, getPreviewParentTags(items, target.parentId) || []),
    afterLayout: () => {
      applyTagLineReserve(root);
      applyTreeBranchLayout(root);
    },
    onPrepare: () => {
      cancelCompletionMoves();
      closeTaskContextMenu();
      closeTaskColorPalette();
      closeTagPopover();
      renderTagPopoverOnly(root);
    },
    onCommit: (items) => {
      taskState = markMovedReminders(taskState, items);
      persistCurrentDaySoon();
      renderDayView(root);
    },
  });
  bindGlobalEscapeShortcut();
  bindFlushBeforeExit();
  bindExitRequestHandler();
  bindTagTemplateUpdateHandler(root);
  bindDayUpdateHandler(root);
  registerDataTransferParticipant({
    root,
    prepare: async () => {
      if (isDayLoading || daySwitchInFlight || dayHandoffId)
        throw new Error('日视图正在切换日期，请稍后重试');
      if (loadErrorMessage) throw new Error('日视图数据尚未正确加载，请先重新打开该窗口');
      taskDragController?.cancel();
      document.activeElement?.blur?.();
      await flushDaySave();
    },
    reload: async () => {
      editingTaskId = null;
      await reloadCurrentStorage(root);
    },
  });
  bindThemeUpdateHandler(root);
  bindStorageUpdateHandler(root);
  bindTagPopoverViewportHandlers();
  bindTagPopoverOutsideHandler();
  bindTaskColorPaletteHandlers();
  window.addEventListener('calendar://save-error', () =>
    showToast('保存失败，修改仍保留在当前窗口，请稍后重试'),
  );
  bindCalendarNavigation((target) => {
    if ((target.taskId || target.note) && (!target.date || target.date === currentDay.date)) {
      pendingReveal = target;
      if (!isDayLoading) revealSearchTarget(root);
    }
  });
  bindTagPopoverScrollHandler(root);
  queueTaskTreeLayout(root);
  loadCurrentDay(root);
  return root;
}

function createTitleBar() {
  return createWindowTitleBar({
    title: '日视图',
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
          showToast('置顶窗口失败');
        }
      },
    },
    onMinimize: () => {
      headerGarden?.pause();
      flushDaySave();
      window.calendarShell?.minimize();
    },
    onClose: async () => {
      await flushDaySave();
      window.calendarShell?.close();
    },
  });
}

function createHeader(root) {
  const header = el('section', 'day-header');
  const dayMeta = getDayDisplayMeta(currentDay.date);
  const subtitleMarkup = loadErrorMessage
    ? `<p class="day-load-error">${escapeHtml(loadErrorMessage)}</p>`
    : `
        <div class="day-date-nav" aria-label="日期切换">
          <button class="date-nav-button previous-day" type="button" title="前一天" aria-label="前一天">‹</button>
          <span class="day-date-text">${escapeHtml(dayMeta.subtitle)}</span>
          <button class="date-nav-button next-day" type="button" title="后一天" aria-label="后一天">›</button>
          ${currentDay.date === getTodayDateKey() ? '' : `<button class="current-date-button day-current-button" type="button" title="回到今日" aria-label="回到今日">${icon('restore')}</button>`}
        </div>
      `;
  header.innerHTML = `
    <div class="day-heading">
      <div>
        <h1>${dayMeta.title}</h1>
        ${subtitleMarkup}
      </div>
      <div class="header-actions">
        <button class="header-tool month-view-toggle" type="button" aria-label="月视图">${icon('calendar')}<span class="header-tool-label" aria-hidden="true">月视图</span></button>
        <button class="header-tool search-toggle${isSearchOpen ? ' is-active' : ''}" type="button" aria-label="搜索" aria-pressed="${isSearchOpen}">${icon('search')}<span class="header-tool-label" aria-hidden="true">搜索</span></button>
        <button class="header-tool settings-toggle" type="button" aria-label="设置">${icon('settings')}<span class="header-tool-label" aria-hidden="true">设置</span></button>
      </div>
    </div>
    ${isSearchOpen ? '<input class="task-search-input" type="search" placeholder="搜索任务名称" aria-label="搜索任务名称" />' : ''}
  `;
  header.querySelector('.search-toggle')?.addEventListener('click', () => {
    isSearchOpen = !isSearchOpen;
    if (!isSearchOpen) {
      searchQuery = '';
    }
    renderDayView(root);
  });
  header.querySelector('.settings-toggle')?.addEventListener('click', () => {
    openSettingsWindow();
  });
  header.querySelector('.month-view-toggle')?.addEventListener('click', () => {
    openMonthWindow();
  });
  header.querySelector('.previous-day')?.addEventListener('click', () => {
    switchDay(root, -1);
  });
  header.querySelector('.next-day')?.addEventListener('click', () => {
    switchDay(root, 1);
  });
  header.querySelector('.day-current-button')?.addEventListener('click', () => {
    switchToDay(root, getTodayDateKey());
  });
  const input = header.querySelector('.task-search-input');
  if (input) {
    input.value = searchQuery;
    input.addEventListener('input', () => {
      searchQuery = input.value;
      renderTaskAreaOnly(root);
    });
    input.addEventListener('blur', () => {
      window.setTimeout(() => {
        if (!searchQuery.trim()) {
          isSearchOpen = false;
          renderDayView(root);
        }
      }, 0);
    });
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        isSearchOpen = false;
        searchQuery = '';
        renderDayView(root);
      }
    });
    queueMicrotask(() => input.focus({ preventScroll: true }));
  }
  return header;
}

function resetDayViewState(dateKey = getTodayDateKey()) {
  currentDay = createEmptyDay(dateKey || getTodayDateKey());
  taskState = currentDay.tasks;
  editingTaskId = null;
  draftTaskId = null;
  taskDragController?.cancel();
  isSearchOpen = false;
  searchQuery = '';
  dailyNoteText = currentDay.note;
  isDayLoading = true;
  isDailyNoteExpanded = false;
  loadErrorMessage = '';
  activeTagPopoverTaskId = null;
  activeTagPopoverAnchor = null;
  temporaryTagText = '';
}

function createToolbar(root) {
  const toolbar = el('section', 'day-toolbar');
  toolbar.innerHTML = `
    <button class="add-root">${icon('plus')}<span>新建任务</span></button>
    <button class="deleted-toggle" type="button" aria-pressed="${showDeletedTasks}">
      <span>显示已删除：${showDeletedTasks ? '开' : '关'}</span>
      <span class="switch${showDeletedTasks ? ' is-on' : ''}"></span>
    </button>
  `;
  toolbar.querySelector('.add-root')?.addEventListener('click', () => {
    addRootTask(root);
  });
  toolbar.querySelector('.deleted-toggle')?.addEventListener('click', () => {
    showDeletedTasks = !showDeletedTasks;
    renderDayView(root);
  });
  return toolbar;
}

function createTaskScrollRegion(items) {
  const list = createTaskList(items);
  const summary = list.querySelector('.status-summary');
  summary?.remove();
  const region = createScrollRegion(list, {
    className: 'task-scroll-region',
    label: '任务',
    topInset: () => summary?.offsetHeight || 0,
  });
  if (summary) region.prepend(summary);
  return region;
}

function createTaskList(items) {
  const list = el('section', 'task-list');
  if (isDayLoading) {
    const loading = el('div', 'search-empty');
    loading.textContent = '正在读取今天的数据...';
    list.append(loading);
    return list;
  }

  list.append(createStatusSummary(items));
  list.addEventListener('contextmenu', (event) => {
    if (event.target.closest('.task-row, input, textarea, select, [contenteditable="true"]')) {
      return;
    }
    openTaskListContextMenu(event);
  });
  const tree = el('div', 'task-tree');
  const visibleTasks = getVisibleTaskTree(items);
  visibleTasks.forEach((task) => tree.append(createTaskNode(task, 0, [])));
  if (getNormalizedSearchQuery() && visibleTasks.length === 0) {
    const empty = el('div', 'search-empty');
    empty.textContent = '没有找到相关任务';
    tree.append(empty);
  } else if (visibleTasks.length === 0) {
    tree.append(createBotanicalEmpty('留一点空白，也很好', '从一件小事开始，或记下今天的想法。'));
  }
  list.append(tree);
  return list;
}

function createStatusSummary(items) {
  const counts = flattenTasks(items).reduce(
    (acc, task) => {
      acc[task.status] += 1;
      return acc;
    },
    { active: 0, completed: 0, failed: 0, deleted: 0 },
  );

  const summary = el('div', 'status-summary');
  Object.entries(counts).forEach(([status, count]) => {
    summary.dataset[status] = count;
  });
  summary.innerHTML = `
    <span>${taskStatusMeta.active.label} ${counts.active}</span>
    <span>${taskStatusMeta.completed.label} ${counts.completed}</span>
    <span>${taskStatusMeta.failed.label} ${counts.failed}</span>
    <span>${taskStatusMeta.deleted.label} ${counts.deleted}</span>
  `;
  return summary;
}

function updateCompletionSummary(root, previousStatus, nextStatus) {
  const summary = root.querySelector('.status-summary');
  if (!summary) return;
  for (const [status, delta] of [
    [previousStatus, -1],
    [nextStatus, 1],
  ]) {
    const count = Math.max(0, Number(summary.dataset[status]) + delta);
    summary.dataset[status] = count;
    const index = ['active', 'completed', 'failed', 'deleted'].indexOf(status);
    summary.children[index].textContent = `${taskStatusMeta[status].label} ${count}`;
  }
}

function createTaskNode(task, depth, inheritedTags) {
  const inherited = [...inheritedTags, ...task.tags];
  const visibleTags = depth > 0 ? [...inheritedTags, ...task.tags] : task.tags;
  const hasChildren = Boolean(task.children?.length);
  const isCollapsed = hasChildren && task.collapsed;
  const wrapper = el(
    'article',
    `task-node depth-${Math.min(depth, 3)}${hasChildren ? ' has-children' : ''}${isCollapsed ? ' is-collapsed' : ''}`,
  );
  wrapper.classList.toggle('is-completed-branch', hasChildren && task.status === 'completed');
  wrapper.style.setProperty('--depth', depth);
  const row = createTaskRow(task, depth, visibleTags);
  const branch = el('div', 'tree-branch');
  branch.append(el('span', `tree-leaf-node${hasChildren ? ' has-children' : ''}`));
  wrapper.append(branch, row);
  updateRootTaskFrame(row, task);

  if (hasChildren) {
    const children = el('div', `children${isCollapsed ? ' is-collapsed' : ''}`);
    getVisibleTaskTree(task.children).forEach((child) =>
      children.append(createTaskNode(child, depth + 1, inherited)),
    );
    if (children.childElementCount > 0) wrapper.append(children);
  }
  return wrapper;
}

function createTaskRow(task, depth, visibleTags) {
  const hasChildren = Boolean(task.children?.length);
  const isCollapsed = hasChildren && task.collapsed;
  const row = el(
    'div',
    `task-row is-${task.status}${task.color ? ' has-custom-color' : ''}${task.long ? ' is-large' : ''}${task.id === editingTaskId ? ' is-editing' : ''}${activeTagPopoverTaskId === task.id ? ' has-tag-popover' : ''}${hasChildren ? ' has-children' : ''}${isCollapsed ? ' is-collapsed' : ''}`,
  );
  row.classList.toggle('is-reminder', Boolean(task.reminder));
  row.classList.toggle('is-pinned-task', Boolean(task.pinned));
  row.dataset.taskId = task.id;
  row.dataset.depth = String(depth);
  row.style.setProperty('--depth', depth);
  row.style.setProperty('--accent', getTaskAccentColor(task));
  row.style.setProperty('--accent-ink', task.color ? taskColorInk(task.color) : 'var(--ink,var(--text))');
  row.addEventListener('pointerleave', () => {
    const focused = document.activeElement;
    if (row.contains(focused) && focused.matches('button:not(:focus-visible)')) focused.blur();
  });

  row.append(
    createDragHandle(task),
    createStatusButton(task, depth),
    createTaskBody(task, visibleTags, depth),
  );
  const actions = createTaskActions(task, depth);
  if (hasChildren || actions.childElementCount || canColorTask(task)) {
    const controls = el('div', 'task-row-controls');
    controls.append(actions, createTaskColorButton(task));
    row.querySelector('.task-meta-row').append(controls);
  }
  if (hasChildren) row.append(createCollapseToggle(task));
  if (task.reminder) {
    const badge = el('button', 'reminder-task-badge');
    badge.type = 'button';
    badge.innerHTML = icon(
      task.kind === 'birthday' ? 'cake' : task.kind === 'anniversary' ? 'heart' : 'bell',
    );
    badge.title = `管理提醒 · ${task.reminder.schedule || ''}`;
    badge.setAttribute('aria-label', badge.title);
    badge.onclick = () =>
      openMonth({ panel: 'reminders', ruleId: task.reminder.ruleId }).catch(console.error);
    row.querySelector('.task-body').prepend(badge);
  }
  if (canMoveTask(task)) {
    row.querySelector('.drag-handle')?.addEventListener('pointerdown', (event) => {
      taskDragController?.start(event, task.id, row);
    });
  }
  if (canDeleteTask(task)) {
    row.addEventListener('contextmenu', (event) => {
      openTaskContextMenu(event, task);
    });
  }
  return row;
}

function createCollapseToggle(task) {
  const button = el('button', 'collapse-toggle');
  const childCount = task.children?.length || 0;
  button.type = 'button';
  button.innerHTML = '<span class="collapse-icon" aria-hidden="true"></span>';
  button.title = task.collapsed ? `展开 ${childCount} 个子任务` : `折叠 ${childCount} 个子任务`;
  button.setAttribute('aria-label', button.title);
  button.setAttribute('aria-expanded', String(!task.collapsed));
  button.dataset.count = String(childCount);
  button.addEventListener('click', (event) => {
    event.stopPropagation();
    toggleTaskCollapse(task.id);
  });
  return button;
}

function createDragHandle(task) {
  if (!canMoveTask(task)) {
    const spacer = el('span', 'drag-handle-spacer');
    spacer.setAttribute('aria-hidden', 'true');
    return spacer;
  }

  const handle = el('button', 'drag-handle');
  handle.type = 'button';
  handle.setAttribute('aria-label', `拖拽任务：${task.title || '未命名任务'}`);
  handle.title = '拖拽任务';
  handle.innerHTML = '<span></span><span></span><span></span><span></span><span></span><span></span>';
  return handle;
}

function createStatusButton(task, depth) {
  const button = el('button', `status-button ${task.status}`);
  button.dataset.taskRole = depth === 0 ? 'root' : 'leaf';
  button.type = 'button';
  button.setAttribute('aria-label', taskStatusMeta[task.status].label);
  if (task.status === 'completed') button.innerHTML = completionMarkup(task);
  else button.textContent = taskStatusMeta[task.status].symbol;
  if (task.status === 'active' || task.status === 'completed') {
    button.title = task.status === 'active' ? '标记完成' : '改为进行中';
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      toggleTaskCompletion(task.id);
    });
  }
  return button;
}

function createTaskBody(task, visibleTags, depth) {
  // Preserve the full tag snapshot and inherited-tag implementation for re-enabling.
  const displayTags = canPresentTaskTags(depth) ? visibleTags : [];
  const body = el('div', 'task-body');
  const title = task.id === editingTaskId ? createTaskTitleInput(task) : createTaskTitleText(task);
  const tags = el('div', 'tag-list');
  const inheritedTagCount = visibleTags.length - task.tags.length;

  displayTags.forEach((tag, index) => {
    const chip = el('span', 'tag-chip');
    const isInherited = index < inheritedTagCount;
    chip.classList.toggle('is-inherited', isInherited);
    chip.style.setProperty('--tag-color', getSnapshotTagColor(tag, '#9aa8b5'));
    chip.style.setProperty('--tag-ink', taskColorInk(chip.style.getPropertyValue('--tag-color')));
    chip.append(document.createTextNode(getTagText(tag)));
    if (isInherited) {
      const marker = el('span', 'tag-inherited-mark');
      marker.textContent = '继承';
      chip.append(marker);
    }
    if (!isInherited && canEditTask(task)) {
      const remove = el('button', 'tag-remove');
      remove.type = 'button';
      remove.title = '移除标签';
      remove.setAttribute('aria-label', '移除标签');
      remove.textContent = '×';
      remove.addEventListener('click', (event) => {
        event.stopPropagation();
        removeTaskTag(task, tag.id);
      });
      chip.append(remove);
    }
    tags.append(chip);
  });
  body.append(title);
  const meta = el('div', 'task-meta-row');
  if (displayTags.length > 0) {
    meta.append(tags);
  }
  body.append(meta);
  return body;
}

function createTagAddButton(task) {
  const button = el('button', 'action-button tag-add-button');
  button.type = 'button';
  button.title = '添加标签';
  button.setAttribute('aria-label', '添加标签');
  button.innerHTML = icon('tag');
  button.addEventListener('click', (event) => {
    event.stopPropagation();
    closeTaskColorPalette();
    const shouldClose = activeTagPopoverTaskId === task.id;
    activeTagPopoverTaskId = shouldClose ? null : task.id;
    activeTagPopoverAnchor = shouldClose ? null : getTagPopoverAnchor(event.currentTarget);
    renderTagPopoverOnly(document.querySelector('.day-window'));
  });
  return button;
}

function createTagPopoverLayer() {
  const layer = el('div', 'tag-popover-layer');
  const task = activeTagPopoverTaskId ? findTask(taskState, activeTagPopoverTaskId) : null;
  if (!task || !activeTagPopoverAnchor) {
    if (activeTagPopoverTaskId && !task) {
      closeTagPopover();
    }
    return layer;
  }

  const popover = createTagPopover(task);
  layer.classList.add('is-open');
  layer.append(popover);
  applyTagPopoverPosition(popover, activeTagPopoverAnchor);
  // The layer is assembled off-DOM; measure again once it has real dimensions.
  queueMicrotask(() => {
    if (popover.isConnected && activeTagPopoverAnchor)
      applyTagPopoverPosition(popover, activeTagPopoverAnchor);
  });
  return layer;
}

function getTagPopoverAnchor(button) {
  const rect = button.getBoundingClientRect();
  return {
    left: rect.left,
    right: rect.right,
    top: rect.top,
    bottom: rect.bottom,
    width: rect.width,
    height: rect.height,
  };
}

function applyTagPopoverPosition(popover, anchor) {
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const width = Math.min(TAG_POPOVER_WIDTH, Math.max(240, viewportWidth - TAG_POPOVER_MARGIN * 2));
  popover.style.width = `${width}px`;
  popover.style.maxHeight = `${Math.max(220, viewportHeight - TAG_POPOVER_MARGIN * 2)}px`;

  const height = popover.getBoundingClientRect().height;
  const preferredLeft = anchor.right - width;
  const left = clamp(preferredLeft, TAG_POPOVER_MARGIN, viewportWidth - width - TAG_POPOVER_MARGIN);
  const belowTop = anchor.bottom + TAG_POPOVER_GAP;
  const aboveTop = anchor.top - height - TAG_POPOVER_GAP;
  const hasRoomBelow = belowTop + height <= viewportHeight - TAG_POPOVER_MARGIN;
  const top = hasRoomBelow
    ? belowTop
    : clamp(aboveTop, TAG_POPOVER_MARGIN, viewportHeight - height - TAG_POPOVER_MARGIN);

  popover.style.left = `${left}px`;
  popover.style.top = `${top}px`;
}

function closeTagPopover() {
  activeTagPopoverTaskId = null;
  activeTagPopoverAnchor = null;
}

function clamp(value, min, max) {
  if (max < min) {
    return min;
  }
  return Math.min(max, Math.max(min, value));
}

function createTagPopover(task) {
  const popover = el('section', 'tag-popover');
  popover.innerHTML = `
    <div class="tag-popover-head">
      <h3>添加标签</h3>
      <button class="icon-button tag-popover-close" type="button" title="关闭" aria-label="关闭">×</button>
    </div>
    <div class="tag-popover-section">
      <label>临时标签</label>
      <div class="tag-create-row">
        <input class="tag-create-input" type="text" value="${escapeHtml(temporaryTagText)}" placeholder="输入标签名" aria-label="输入标签名" />
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
    closeTagPopover();
    renderTagPopoverOnly(document.querySelector('.day-window'));
  });

  const input = popover.querySelector('.tag-create-input');
  const submit = popover.querySelector('.tag-create-submit');
  const submitTemporaryTag = () => {
    const text = input.value.trim();
    if (!text) {
      return;
    }
    temporaryTagText = '';
    addTagToTask(task, createTagSnapshot(text, temporaryTagColor, 'custom'));
  };
  submit?.addEventListener('click', submitTemporaryTag);
  input?.addEventListener('input', () => {
    temporaryTagText = input.value;
  });
  input?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      submitTemporaryTag();
    }
    if (event.key === 'Escape') {
      event.stopPropagation();
      closeTagPopover();
      renderTagPopoverOnly(document.querySelector('.day-window'));
    }
  });

  const colorRow = popover.querySelector('.tag-color-row');
  tagColors.forEach((color) => {
    const swatch = el('button', `tag-color-swatch${temporaryTagColor === color ? ' is-selected' : ''}`);
    swatch.type = 'button';
    swatch.style.setProperty('--swatch', color);
    swatch.style.setProperty('--swatch-ink', taskColorInk(swatch.style.getPropertyValue('--swatch')));
    swatch.setAttribute('aria-label', `选择颜色 ${color}`);
    swatch.addEventListener('click', () => {
      temporaryTagColor = color;
      updateTemporaryColorSelection(colorRow);
    });
    colorRow.append(swatch);
  });

  renderTagGroupPager(popover.querySelector('.tag-group-pager'));
  renderTemplateTags(popover.querySelector('.tag-template-list'), task);

  popover.querySelector('.tag-manage-link')?.addEventListener('click', () => {
    closeTagPopover();
    renderTagPopoverOnly(document.querySelector('.day-window'));
    openTagManagerWindow();
  });

  queueMicrotask(() => {
    renderTagGroupPager(popover.querySelector('.tag-group-pager'));
    renderTemplateTags(popover.querySelector('.tag-template-list'), task);
    input?.focus({ preventScroll: true });
  });
  return popover;
}

function updateTemporaryColorSelection(colorRow) {
  colorRow.querySelectorAll('.tag-color-swatch').forEach((swatch) => {
    swatch.classList.toggle('is-selected', swatch.style.getPropertyValue('--swatch') === temporaryTagColor);
  });
}

function renderTagGroupPager(container) {
  const groups = tagTemplates.groups;
  const pages = getTagGroupPages(container);
  const pageCount = pages.length;
  syncActiveTagGroupPage(pages);
  const pageGroups = pages[activeTagGroupPage] || [];
  container.replaceChildren();

  const prev = el('button', 'tag-page-button');
  prev.type = 'button';
  prev.textContent = '‹';
  prev.disabled = activeTagGroupPage === 0;
  prev.addEventListener('click', () => {
    activeTagGroupPage -= 1;
    activeTagGroupId = pages[activeTagGroupPage]?.[0]?.id || activeTagGroupId;
    renderTagPopoverOnly(document.querySelector('.day-window'));
  });
  container.append(prev);

  pageGroups.forEach((group) => {
    const button = el('button', `tag-group-tab${activeTagGroupId === group.id ? ' is-active' : ''}`);
    button.type = 'button';
    button.textContent = getVisibleTagGroupName(group.name);
    button.title = group.name;
    button.style.setProperty('--tag-group-width', `${getTagGroupTabWidth(group.name)}px`);
    button.addEventListener('click', () => {
      activeTagGroupId = group.id;
      renderTagPopoverOnly(document.querySelector('.day-window'));
    });
    container.append(button);
  });

  const next = el('button', 'tag-page-button');
  next.type = 'button';
  next.textContent = '›';
  next.disabled = activeTagGroupPage >= pageCount - 1;
  next.addEventListener('click', () => {
    activeTagGroupPage += 1;
    activeTagGroupId = pages[activeTagGroupPage]?.[0]?.id || activeTagGroupId;
    renderTagPopoverOnly(document.querySelector('.day-window'));
  });
  container.append(next);

  const counter = el('span', 'tag-page-counter');
  counter.textContent = `${activeTagGroupPage + 1}/${pageCount}`;
  container.append(counter);
}

function getTagGroupPages(container) {
  if (!tagTemplates.groups.length) {
    return [[]];
  }

  const containerWidth = getTagGroupPagerWidth(container);
  const fixedWidth = 24 + 24 + 30;
  const baseGapWidth = 5 * 3;
  const itemGapWidth = 5;
  const availableWidth = Math.max(0, containerWidth - fixedWidth - baseGapWidth);
  const pages = [];
  let page = [];
  let usedWidth = 0;

  tagTemplates.groups.forEach((group) => {
    const width = getTagGroupTabWidth(group.name);
    const nextWidth = usedWidth + width + (page.length ? itemGapWidth : 0);
    if (page.length && nextWidth > availableWidth) {
      pages.push(page);
      page = [];
      usedWidth = 0;
    }
    page.push(group);
    usedWidth += width + (page.length > 1 ? itemGapWidth : 0);
  });

  if (page.length) {
    pages.push(page);
  }
  return pages.length ? pages : [[]];
}

function getTagGroupPagerWidth(container) {
  return (
    container?.getBoundingClientRect().width ||
    container?.closest('.tag-popover')?.getBoundingClientRect().width ||
    TAG_GROUP_PAGER_FALLBACK_WIDTH
  );
}

function syncActiveTagGroupPage(pages) {
  const activePageIndex = pages.findIndex((page) => page.some((group) => group.id === activeTagGroupId));
  if (activePageIndex >= 0) {
    activeTagGroupPage = activePageIndex;
    return;
  }
  activeTagGroupPage = Math.min(activeTagGroupPage, pages.length - 1);
}

function getVisibleTagGroupName(name) {
  return Array.from(name).slice(0, TAG_GROUP_VISIBLE_CHARS).join('');
}

function getTagGroupTabWidth(name) {
  const visibleName = getVisibleTagGroupName(name);
  const textWidth = Array.from(visibleName).reduce((width, char) => {
    return width + (/[\u4e00-\u9fff]/.test(char) ? 14 : 8);
  }, 0);
  return Math.min(TAG_GROUP_MAX_WIDTH, Math.max(TAG_GROUP_MIN_WIDTH, textWidth + 18));
}

function renderTemplateTags(container, task) {
  container.replaceChildren();
  const group = getActiveTagGroup();
  if (!group?.tags?.length) {
    const empty = el('div', 'tag-template-empty');
    empty.textContent = '该分组暂无长期标签';
    container.append(empty);
    return;
  }

  group.tags.forEach((template) => {
    const button = el('button', 'tag-template-button');
    button.type = 'button';
    button.style.setProperty('--tag-color', template.color);
    button.style.setProperty('--tag-ink', taskColorInk(button.style.getPropertyValue('--tag-color')));
    button.textContent = template.text;
    button.addEventListener('click', () => {
      addTagToTask(task, cloneTemplateAsSnapshot(template));
    });
    container.append(button);
  });
}

function addTagToTask(task, tag) {
  task.tags ||= [];
  task.tags.push(tag);
  closeTagPopover();
  persistCurrentDaySoon();
  renderDayView(document.querySelector('.day-window'));
}

function removeTaskTag(task, tagId) {
  task.tags = (task.tags || []).filter((tag) => tag.id !== tagId);
  persistCurrentDaySoon();
  renderDayView(document.querySelector('.day-window'));
}

function getActiveTagGroup() {
  if (!tagTemplates.groups.length) {
    return null;
  }

  const activeGroup = tagTemplates.groups.find((group) => group.id === activeTagGroupId);
  if (activeGroup) {
    return activeGroup;
  }

  activeTagGroupId = tagTemplates.groups[0].id;
  activeTagGroupPage = 0;
  return tagTemplates.groups[0];
}

async function openTagManagerWindow() {
  try {
    await openSharedSettingsWindow('tags');
  } catch (error) {
    console.error(error);
    showToast('打开长期标签管理失败');
  }
}

async function openMonthWindow() {
  try {
    await openMonth();
  } catch (error) {
    console.error(error);
    showToast('打开月视图失败');
  }
}

async function openSettingsWindow() {
  try {
    await openSharedSettingsWindow();
  } catch (error) {
    console.error(error);
    showToast('打开设置失败');
  }
}

function createTaskActions(task, depth) {
  const actions = el('div', `task-actions ${task.status === 'deleted' ? 'deleted-actions' : ''}`);

  if (task.status === 'deleted') {
    actions.append(
      actionButton('恢复', 'restore', '恢复', () => restoreTask(task.id)),
      actionButton('彻底删除', 'destroy', '彻底删除', () => destroyTask(task.id)),
    );
    return actions;
  }

  if (task.status === 'active') {
    actions.append(
      actionButton(icon('plus'), 'child', '新建子任务', () => addChildTask(task.id)),
      actionButton(icon('fail'), 'fail', '标记失败', () => failTask(task.id)),
    );
    if (canPresentTaskTags(depth))
      actions.insertBefore(createTagAddButton(task), actions.querySelector('.fail'));
  }
  if (task.status === 'failed') {
    actions.append(actionButton(icon('restore'), 'restore', '恢复进行中', () => restoreFailedTask(task.id)));
  }
  actions.append(actionButton(icon('trash'), 'delete', '删除', () => softDeleteTask(task.id)));
  actions.querySelector('.delete')?.remove();
  return actions;
}

function createTaskColorButton(task) {
  if (!canColorTask(task)) {
    const spacer = el('span', 'task-color-spacer');
    spacer.setAttribute('aria-hidden', 'true');
    return spacer;
  }

  const button = el('button', `task-color-button${task.color ? ' has-custom-color' : ''}`);
  const currentColor = getTaskAccentColor(task);
  button.type = 'button';
  button.style.setProperty('--task-color', currentColor);
  button.title = '选择任务颜色';
  button.setAttribute('aria-label', button.title);
  button.setAttribute('aria-haspopup', 'dialog');
  button.setAttribute('aria-expanded', 'false');
  button.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    event.stopPropagation();
  });
  button.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (taskColorPalette?.taskId === task.id) {
      closeTaskColorPalette();
      return;
    }
    closeTaskColorPalette();
    closeTaskContextMenu();
    closeTagPopover();
    renderTagPopoverOnly(document.querySelector('.day-window'));
    openTaskColorPalette(task, button, { keyboard: event.detail === 0 });
  });
  return button;
}

function canColorTask(task) {
  return task.status === 'active';
}

function setTaskColor(taskId, color) {
  const task = findTask(taskState, taskId);
  if (!task || !canColorTask(task) || (color !== null && !taskColors.includes(color))) {
    return;
  }

  if (color === null) {
    delete task.color;
  } else {
    task.color = color;
  }

  persistCurrentDaySoon();
  updateTaskColorInPlace(task);
}

function openTaskColorPalette(task, trigger, { keyboard = false, anchor = trigger } = {}) {
  const palette = el('section', 'task-color-palette');
  palette.setAttribute('role', 'dialog');
  palette.setAttribute('aria-label', '选择任务颜色');
  palette.innerHTML = '<div class="task-color-palette-grid"></div>';

  const grid = palette.querySelector('.task-color-palette-grid');
  taskColors.forEach((color, index) => {
    const button = el('button', `task-color-choice${task.color === color ? ' is-selected' : ''}`);
    button.type = 'button';
    button.title = taskColorNames[index];
    button.setAttribute('aria-label', `设为${taskColorNames[index]}`);
    button.setAttribute('aria-pressed', String(task.color === color));
    const swatch = el('span', 'task-color-choice-swatch');
    swatch.style.setProperty('--swatch', color);
    swatch.style.setProperty('--swatch-ink', taskColorInk(swatch.style.getPropertyValue('--swatch')));
    swatch.textContent = task.color === color ? '✓' : '';
    button.append(swatch);
    button.addEventListener('click', () => {
      setTaskColor(task.id, color);
      closeTaskColorPalette(taskColorPalette?.keyboard);
    });
    grid.append(button);
  });

  const noColor = el('button', `task-color-choice task-color-none${task.color ? '' : ' is-selected'}`);
  noColor.type = 'button';
  noColor.title = '不设颜色';
  noColor.setAttribute('aria-label', '不设颜色');
  noColor.setAttribute('aria-pressed', String(!task.color));
  noColor.innerHTML = '<span class="task-color-none-mark" aria-hidden="true"></span>';
  noColor.addEventListener('click', () => {
    setTaskColor(task.id, null);
    closeTaskColorPalette(taskColorPalette?.keyboard);
  });
  grid.append(noColor);

  document.body.append(palette);
  taskColorPalette = { taskId: task.id, element: palette, trigger, keyboard };
  palette.addEventListener('pointerdown', () => {
    if (taskColorPalette) taskColorPalette.keyboard = false;
  });
  palette.addEventListener('keydown', () => {
    if (taskColorPalette) taskColorPalette.keyboard = true;
  });
  trigger.setAttribute('aria-expanded', 'true');
  positionTaskColorPalette(palette, anchor);
  (palette.querySelector('.task-color-choice.is-selected') || noColor).focus({ preventScroll: true });
}

function positionTaskColorPalette(palette, trigger) {
  const margin = 10;
  const gap = 8;
  const anchor = trigger.getBoundingClientRect();
  const bounds = palette.getBoundingClientRect();
  const left = Math.max(
    margin,
    Math.min(anchor.right - bounds.width, window.innerWidth - bounds.width - margin),
  );
  const below = anchor.bottom + gap;
  const above = anchor.top - bounds.height - gap;
  const top = below + bounds.height <= window.innerHeight - margin ? below : Math.max(margin, above);
  palette.style.left = `${left}px`;
  palette.style.top = `${top}px`;
}

function closeTaskColorPalette(restoreFocus = false) {
  if (!taskColorPalette) {
    return;
  }
  const { element, trigger, taskId } = taskColorPalette;
  const focused = document.activeElement;
  taskColorPalette = null;
  element.remove();
  trigger.setAttribute('aria-expanded', 'false');
  if (restoreFocus && trigger.isConnected) {
    const returnTarget = trigger.getClientRects().length
      ? trigger
      : getTaskRow(taskId)?.querySelector('.status-button');
    returnTarget?.focus({ preventScroll: true });
  } else if (element.contains(focused) || getTaskRow(taskId)?.contains(focused)) {
    if (!focused?.matches('input,textarea,[contenteditable="true"]')) focused?.blur?.();
  }
}

function bindTaskColorPaletteHandlers() {
  if (isTaskColorPaletteHandlerBound) {
    return;
  }
  isTaskColorPaletteHandlerBound = true;
  document.addEventListener(
    'pointerdown',
    (event) => {
      const target = event.target instanceof Element ? event.target : null;
      if (
        taskColorPalette &&
        !taskColorPalette.element.contains(target) &&
        !target?.closest('.task-color-button')
      ) {
        closeTaskColorPalette();
      }
    },
    true,
  );
  window.addEventListener(
    'keydown',
    (event) => {
      if (event.key === 'Escape' && taskColorPalette) {
        event.preventDefault();
        event.stopPropagation();
        closeTaskColorPalette(true);
      }
    },
    true,
  );
  document.addEventListener(
    'scroll',
    (event) => {
      if (taskColorPalette && !taskColorPalette.element.contains(event.target)) {
        closeTaskColorPalette();
      }
    },
    true,
  );
  window.addEventListener('resize', () => closeTaskColorPalette());
  window.addEventListener('blur', () => closeTaskColorPalette());
}

function updateRootTaskFrame(row, task) {
  if (row.dataset.depth !== '0') return;
  const frame = row.closest('.task-node');
  if (!frame) return;
  if (task.color) {
    frame.style.setProperty('--group-accent', task.color);
    frame.style.setProperty('--group-ink', taskColorInk(task.color));
  } else {
    frame.style.removeProperty('--group-accent');
    frame.style.removeProperty('--group-ink');
  }
}

function updateTaskColorInPlace(task) {
  const row = getTaskRow(task.id);
  if (!row) {
    return;
  }

  const color = getTaskAccentColor(task);
  row.style.setProperty('--accent', color);
  row.style.setProperty('--accent-ink', task.color ? taskColorInk(task.color) : 'var(--ink,var(--text))');
  updateRootTaskFrame(row, task);
  row.classList.toggle('has-custom-color', Boolean(task.color));

  const button = row.querySelector('.task-color-button');
  if (!button) {
    return;
  }
  button.style.setProperty('--task-color', color);
  button.classList.toggle('has-custom-color', Boolean(task.color));
  button.title = '选择任务颜色';
  button.setAttribute('aria-label', button.title);
}

function canDeleteTask(task) {
  return task.status !== 'deleted';
}

function openTaskContextMenu(event, task) {
  if (!canDeleteTask(task) || editingTaskId || taskDragController?.active) {
    return;
  }
  if (event.target.closest('input, textarea, select, [contenteditable="true"]')) {
    return;
  }

  event.preventDefault();
  event.stopPropagation();
  closeTaskContextMenu();

  const menu = el('div', 'task-context-menu');
  menu.setAttribute('role', 'menu');
  menu.append(createTaskContextMenuItem('复制', '', () => copyTaskFromDay(task)));
  if (canColorTask(task)) {
    menu.append(
      createTaskContextMenuItem(
        '任务颜色',
        'task-context-color',
        () => {
          closeTaskColorPalette();
          closeTagPopover();
          renderTagPopoverOnly(document.querySelector('.day-window'));
          const row = getTaskRow(task.id);
          if (row)
            openTaskColorPalette(task, row.querySelector('.task-color-button'), {
              anchor: row.querySelector('.status-button'),
            });
        },
        icon('palette'),
      ),
    );
  }
  menu.append(
    createTaskContextMenuItem(
      task.pinned ? '取消任务置顶' : '置顶任务',
      '',
      () => {
        task.pinned = !task.pinned;
        persistCurrentDaySoon();
        renderDayView(document.querySelector('.day-window'));
      },
      icon('pin'),
    ),
  );
  if (task.reminder)
    menu.append(
      createTaskContextMenuItem(
        '管理重复提醒',
        '',
        () => openMonth({ panel: 'reminders', ruleId: task.reminder.ruleId }),
        icon('bell'),
      ),
    );
  if (canPasteToDate(currentDay.date)) {
    menu.append(createTaskContextMenuItem('粘贴', '', pasteTaskAsRoot));
    if (task.status === 'active') {
      menu.append(createTaskContextMenuItem('粘贴为子任务', '', () => pasteTaskAsChild(task.id)));
    }
  }
  menu.append(createTaskContextMenuItem('删除', 'danger', () => softDeleteTask(task.id), icon('trash')));
  openTaskContextMenuElement(menu, event.clientX, event.clientY);
}

function openTaskListContextMenu(event) {
  if (editingTaskId || taskDragController?.active || !canPasteToDate(currentDay.date)) {
    return;
  }

  event.preventDefault();
  event.stopPropagation();
  closeTaskContextMenu();

  const menu = el('div', 'task-context-menu');
  menu.setAttribute('role', 'menu');
  menu.append(createTaskContextMenuItem('粘贴', '', pasteTaskAsRoot));
  openTaskContextMenuElement(menu, event.clientX, event.clientY);
}

function createTaskContextMenuItem(label, className, onClick, leading = '') {
  const button = el('button', `task-context-menu-item ${className}`.trim());
  button.type = 'button';
  button.setAttribute('role', 'menuitem');
  button.innerHTML = `${leading}<span>${escapeHtml(label)}</span>`;
  button.addEventListener('click', () => {
    closeTaskContextMenu();
    onClick?.();
  });
  return button;
}

function openTaskContextMenuElement(menu, clientX, clientY) {
  document.body.append(menu);
  positionTaskContextMenu(menu, clientX, clientY);
  taskContextMenu = menu;

  window.addEventListener('keydown', handleTaskContextMenuKeydown, true);
  window.addEventListener('resize', closeTaskContextMenu);
  window.addEventListener('blur', closeTaskContextMenu);
  document.addEventListener('pointerdown', handleTaskContextMenuOutsidePointerDown, true);
  document.addEventListener('scroll', closeTaskContextMenu, true);
}

function copyTaskFromDay(task) {
  copyTask({ sourceDate: currentDay.date, task });
  showToast('已复制任务');
}

function pasteTaskAsRoot() {
  const task = createPastedTaskFromClipboard();
  if (!task || !canPasteToDate(currentDay.date)) {
    return;
  }
  taskState.push(task);
  persistCurrentDaySoon();
  renderDayView(document.querySelector('.day-window'));
  markNewShoot(document.querySelector(`.task-row[data-task-id="${CSS.escape(task.id)}"]`), themeSettings);
}

function pasteTaskAsChild(parentTaskId) {
  const parent = findTask(taskState, parentTaskId);
  const task = createPastedTaskFromClipboard();
  if (!parent || parent.status !== 'active' || !task || !canPasteToDate(currentDay.date)) {
    return;
  }
  parent.children ||= [];
  parent.children.push(task);
  parent.collapsed = false;
  persistCurrentDaySoon();
  renderDayView(document.querySelector('.day-window'));
  markNewShoot(document.querySelector(`.task-row[data-task-id="${CSS.escape(task.id)}"]`), themeSettings);
}

function positionTaskContextMenu(menu, clientX, clientY) {
  const margin = 8;
  const rect = menu.getBoundingClientRect();
  const left = Math.min(clientX, window.innerWidth - rect.width - margin);
  const top = Math.min(clientY, window.innerHeight - rect.height - margin);
  menu.style.left = `${Math.max(margin, left)}px`;
  menu.style.top = `${Math.max(margin, top)}px`;
}

function closeTaskContextMenu() {
  if (!taskContextMenu) {
    return;
  }

  taskContextMenu.remove();
  taskContextMenu = null;
  window.removeEventListener('keydown', handleTaskContextMenuKeydown, true);
  window.removeEventListener('resize', closeTaskContextMenu);
  window.removeEventListener('blur', closeTaskContextMenu);
  document.removeEventListener('pointerdown', handleTaskContextMenuOutsidePointerDown, true);
  document.removeEventListener('scroll', closeTaskContextMenu, true);
}

function handleTaskContextMenuKeydown(event) {
  if (event.key !== 'Escape') {
    return;
  }

  event.preventDefault();
  closeTaskContextMenu();
}

function handleTaskContextMenuOutsidePointerDown(event) {
  if (taskContextMenu?.contains(event.target)) {
    return;
  }

  closeTaskContextMenu();
}

function createNotes() {
  const notes = el('section', 'daily-notes');
  notes.style.setProperty('--note-height', `${dailyNoteHeight}px`);
  notes.innerHTML = `
    <div class="note-resize-handle" title="拖动调整高度" aria-hidden="true"></div>
    <h2><button class="note-toggle" type="button" aria-controls="daily-note-content">
      ${sproutMarkup('note-sprout')}<span>今日所思所想</span>
      <span class="note-toggle-chevron" aria-hidden="true">${icon('chevron')}</span>
    </button></h2>
    <div class="note-content" id="daily-note-content">
      <div class="note-content-inner">
        <textarea class="note-editor" aria-label="今日所思所想" placeholder="记录今天的想法..."></textarea>
      </div>
    </div>
  `;
  const editor = notes.querySelector('.note-editor');
  editor.value = dailyNoteText;
  setNotesExpanded(notes, isDailyNoteExpanded);
  notes.querySelector('.note-toggle').addEventListener('click', () => {
    setNotesExpanded(notes, !isDailyNoteExpanded);
  });
  editor.addEventListener('input', () => {
    dailyNoteText = editor.value;
    persistCurrentDaySoon();
  });
  editor.addEventListener('blur', () => {
    dailyNoteText = editor.value;
    persistCurrentDayNow();
  });
  editor.addEventListener('click', () => {
    editor.focus({ preventScroll: true });
  });
  notes.querySelector('.note-resize-handle')?.addEventListener('pointerdown', (event) => {
    startNoteResize(event, notes);
  });
  return notes;
}

function setNotesExpanded(notes, expanded) {
  if (!notes) return;
  isDailyNoteExpanded = expanded;
  notes.classList.toggle('is-expanded', expanded);
  notes.querySelector('.note-toggle').setAttribute('aria-expanded', String(expanded));
  const content = notes.querySelector('.note-content');
  content.inert = !expanded;
  content.setAttribute('aria-hidden', String(!expanded));
}

function createTaskTitleText(task) {
  const title = el('div', 'task-title');
  appendHighlightedText(title, task.title || '未命名任务', getNormalizedSearchQuery());
  if (canEditTask(task)) {
    title.title = '点击编辑任务';
    title.addEventListener('click', () => {
      removeEmptyDraftTask();
      editingTaskId = task.id;
      renderDayView(document.querySelector('.day-window'));
    });
  } else {
    const hint =
      task.status === 'completed'
        ? '已完成的任务暂不能编辑，请先改为进行中。'
        : task.status === 'failed'
          ? '已失败的任务暂不能编辑，请先恢复为进行中。'
          : '已删除的任务暂不能编辑，请先恢复任务。';
    title.title = hint;
    title.addEventListener('click', () => showToast(hint));
  }
  return title;
}

function startNoteResize(event, notes) {
  if (event.button !== 0) {
    return;
  }
  event.preventDefault();
  const startY = event.clientY;
  const startHeight = dailyNoteHeight;

  const resize = (moveEvent) => {
    const nextHeight = Math.max(72, Math.min(280, startHeight + startY - moveEvent.clientY));
    dailyNoteHeight = nextHeight;
    notes.style.setProperty('--note-height', `${nextHeight}px`);
  };

  const stop = () => {
    window.removeEventListener('pointermove', resize);
    window.removeEventListener('pointerup', stop);
    window.removeEventListener('pointercancel', stop);
  };

  window.addEventListener('pointermove', resize);
  window.addEventListener('pointerup', stop);
  window.addEventListener('pointercancel', stop);
}

function createTaskTitleInput(task) {
  const input = el('input', 'task-title-input');
  let settled = false;
  const finish = () => {
    if (settled || isReplacingTaskArea || editingTaskId !== task.id) return;
    settled = true;
    finishTaskEditing(task);
  };
  input.value = task.title;
  input.placeholder = '输入任务名称';
  input.setAttribute('aria-label', '输入任务名称');
  input.addEventListener('input', () => {
    task.title = input.value;
    persistCurrentDaySoon();
  });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      finish();
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      if (!settled) {
        settled = true;
        cancelEmptyTask(task);
      }
    }
  });
  input.addEventListener('blur', () => {
    finish();
  });
  queueMicrotask(() => {
    input.focus({ preventScroll: true });
    input.select();
  });
  return input;
}

async function handleDayViewKeydown(event) {
  if (event.key !== 'Escape') {
    return;
  }

  if (activeTagPopoverTaskId) {
    event.preventDefault();
    closeTagPopover();
    renderTagPopoverOnly(document.querySelector('.day-window'));
    return;
  }

  if (shouldKeepEscapeInDayView(event)) {
    return;
  }

  event.preventDefault();
  await flushDaySave();
  window.calendarShell?.hide?.();
}

function bindGlobalEscapeShortcut() {
  if (isGlobalEscapeShortcutBound) {
    return;
  }

  isGlobalEscapeShortcutBound = true;
  window.addEventListener('keydown', handleDayViewKeydown);
}

function bindFlushBeforeExit() {
  if (isBeforeUnloadFlushBound) {
    return;
  }

  isBeforeUnloadFlushBound = true;
  window.addEventListener('beforeunload', () => {
    flushDaySave();
  });
  window.addEventListener('blur', () => {
    flushDaySave();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      flushDaySave();
    }
  });
}

function bindExitRequestHandler() {
  if (isExitRequestHandlerBound || !window.__TAURI__?.event?.listen) {
    return;
  }

  isExitRequestHandlerBound = true;
  window.__TAURI__.event.listen('calendar://exit-requested', async () => {
    await flushDaySave();
    window.calendarShell?.exit?.();
  });
}

async function bindDayWindowHandoff(root) {
  const listen = window.__TAURI__?.event?.listen;
  const invoke = window.__TAURI__?.core?.invoke;
  if (!listen || !invoke) return;
  const restore = (id) => {
    if (dayHandoffId !== id) return;
    dayHandoffId = null;
    dayWindowRetired = false;
    root.inert = false;
  };
  await Promise.all([
    listen('calendar://day-handoff-requested', async (event) => {
      const id = event.payload?.id;
      if (!id) return;
      try {
        if (daySwitchInFlight || isDayLoading || dayHandoffId || taskDragController?.active)
          throw new Error('日视图正在操作中，请稍后重试');
        dayHandoffId = id;
        root.inert = true;
        await persistCurrentDayNow();
        if (dayHandoffId !== id) throw new Error('日视图交接已取消');
        dayWindowRetired = true;
        await invoke('complete_day_window_handoff', { id });
      } catch (error) {
        restore(id);
        await invoke('complete_day_window_handoff', { id, error: String(error.message || error) }).catch(
          console.error,
        );
      }
    }),
    listen('calendar://day-handoff-cancelled', (event) => restore(event.payload?.id)),
    listen('calendar://show-today-requested', () => openDay(getTodayDateKey()).catch(console.error)),
  ]);
}

function bindTagTemplateUpdateHandler(root) {
  if (isTagTemplateUpdateHandlerBound) {
    return;
  }

  isTagTemplateUpdateHandlerBound = true;
  const refreshTemplates = async () => {
    try {
      tagTemplates = await loadTagTemplates();
      renderTagPopoverOnly(root);
    } catch (error) {
      console.error(error);
      showToast('刷新长期标签失败');
    }
  };

  if (window.__TAURI__?.event?.listen) {
    window.__TAURI__.event.listen('calendar://tag-templates-updated', refreshTemplates);
  }

  window.addEventListener('calendar://tag-templates-updated', refreshTemplates);
  window.addEventListener('storage', (event) => {
    if (event.key === 'desktop-calendar:tag-templates') refreshTemplates();
  });
}

function bindDayUpdateHandler(root) {
  if (isDayUpdateHandlerBound) {
    return;
  }

  isDayUpdateHandlerBound = true;
  const refreshDay = async (event) => {
    if (isDataTransferBusy() || dayWindowRetired || dayHandoffId || daySwitchInFlight) return;
    const dateKey = event?.payload?.date || event?.detail?.date;
    const originId = event?.payload?.originId || event?.detail?.originId;
    if (!dateKey || dateKey !== currentDay.date || originId === getDayStorageOriginId()) {
      return;
    }
    if (isDayLoading) {
      dayRefreshPending = true;
      return;
    }
    try {
      await flushDaySave();
      await loadCurrentDay(root);
    } catch (error) {
      console.error(error);
    }
  };

  if (window.__TAURI__?.event?.listen) {
    window.__TAURI__.event.listen('calendar://day-updated', refreshDay);
  }

  window.addEventListener('calendar://day-updated', refreshDay);
  window.addEventListener('storage', (event) => {
    if (event.key === `desktop-calendar:day:${currentDay.date}`)
      refreshDay({ detail: { date: currentDay.date } });
  });
}

function bindThemeUpdateHandler(root) {
  if (isThemeUpdateHandlerBound) {
    return;
  }

  isThemeUpdateHandlerBound = true;
  const refreshTheme = (event) => {
    themeSettings = applyThemeSettings(
      event?.payload?.settings || event?.detail?.settings || loadThemeSettings(),
    );
    renderDayView(root);
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
  const refreshStorage = async (event) => {
    if (!isDataTransferBusy()) await reloadCurrentStorage(root);
  };

  if (window.__TAURI__?.event?.listen) {
    window.__TAURI__.event.listen('calendar://storage-updated', refreshStorage);
  }

  window.addEventListener('calendar://storage-updated', refreshStorage);
}

function bindTagPopoverViewportHandlers() {
  if (isTagPopoverViewportHandlerBound) {
    return;
  }

  isTagPopoverViewportHandlerBound = true;
  window.addEventListener('resize', handleDayViewportResize);
}

function handleDayViewportResize() {
  closeTagPopoverFromViewportChange();
  queueTaskTreeLayout(document.querySelector('.day-window'));
}

function bindTagPopoverOutsideHandler() {
  if (isTagPopoverOutsideHandlerBound) {
    return;
  }

  isTagPopoverOutsideHandlerBound = true;
  window.addEventListener('pointerdown', handleTagPopoverOutsidePointerDown, true);
  window.addEventListener('wheel', handleTagPopoverOutsideWheel, { passive: true });
}

function handleTagPopoverOutsidePointerDown(event) {
  if (!activeTagPopoverTaskId) {
    return;
  }

  const target = event.target instanceof Element ? event.target : null;
  if (target?.closest('.tag-popover')) {
    return;
  }

  closeTagPopover();
  if (!target?.closest('.tag-add-button')) {
    renderTagPopoverOnly(document.querySelector('.day-window'));
  }
}

function handleTagPopoverOutsideWheel(event) {
  if (!activeTagPopoverTaskId) {
    return;
  }

  const target = event.target instanceof Element ? event.target : null;
  if (target?.closest('.tag-popover')) {
    return;
  }
  closeTagPopoverFromViewportChange();
}

function bindTagPopoverScrollHandler(root) {
  const list = root.querySelector('.task-list');
  if (!list || list.dataset.tagPopoverScrollBound === 'true') {
    return;
  }

  list.dataset.tagPopoverScrollBound = 'true';
  list.addEventListener('scroll', closeTagPopoverFromViewportChange, { passive: true });
}

function closeTagPopoverFromViewportChange() {
  if (!activeTagPopoverTaskId) {
    return;
  }
  closeTagPopover();
  renderTagPopoverOnly(document.querySelector('.day-window'));
}

async function loadCurrentDay(root) {
  isDayLoading = true;
  loadErrorMessage = '';
  renderDayView(root, { gardenAnimate: false });

  try {
    await ensureReminders(currentDay.date).catch((error) => {
      console.error(error);
      showToast('提醒暂未生成，请稍后重试');
    });
    const [storedDay, storedTagTemplates] = await Promise.all([loadDay(currentDay.date), loadTagTemplates()]);
    tagTemplates = storedTagTemplates;
    currentDay = normalizeDay(storedDay || currentDay);
  } catch (error) {
    loadErrorMessage = '读取本地数据失败，当前显示临时数据';
    console.error(error);
    currentDay = createEmptyDay(currentDay.date);
  }

  taskState = currentDay.tasks;
  dailyNoteText = currentDay.note;
  isDayLoading = false;
  renderDayView(root, { gardenAnimate: false });
  renderNotesOnly(root);
  revealSearchTarget(root);
  if (dayRefreshPending) {
    dayRefreshPending = false;
    queueMicrotask(() => {
      if (root.isConnected) loadCurrentDay(root);
    });
  }
}

function revealSearchTarget(root) {
  const target = pendingReveal;
  if (!target || isDayLoading) return;
  if (target.taskId && !findTask(taskState, target.taskId) && dayRefreshPending) return;
  pendingReveal = null;
  if (target.includeDeleted) showDeletedTasks = true;
  isSearchOpen = false;
  searchQuery = '';
  const expand = (tasks) =>
    tasks.some((task) => {
      if (task.id === target.taskId) return true;
      if (expand(task.children || [])) {
        task.collapsed = false;
        return true;
      }
      return false;
    });
  expand(taskState);
  renderDayView(root);
  if (target.note) setNotesExpanded(root.querySelector('.daily-notes'), true);
  requestAnimationFrame(() => {
    const node = target.note
      ? root.querySelector('.note-editor')
      : [...root.querySelectorAll('.task-row')].find((row) => row.dataset.taskId === target.taskId);
    if (!node) return;
    node.scrollIntoView({ block: 'center', behavior: 'smooth' });
    node.classList.add('is-search-located');
    if (target.note) node.focus({ preventScroll: true });
    setTimeout(() => node.classList.remove('is-search-located'), 2600);
  });
}

async function reloadCurrentStorage(root) {
  currentDay = createEmptyDay(currentDay.date);
  taskState = currentDay.tasks;
  dailyNoteText = currentDay.note;
  activeTagPopoverTaskId = null;
  activeTagPopoverAnchor = null;
  await loadCurrentDay(root);
}

async function switchDay(root, offsetDays) {
  await switchToDay(root, shiftDateKey(currentDay.date, offsetDays));
}

async function switchToDay(root, nextDate) {
  if (!root || isDayLoading || daySwitchInFlight || dayWindowRetired || dayHandoffId) {
    return;
  }

  if (nextDate === currentDay.date) {
    return;
  }

  daySwitchInFlight = true;
  root.inert = true;
  try {
    await initialDayClaim;
    await persistCurrentDayNow();
    if (!(await claimDayWindowDate(nextDate, true))) {
      return;
    }
    resetTransientDayState();
    currentDay = createEmptyDay(nextDate);
    taskState = currentDay.tasks;
    dailyNoteText = currentDay.note;
    const url = new URL(location.href);
    url.searchParams.set('date', nextDate);
    url.searchParams.delete('taskId');
    url.searchParams.delete('note');
    url.searchParams.delete('deleted');
    url.hash = '';
    history.replaceState(null, '', url);
    await loadCurrentDay(root);
  } catch (error) {
    console.error(error);
    showToast(`切换日期失败：${error.message || error}`);
  } finally {
    daySwitchInFlight = false;
    if (!dayWindowRetired && !dayHandoffId) root.inert = false;
  }
}

function claimDayWindowDate(date, takeOver = false) {
  if (!window.__TAURI__?.core?.invoke) {
    window.name = `day-${date}`;
    return Promise.resolve(true);
  }
  return window.__TAURI__.core.invoke('claim_day_window_date', { date, takeOver });
}

function resetTransientDayState() {
  closeTaskContextMenu();
  closeTaskColorPalette();
  editingTaskId = null;
  removeEmptyDraftTask();
  isSearchOpen = false;
  searchQuery = '';
  activeTagPopoverTaskId = null;
  activeTagPopoverAnchor = null;
  temporaryTagText = '';
  isDailyNoteExpanded = false;
  taskDragController?.cancel();
  document.body.classList.remove('is-task-dragging');
}

function normalizeDay(day) {
  const tasks = Array.isArray(day.tasks) ? day.tasks : [];
  return {
    date: day.date || currentDay.date,
    note: day.note || '',
    tasks: getPersistableTasks(normalizeTaskTree(normalizeTaskTags(tasks, legacyTagPalette))),
  };
}

function createEmptyDay(date) {
  return {
    date,
    note: '',
    tasks: [],
  };
}

function removeEmptyDraftTask() {
  if (!draftTaskId) {
    return false;
  }

  const draft = findTask(taskState, draftTaskId);
  if (!draft || draft.title.trim()) {
    draftTaskId = null;
    return false;
  }

  removeTask(taskState, draftTaskId);
  draftTaskId = null;
  persistCurrentDaySoon();
  return true;
}

function persistCurrentDaySoon() {
  if (isDayLoading || dayWindowRetired) {
    return;
  }

  currentDay = {
    ...currentDay,
    note: dailyNoteText,
    tasks: getPersistableTasks(taskState),
  };
  scheduleSaveDay(currentDay);
}

async function persistCurrentDayNow() {
  persistCurrentDaySoon();
  await flushDaySave();
}

function shouldKeepEscapeInDayView(event) {
  const target = event.target instanceof Element ? event.target : null;
  return (
    event.defaultPrevented ||
    editingTaskId ||
    isSearchOpen ||
    taskDragController?.active ||
    target?.closest('input, textarea, select, [contenteditable="true"]')
  );
}

function actionButton(content, type, label = content, onClick = null) {
  const button = el('button', `action-button ${type}`);
  button.innerHTML = content;
  button.setAttribute('title', label);
  button.setAttribute('aria-label', label);
  if (onClick) {
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      onClick();
    });
  }
  return button;
}

function addRootTask(root) {
  const task = createBlankTask();
  taskState.push(task);
  editingTaskId = task.id;
  draftTaskId = task.id;
  renderDayView(root);
  revealTaskAfterRender(root, task.id);
}

function addChildTask(parentId) {
  const parent = findTask(taskState, parentId);
  const root = document.querySelector('.day-window');
  if (!parent || !root) {
    return;
  }

  const child = createBlankTask(parent);
  parent.children ||= [];
  parent.children.push(child);
  parent.collapsed = false;
  editingTaskId = child.id;
  draftTaskId = child.id;
  renderDayView(root);
  revealTaskAfterRender(root, child.id);
}

function revealTaskAfterRender(root, taskId) {
  window.requestAnimationFrame(() => {
    const row = Array.from(root?.querySelectorAll('.task-row') || []).find(
      (item) => item.dataset.taskId === taskId,
    );
    if (!row) {
      return;
    }

    row.scrollIntoView({
      block: 'center',
      inline: 'nearest',
      behavior: 'smooth',
    });
    row.classList.add('is-revealed');
    window.setTimeout(() => {
      row.classList.remove('is-revealed');
    }, 900);
  });
}

function toggleTaskCollapse(taskId) {
  settleCompletionFeedback(document.querySelector('.day-window'), false);
  const task = findTask(taskState, taskId);
  if (!task?.children?.length) {
    return;
  }
  const row = getTaskRow(taskId);
  const wrapper = row?.closest('.task-node');
  const children = wrapper?.querySelector(':scope > .children');
  if (!row || !wrapper || !children) {
    task.collapsed = !task.collapsed;
    persistCurrentDaySoon();
    renderDayView(document.querySelector('.day-window'));
    return;
  }

  const nextCollapsed = !task.collapsed;
  task.collapsed = nextCollapsed;
  animateChildrenCollapse(row, wrapper, children, nextCollapsed);
  persistCurrentDaySoon();
}

function cancelChildrenAnimation(children) {
  const pending = childrenAnimations.get(children);
  if (!pending) return;
  cancelAnimationFrame(pending.frame);
  cancelAnimationFrame(pending.layoutFrame);
  clearTimeout(pending.timer);
  children.removeEventListener('transitionend', pending.onEnd);
  childrenAnimations.delete(children);
  pending.resolve(false);
  document.querySelector('.day-window')?.classList.toggle('is-tree-folding', childrenAnimations.size > 0);
}

function animateChildrenCollapse(row, wrapper, children, collapsed, { animate = true } = {}) {
  const root = document.querySelector('.day-window');
  const currentHeight = children.getBoundingClientRect().height;
  cancelChildrenAnimation(children);
  row.classList.toggle('is-collapsed', collapsed);
  wrapper.classList.toggle('is-collapsed', collapsed);
  const toggle = row.querySelector('.collapse-toggle');
  toggle?.setAttribute('aria-expanded', String(!collapsed));
  const task = findTask(taskState, row.dataset.taskId);
  if (toggle) {
    toggle.title = `${collapsed ? '展开' : '折叠'} ${task?.children?.length || 0} 个子任务`;
    toggle.setAttribute('aria-label', toggle.title);
  }
  if (
    !animate ||
    root?.classList.contains('is-backgrounded') ||
    matchMedia('(prefers-reduced-motion: reduce)').matches
  ) {
    children.classList.toggle('is-collapsed', collapsed);
    children.classList.remove('is-animating');
    children.style.removeProperty('--children-height');
    children.style.removeProperty('transition');
    applyTreeBranchLayout(root);
    return Promise.resolve(true);
  }
  root?.classList.add('is-tree-folding');
  // Freeze the current height before changing the collapsed class. This also
  // lets a quick reverse start from the actual interpolated height.
  children.style.transition = 'none';
  children.classList.add('is-animating');
  children.style.setProperty('--children-height', `${currentHeight}px`);
  children.getBoundingClientRect();
  children.style.removeProperty('transition');
  children.classList.toggle('is-collapsed', collapsed);
  const last = children.querySelector(':scope > .task-node:last-child');
  const targetHeight = collapsed ? 0 : last ? last.offsetTop + last.offsetHeight : 0;
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  const pending = { promise, resolve, frame: 0, layoutFrame: 0, timer: 0, onEnd: null };
  const containers = new Set();
  for (let branch = children; branch; branch = branch.parentElement?.closest('.children'))
    containers.add(branch);
  const updateBranches = () => {
    if (childrenAnimations.get(children) !== pending) return;
    applyTreeBranchLayout(root, { containers });
    pending.layoutFrame = requestAnimationFrame(updateBranches);
  };
  const finish = () => {
    if (childrenAnimations.get(children) !== pending) return;
    clearTimeout(pending.timer);
    cancelAnimationFrame(pending.layoutFrame);
    children.removeEventListener('transitionend', pending.onEnd);
    childrenAnimations.delete(children);
    children.classList.remove('is-animating');
    children.style.removeProperty('--children-height');
    if (children.isConnected) applyTreeBranchLayout(root);
    root?.classList.toggle('is-tree-folding', childrenAnimations.size > 0);
    resolve(true);
  };
  pending.onEnd = (event) => {
    if (event.target === children && event.propertyName === 'height') finish();
  };
  children.addEventListener('transitionend', pending.onEnd);
  childrenAnimations.set(children, pending);
  pending.frame = requestAnimationFrame(() => {
    children.style.setProperty('--children-height', `${targetHeight}px`);
    updateBranches();
    pending.timer = window.setTimeout(finish, 310);
  });
  return promise;
}

function finishTaskEditing(task) {
  const normalizedTitle = task.title.trim();
  if (!normalizedTitle) {
    removeTask(taskState, task.id);
  } else {
    task.title = normalizedTitle;
  }
  if (draftTaskId === task.id) {
    draftTaskId = null;
  }
  editingTaskId = null;
  persistCurrentDaySoon();
  renderDayView(document.querySelector('.day-window'));
}

function cancelEmptyTask(task) {
  if (!task.title.trim()) {
    removeTask(taskState, task.id);
    persistCurrentDaySoon();
  }
  if (draftTaskId === task.id) {
    draftTaskId = null;
  }
  editingTaskId = null;
  renderDayView(document.querySelector('.day-window'));
}

function toggleTaskCompletion(taskId) {
  const task = findTask(taskState, taskId);
  if (!task || (task.status !== 'active' && task.status !== 'completed')) {
    return;
  }

  if (task.status === 'active' && hasActiveDescendant(task)) {
    showToast('请先处理所有进行中的子任务，再标记完成');
    return;
  }

  const root = document.querySelector('.day-window');
  if (document.body.classList.contains('is-task-dragging')) return;
  closeTaskContextMenu();
  closeTaskColorPalette();
  closeTagPopover();
  renderTagPopoverOnly(root);
  const previousStatus = task.status;
  if (task.status === 'completed') task.flower = getTaskFlower(task);
  task.status = task.status === 'active' ? 'completed' : 'active';
  if (task.status === 'completed') {
    ensureTaskFlower(task);
    recordTaskCompletion(task, taskState);
  }
  const reopened = task.status === 'active' ? reopenCompletedAncestors(taskState, taskId) : [];
  if (task.status === 'completed' && task.children?.length) task.collapsed = true;
  persistCurrentDaySoon();
  const changes = [
    { task, previousStatus },
    ...reopened.map((task) => ({ task, previousStatus: 'completed' })),
  ];
  const pending = new Map();
  const bloom =
    task.status === 'completed' &&
    !root.classList.contains('is-backgrounded') &&
    botanicalMotionEnabled(themeSettings);
  for (const change of changes) {
    const row = getTaskRow(change.task.id);
    updateCompletionSummary(root, change.previousStatus, change.task.status);
    if (!row) continue;
    const wrapper = row.closest('.task-node'),
      location = getTaskLocation(taskState, change.task.id);
    const inherited = getPreviewParentTags(taskState, location?.parentId) || [];
    const nextRow = createTaskRow(change.task, Number(row.dataset.depth), [
      ...inherited,
      ...change.task.tags,
    ]);
    if (bloom) nextRow.style.minHeight = `${row.getBoundingClientRect().height}px`;
    const hadFocus = row.contains(document.activeElement);
    row.replaceWith(nextRow);
    applyTagLineReserve(nextRow);
    if (hadFocus) nextRow.querySelector('.status-button')?.focus({ preventScroll: true });
    wrapper.classList.toggle(
      'is-completed-branch',
      change.task.status === 'completed' && Boolean(change.task.children?.length),
    );
    wrapper.classList.toggle('is-branch-blooming', bloom && Boolean(change.task.children?.length));
    if (bloom) nextRow.classList.add('is-blooming');
    pendingCompletions.set(change.task.id, wrapper);
    pending.set(change.task.id, wrapper);
    const children = wrapper.querySelector(':scope > .children');
    if (children && children.classList.contains('is-collapsed') !== Boolean(change.task.collapsed)) {
      animateChildrenCollapse(nextRow, wrapper, children, Boolean(change.task.collapsed));
    }
  }
  headerGarden?.update({ animate: true, growTaskId: task.status === 'completed' ? task.id : null });
  finishCompletionReorder(root, pending, true, { keepFeedback: bloom });
  clearTimeout(completionSettleTimer);
  if (bloom || [...pendingCompletions.values()].some((node) => node.querySelector(':scope > .is-blooming'))) {
    completionSettleTimer = window.setTimeout(
      () => settleCompletionFeedback(root),
      completionFeedbackDurationMs + 20,
    );
  } else settleCompletionFeedback(root);
}

function cancelCompletionMoves() {
  completionMoves.forEach((animation) => animation.cancel());
  completionMoves.clear();
}

function clearCompletionFeedback() {
  clearTimeout(completionSettleTimer);
  completionSettleTimer = 0;
  pendingCompletions.clear();
  cancelCompletionMoves();
  [...childrenAnimations.keys()].forEach(cancelChildrenAnimation);
}

function handleDayActivity(root, active) {
  if (active) return;
  // Backgrounding preserves the committed task state and removes all finite feedback.
  // Fold RAF loops and FLIP animations must not keep a hidden window painting.
  taskDragController?.cancel();
  settleCompletionFeedback(root, false);
  cancelCompletionMoves();
  [...childrenAnimations.keys()].forEach((children) => {
    const wrapper = children.parentElement,
      row = wrapper.querySelector(':scope > .task-row');
    const task = findTask(taskState, row?.dataset.taskId);
    if (row && task)
      animateChildrenCollapse(row, wrapper, children, Boolean(task.collapsed), { animate: false });
    else cancelChildrenAnimation(children);
  });
  root.querySelectorAll('.is-new-shoot,.is-appearing,.is-revealed,.is-search-located').forEach((node) => {
    node.classList.remove('is-new-shoot', 'is-appearing', 'is-revealed', 'is-search-located');
  });
}

function settleCompletionFeedback(root, animate = true) {
  clearTimeout(completionSettleTimer);
  completionSettleTimer = 0;
  if (!root || !pendingCompletions.size) return;
  pendingCompletions.forEach((node, id) => {
    const row = node.querySelector(':scope > .task-row');
    row?.classList.remove('is-blooming');
    row?.style.removeProperty('min-height');
    node.classList.remove('is-branch-blooming');
    const task = findTask(taskState, id),
      children = node.querySelector(':scope > .children');
    if (
      task &&
      children &&
      (!animate || children.classList.contains('is-collapsed') !== Boolean(task.collapsed))
    ) {
      animateChildrenCollapse(row, node, children, Boolean(task.collapsed), { animate });
    }
  });
  pendingCompletions.clear();
}

function finishCompletionReorder(root, pending, animate, { keepFeedback = false } = {}) {
  const changedNodes = new Set([...pending.values()].filter((node) => node.isConnected));
  const containers = new Set([...changedNodes].map((node) => node.parentElement));
  const nodes = [
    ...new Set(
      [...containers].flatMap((container) =>
        [...container.children].filter((node) => node.matches('.task-node')),
      ),
    ),
  ];
  const before = new Map(nodes.map((node) => [node, node.getBoundingClientRect()]));
  cancelCompletionMoves();
  pending.forEach((node, id) => {
    if (!keepFeedback) node.querySelector(':scope > .task-row')?.style.removeProperty('min-height');
    if (!keepFeedback && pendingCompletions.get(id) === node) pendingCompletions.delete(id);
  });
  containers.forEach((container) => {
    const parentId = container.matches('.children')
      ? container.parentElement.querySelector(':scope > .task-row')?.dataset.taskId
      : null;
    const items = parentId ? findTask(taskState, parentId)?.children || [] : taskState;
    const byId = new Map(
      [...container.children].map((node) => [node.querySelector(':scope > .task-row')?.dataset.taskId, node]),
    );
    let next = null;
    [...getVisibleTaskTree(items)].reverse().forEach((task) => {
      const node = byId.get(task.id);
      if (!node) return;
      // Unchanged siblings already have the right relative order. Moving them all
      // around one completed task causes needless subtree invalidation.
      if (changedNodes.has(node) && node.nextElementSibling !== next) container.insertBefore(node, next);
      next = node;
    });
  });
  const affected = new Set();
  changedNodes.forEach((node) => {
    const own = node.querySelector(':scope > .children');
    if (own) affected.add(own);
    for (
      let branch = node.parentElement?.closest('.children');
      branch;
      branch = branch.parentElement?.closest('.children')
    )
      affected.add(branch);
  });
  applyTreeBranchLayout(root, { containers: affected });
  if (
    !animate ||
    root.classList.contains('is-backgrounded') ||
    matchMedia('(prefers-reduced-motion: reduce)').matches
  )
    return;
  const viewport = root.querySelector('.task-list').getBoundingClientRect();
  // Batch layout reads before starting transform-only animations. Hidden/offscreen cards stay static.
  const moves = nodes
    .map((node) => ({ node, first: before.get(node), last: node.getBoundingClientRect() }))
    .filter(
      ({ first, last }) =>
        first.height &&
        ((first.bottom >= viewport.top && first.top <= viewport.bottom) ||
          (last.bottom >= viewport.top && last.top <= viewport.bottom)),
    )
    .filter(
      ({ first, last }) => Math.abs(first.top - last.top) > 0.5 || Math.abs(first.left - last.left) > 0.5,
    );
  const moved = new Set(moves.map((move) => move.node));
  moves.forEach(({ node, first, last }) => {
    // A moving ancestor carries its subtree with it; do not apply the same displacement twice.
    for (
      let ancestor = node.parentElement?.closest('.task-node');
      ancestor;
      ancestor = ancestor.parentElement?.closest('.task-node')
    ) {
      if (moved.has(ancestor)) return;
    }
    const animation = node.animate(
      [
        { transform: `translate(${first.left - last.left}px, ${first.top - last.top}px)` },
        { transform: 'translate(0,0)' },
      ],
      { duration: 220, easing: 'cubic-bezier(.2,.8,.2,1)' },
    );
    completionMoves.add(animation);
    animation.finished.then(() => completionMoves.delete(animation)).catch(() => {});
  });
}

function failTask(taskId) {
  const task = findTask(taskState, taskId);
  if (!task || task.status !== 'active') {
    return;
  }

  animateTaskLayout(document.querySelector('.day-window'), () => {
    failActiveDescendants(task);
    task.status = 'failed';
    if (task.children?.length) {
      task.collapsed = true;
    }
  });
}

function restoreFailedTask(taskId) {
  const task = findTask(taskState, taskId);
  if (!task || task.status !== 'failed') {
    return;
  }

  animateTaskLayout(document.querySelector('.day-window'), () => {
    task.status = 'active';
    reopenCompletedAncestors(taskState, task.id);
  });
}

function softDeleteTask(taskId) {
  const task = findTask(taskState, taskId);
  if (!task) {
    return;
  }
  const root = document.querySelector('.day-window');
  animateTaskLayout(
    root,
    () => {
      task.previousStatus = task.status;
      task.status = 'deleted';
    },
    { disappearingTaskId: showDeletedTasks ? null : taskId },
  );
}

function restoreTask(taskId) {
  const task = findTask(taskState, taskId);
  if (!task) {
    return;
  }
  animateTaskLayout(document.querySelector('.day-window'), () => {
    task.status = task.previousStatus && task.previousStatus !== 'deleted' ? task.previousStatus : 'active';
    delete task.previousStatus;
    if (task.status === 'active') reopenCompletedAncestors(taskState, task.id);
  });
}

function destroyTask(taskId) {
  const task = findTask(taskState, taskId);
  if (!task) {
    return;
  }
  showDestroyConfirm(task);
}

function replaceTaskRegion(current, next) {
  isReplacingTaskArea = true;
  try {
    current?.replaceWith(next);
  } finally {
    isReplacingTaskArea = false;
  }
}

function renderDayView(root, { gardenAnimate = true } = {}) {
  if (!root) {
    return;
  }
  clearCompletionFeedback();
  taskDragController?.cancel();
  closeTaskContextMenu();
  closeTaskColorPalette();
  const currentList = root.querySelector('.task-list');
  const scrollTop = currentList?.scrollTop ?? 0;
  root.querySelector('.day-header')?.replaceWith(createHeader(root));
  root.querySelector('.day-toolbar')?.replaceWith(createToolbar(root));
  const currentRegion = root.querySelector('.task-scroll-region');
  const nextRegion = createTaskScrollRegion(taskState);
  const nextList = nextRegion.querySelector('.task-list');
  disposeScrollRegion(currentRegion);
  replaceTaskRegion(currentRegion, nextRegion);
  nextList.scrollTop = scrollTop;
  window.requestAnimationFrame(() => {
    nextList.scrollTop = scrollTop;
  });
  root.querySelector('.tag-popover-layer')?.replaceWith(createTagPopoverLayer());
  bindTagPopoverScrollHandler(root);
  queueTaskTreeLayout(root);
  headerGarden?.update({ animate: gardenAnimate });
}

function renderTaskAreaOnly(root) {
  if (!root) {
    return;
  }
  clearCompletionFeedback();
  taskDragController?.cancel();
  closeTaskContextMenu();
  closeTaskColorPalette();
  const currentList = root.querySelector('.task-list');
  const scrollTop = currentList?.scrollTop ?? 0;
  const currentRegion = root.querySelector('.task-scroll-region');
  const nextRegion = createTaskScrollRegion(taskState);
  const nextList = nextRegion.querySelector('.task-list');
  disposeScrollRegion(currentRegion);
  replaceTaskRegion(currentRegion, nextRegion);
  nextList.scrollTop = scrollTop;
  window.requestAnimationFrame(() => {
    nextList.scrollTop = scrollTop;
  });
  root.querySelector('.tag-popover-layer')?.replaceWith(createTagPopoverLayer());
  bindTagPopoverScrollHandler(root);
  queueTaskTreeLayout(root);
}

function renderNotesOnly(root) {
  if (!root) {
    return;
  }
  root.querySelector('.daily-notes')?.replaceWith(createNotes());
}

function renderTagPopoverOnly(root) {
  if (!root) {
    return;
  }
  root.querySelectorAll('.task-row.has-tag-popover').forEach((row) => {
    row.classList.remove('has-tag-popover');
  });
  if (activeTagPopoverTaskId) {
    root
      .querySelector(`.task-row[data-task-id="${activeTagPopoverTaskId}"]`)
      ?.classList.add('has-tag-popover');
  }
  root.querySelector('.tag-popover-layer')?.replaceWith(createTagPopoverLayer());
}

function animateTaskLayout(root, mutateState, options = {}) {
  if (!root) {
    mutateState();
    persistCurrentDaySoon();
    return;
  }

  const firstRects = getTaskRowRects(root);
  const disappearingRow = options.disappearingTaskId
    ? root.querySelector(`.task-row[data-task-id="${options.disappearingTaskId}"]`)
    : null;

  if (disappearingRow) {
    disappearingRow.classList.add('is-disappearing');
    window.setTimeout(() => {
      mutateState();
      persistCurrentDaySoon();
      renderDayView(root);
      animateExistingTaskRows(root, firstRects);
    }, 180);
    return;
  }

  mutateState();
  persistCurrentDaySoon();
  renderDayView(root);
  animateExistingTaskRows(root, firstRects);
}

function getTaskRowRects(root) {
  const rects = new Map();
  root.querySelectorAll('.task-row[data-task-id]').forEach((row) => {
    rects.set(row.dataset.taskId, row.getBoundingClientRect());
  });
  return rects;
}

function animateExistingTaskRows(root, firstRects) {
  root.querySelectorAll('.task-row[data-task-id]').forEach((row) => {
    const first = firstRects.get(row.dataset.taskId);
    if (!first) {
      row.classList.add('is-appearing');
      row.addEventListener('animationend', () => row.classList.remove('is-appearing'), { once: true });
      return;
    }

    const last = row.getBoundingClientRect();
    const dx = first.left - last.left;
    const dy = first.top - last.top;
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) {
      return;
    }

    row.style.transform = `translate(${dx}px, ${dy}px)`;
    row.style.transition = 'transform 0s';
    row.getBoundingClientRect();
    requestAnimationFrame(() => {
      row.style.transform = '';
      row.style.transition = 'transform 220ms cubic-bezier(0.2, 0.8, 0.2, 1)';
      row.addEventListener(
        'transitionend',
        () => {
          row.style.transition = '';
          row.style.transform = '';
        },
        { once: true },
      );
    });
  });
}

function showDestroyConfirm(task) {
  closeDialog();
  showConfirmDialog({
    title: '彻底删除任务',
    message: `确认彻底删除任务「${truncateText(task.title || '未命名任务', 18)}」吗？`,
    confirmText: '确认删除',
    onConfirm: () => {
      removeTask(taskState, task.id);
      persistCurrentDaySoon();
      renderDayView(document.querySelector('.day-window'));
    },
  });
}

function showConfirmDialog({ title, message, confirmText = '确认', confirmStyle = 'danger', onConfirm }) {
  document.querySelector('.confirm-overlay')?.remove();
  const overlay = el('div', 'dialog-overlay confirm-overlay');
  overlay.innerHTML = `
    <section class="confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="confirm-title">
      <h2 id="confirm-title">${escapeHtml(title)}</h2>
      <p>${escapeHtml(message)}</p>
      <div class="dialog-actions">
        <button class="dialog-button cancel" type="button">取消</button>
        <button class="dialog-button confirm-action ${escapeHtml(confirmStyle)}" type="button">${escapeHtml(confirmText)}</button>
      </div>
    </section>
  `;

  const closeConfirm = () => overlay.remove();
  overlay.querySelector('.cancel')?.addEventListener('click', closeConfirm);
  overlay.querySelector('.confirm-action')?.addEventListener('click', async () => {
    await onConfirm?.();
    closeConfirm();
  });
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) {
      closeConfirm();
    }
  });
  overlay.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      closeConfirm();
    }
  });

  document.body.append(overlay);
  queueMicrotask(() => overlay.querySelector('.cancel')?.focus());
}

function closeDialog() {
  const overlays = document.querySelectorAll('.dialog-overlay');
  overlays[overlays.length - 1]?.remove();
}

function showToast(message) {
  showNotice(message);
}

function getVisibleTaskTree(items) {
  return getVisibleTaskTreeByState(items, { showDeletedTasks, searchQuery });
}

function getNormalizedSearchQuery() {
  return normalizeSearchQuery(searchQuery);
}

function getTaskRow(taskId) {
  return [...document.querySelectorAll('.task-row')].find((row) => row.dataset.taskId === taskId);
}

function canMoveTask(task) {
  return canMoveTaskByState(task, searchQuery);
}

function getPreviewParentTags(items, parentId, inherited = []) {
  if (parentId === null) return [];
  for (const task of items) {
    const tags = [...inherited, ...(task.tags || [])];
    if (task.id === parentId) return tags;
    const found = getPreviewParentTags(task.children || [], parentId, tags);
    if (found) return found;
  }
  return null;
}
function getTaskAccentColor(task) {
  return task.color || 'rgb(var(--theme-border-rgb))';
}
