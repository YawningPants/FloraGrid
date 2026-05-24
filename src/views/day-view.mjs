import { tagPalette } from '../data/sample-calendar.mjs';
import { getDayDisplayMeta, getTodayDateKey, shiftDateKey } from '../domain/date.mjs';
import {
  cloneTemplateAsSnapshot,
  createTagSnapshot,
  getTagColor as getSnapshotTagColor,
  getTagText,
  normalizeTagTemplates,
  normalizeTaskTags,
  pickUnusedColor,
  tagColors,
} from '../domain/tags.mjs';
import {
  applyThemeSettings,
  loadThemeSettings,
  saveThemeSettings,
  themePresets,
} from '../domain/theme.mjs';
import {
  canAcceptChildTask,
  canEditTask,
  canMoveTask as canMoveTaskByState,
  createBlankTask,
  failActiveDescendants,
  findTask,
  flattenTasks,
  getChildrenByParentId as getTreeChildrenByParentId,
  getDropIndexAroundTask as getTreeDropIndexAroundTask,
  getTaskLocation,
  getVisibleSiblings as getTreeVisibleSiblings,
  getVisibleTaskTree as getVisibleTaskTreeByState,
  hasActiveDescendant,
  hasDescendant,
  moveTaskWithinTree,
  normalizeSearchQuery,
  normalizeTaskTree,
  removeTask,
  taskStatusMeta,
} from '../domain/tasks.mjs';
import { flushDaySave, loadDay, scheduleSaveDay } from '../storage/day-storage.mjs';
import {
  loadStorageLocation,
  pickDataDirectory,
  resetStorageLocation,
  setStorageLocation,
} from '../storage/storage-location.mjs';
import { loadTagTemplates } from '../storage/tag-template-storage.mjs';
import { appendHighlightedText, el, escapeHtml, truncateText } from '../ui/dom.mjs';
import { icon } from '../ui/icons.mjs';
import { applyTreeBranchLayout, queueTaskTreeLayout } from '../ui/task-tree-layout.mjs';
import { createWindowTitleBar } from '../ui/window-titlebar.mjs';

let currentDay = createEmptyDay(getTodayDateKey());
let taskState = currentDay.tasks;
let editingTaskId = null;
let dragState = null;
let dropPreview = null;
let showDeletedTasks = false;
let isSearchOpen = false;
let searchQuery = '';
let dailyNoteText = currentDay.note;
let dailyNoteHeight = 112;
let isGlobalEscapeShortcutBound = false;
let isBeforeUnloadFlushBound = false;
let isExitRequestHandlerBound = false;
let isTagTemplateUpdateHandlerBound = false;
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
let storageLocation = null;
const TAG_GROUP_VISIBLE_CHARS = 5;
const TAG_GROUP_MIN_WIDTH = 34;
const TAG_GROUP_MAX_WIDTH = 90;
const TAG_GROUP_PAGER_FALLBACK_WIDTH = 286;
const TAG_POPOVER_WIDTH = 320;
const TAG_POPOVER_MARGIN = 12;
const TAG_POPOVER_GAP = 8;

export function createDayView() {
  applyThemeSettings(themeSettings);
  const root = el('section', 'day-window');
  root.append(createTitleBar(), createHeader(root), createToolbar(root), createTaskList(taskState), createNotes(), createTagPopoverLayer());
  root.addEventListener('pointermove', handleDragMove);
  root.addEventListener('pointerup', finishDrag);
  root.addEventListener('pointercancel', cancelDrag);
  root.addEventListener('contextmenu', cancelDragContextMenu);
  bindGlobalEscapeShortcut();
  bindFlushBeforeExit();
  bindExitRequestHandler();
  bindTagTemplateUpdateHandler(root);
  bindTagPopoverViewportHandlers();
  bindTagPopoverOutsideHandler();
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
        </div>
      `;
  header.innerHTML = `
    <div class="day-heading">
      <div>
        <h1>${dayMeta.title}</h1>
        ${subtitleMarkup}
      </div>
      <div class="header-actions">
        <button class="icon-button" title="打开日历" aria-label="打开日历">${icon('calendar')}</button>
        <button class="icon-button search-toggle${isSearchOpen ? ' is-active' : ''}" title="全局搜索" aria-label="全局搜索">${icon('search')}</button>
        <button class="icon-button settings-toggle" title="设置" aria-label="设置">${icon('settings')}</button>
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
    showSettingsDialog();
  });
  header.querySelector('.previous-day')?.addEventListener('click', () => {
    switchDay(root, -1);
  });
  header.querySelector('.next-day')?.addEventListener('click', () => {
    switchDay(root, 1);
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

function createTaskList(items) {
  const list = el('section', 'task-list');
  if (isDayLoading) {
    const loading = el('div', 'search-empty');
    loading.textContent = '正在读取今天的数据...';
    list.append(loading);
    return list;
  }

  list.append(createStatusSummary(items));
  const tree = el('div', 'task-tree');
  const visibleTasks = getVisibleTaskTree(items);
  visibleTasks.forEach((task) => tree.append(createTaskNode(task, 0, [])));
  if (getNormalizedSearchQuery() && visibleTasks.length === 0) {
    const empty = el('div', 'search-empty');
    empty.textContent = '没有找到相关任务';
    tree.append(empty);
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
  summary.innerHTML = `
    <span>${taskStatusMeta.active.label} ${counts.active}</span>
    <span>${taskStatusMeta.completed.label} ${counts.completed}</span>
    <span>${taskStatusMeta.failed.label} ${counts.failed}</span>
    <span>${taskStatusMeta.deleted.label} ${counts.deleted}</span>
  `;
  return summary;
}

function createTaskNode(task, depth, inheritedTags) {
  const inherited = [...inheritedTags, ...task.tags];
  const visibleTags = depth > 0 ? [...inheritedTags, ...task.tags] : task.tags;
  const hasChildren = Boolean(task.children?.length);
  const isCollapsed = hasChildren && task.collapsed;
  const wrapper = el('article', `task-node depth-${Math.min(depth, 3)}${hasChildren ? ' has-children' : ''}${isCollapsed ? ' is-collapsed' : ''}`);
  wrapper.style.setProperty('--depth', depth);
  const row = el('div', `task-row is-${task.status}${task.long ? ' is-large' : ''}${task.id === editingTaskId ? ' is-editing' : ''}${activeTagPopoverTaskId === task.id ? ' has-tag-popover' : ''}${hasChildren ? ' has-children' : ''}${isCollapsed ? ' is-collapsed' : ''}`);
  row.dataset.taskId = task.id;
  row.dataset.depth = String(depth);
  row.style.setProperty('--depth', depth);
  row.style.setProperty('--accent', getTagColor(visibleTags[0]));

  row.append(createDragHandle(task), createStatusButton(task), createTaskBody(task, visibleTags), createTaskActions(task));
  if (canMoveTask(task)) {
    row.querySelector('.drag-handle')?.addEventListener('pointerdown', (event) => {
      startDrag(event, task.id, row);
    });
  }
  if (hasChildren) {
    row.append(createCollapseToggle(task));
  }
  const branch = el('div', 'tree-branch');
  branch.append(el('span', `tree-leaf-node${hasChildren ? ' has-children' : ''}`));
  wrapper.append(branch, row);

  if (hasChildren) {
    const children = el('div', `children${isCollapsed ? ' is-collapsed' : ''}`);
    getVisibleTaskTree(task.children).forEach((child) => children.append(createTaskNode(child, depth + 1, inherited)));
    if (children.childElementCount > 0) {
      wrapper.append(children);
    }
  }

  return wrapper;
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

function createStatusButton(task) {
  const button = el('button', `status-button ${task.status}`);
  button.setAttribute('aria-label', taskStatusMeta[task.status].label);
  button.textContent = taskStatusMeta[task.status].symbol;
  if (task.status === 'active' || task.status === 'completed') {
    button.title = task.status === 'active' ? '标记完成' : '改为进行中';
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      toggleTaskCompletion(task.id);
    });
  }
  return button;
}

function createTaskBody(task, visibleTags) {
  const body = el('div', 'task-body');
  const title =
    task.id === editingTaskId ? createTaskTitleInput(task) : createTaskTitleText(task);
  const tags = el('div', 'tag-list');
  const inheritedTagCount = visibleTags.length - task.tags.length;

  visibleTags.forEach((tag, index) => {
    const chip = el('span', 'tag-chip');
    const isInherited = index < inheritedTagCount;
    chip.classList.toggle('is-inherited', isInherited);
    chip.style.setProperty('--tag-color', getSnapshotTagColor(tag, '#9aa8b5'));
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
  if (visibleTags.length > 0) {
    body.append(tags);
  }
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
    if (window.__TAURI__?.core?.invoke) {
      await window.__TAURI__.core.invoke('open_tag_manager_window');
      return;
    }
    window.open('index.html#tag-manager', 'tag-manager', 'width=760,height=520');
  } catch (error) {
    console.error(error);
    showToast('打开长期标签管理失败');
  }
}

function createTaskActions(task) {
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
      createTagAddButton(task),
      actionButton(icon('fail'), 'fail', '标记失败', () => failTask(task.id)),
    );
  }
  if (task.status === 'failed') {
    actions.append(actionButton(icon('restore'), 'restore', '恢复进行中', () => restoreFailedTask(task.id)));
  }
  actions.append(actionButton(icon('trash'), 'delete', '删除', () => softDeleteTask(task.id)));
  return actions;
}

function createNotes() {
  const notes = el('section', 'daily-notes');
  notes.style.setProperty('--note-height', `${dailyNoteHeight}px`);
  notes.innerHTML = `
    <div class="note-resize-handle" title="拖动调整高度" aria-hidden="true"></div>
    <h2>今日所思所想</h2>
    <textarea class="note-editor" aria-label="今日所思所想" placeholder="记录今天的想法..."></textarea>
  `;
  const editor = notes.querySelector('.note-editor');
  editor.value = dailyNoteText;
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

function createTaskTitleText(task) {
  const title = el('div', 'task-title');
  appendHighlightedText(title, task.title || '未命名任务', getNormalizedSearchQuery());
  if (canEditTask(task)) {
    title.title = '点击编辑任务';
    title.addEventListener('click', () => {
      editingTaskId = task.id;
      renderDayView(document.querySelector('.day-window'));
    });
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
      finishTaskEditing(task);
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      cancelEmptyTask(task);
    }
  });
  input.addEventListener('blur', () => {
    finishTaskEditing(task);
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

function bindTagTemplateUpdateHandler(root) {
  if (isTagTemplateUpdateHandlerBound) {
    return;
  }

  isTagTemplateUpdateHandlerBound = true;
  const refreshTemplates = async () => {
    try {
      tagTemplates = await loadTagTemplates();
      activeTagGroupId = tagTemplates.groups.some((group) => group.id === activeTagGroupId)
        ? activeTagGroupId
        : tagTemplates.groups[0]?.id || null;
      activeTagGroupPage = 0;
      renderDayView(root);
    } catch (error) {
      console.error(error);
      showToast('刷新长期标签失败');
    }
  };

  if (window.__TAURI__?.event?.listen) {
    window.__TAURI__.event.listen('calendar://tag-templates-updated', refreshTemplates);
  }

  window.addEventListener('calendar://tag-templates-updated', refreshTemplates);
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
  renderDayView(root);

  try {
    const [storedDay, storedTagTemplates, storedLocation] = await Promise.all([
      loadDay(currentDay.date),
      loadTagTemplates(),
      loadStorageLocation(),
    ]);
    tagTemplates = storedTagTemplates;
    storageLocation = storedLocation;
    activeTagGroupId ||= tagTemplates.groups[0]?.id || null;
    currentDay = normalizeDay(storedDay || currentDay);
  } catch (error) {
    loadErrorMessage = '读取本地数据失败，当前显示临时数据';
    console.error(error);
    currentDay = createEmptyDay(currentDay.date);
  }

  taskState = currentDay.tasks;
  dailyNoteText = currentDay.note;
  isDayLoading = false;
  renderDayView(root);
  renderNotesOnly(root);
}

async function reloadCurrentStorage(root) {
  currentDay = createEmptyDay(currentDay.date);
  taskState = currentDay.tasks;
  dailyNoteText = currentDay.note;
  activeTagPopoverTaskId = null;
  activeTagPopoverAnchor = null;
  activeTagGroupId = null;
  activeTagGroupPage = 0;
  await loadCurrentDay(root);
}

async function switchDay(root, offsetDays) {
  if (!root || isDayLoading) {
    return;
  }

  const nextDate = shiftDateKey(currentDay.date, offsetDays);
  if (nextDate === currentDay.date) {
    return;
  }

  try {
    await persistCurrentDayNow();
  } catch (error) {
    console.error(error);
    showToast('保存当前日期失败');
    return;
  }

  resetTransientDayState();
  currentDay = createEmptyDay(nextDate);
  taskState = currentDay.tasks;
  dailyNoteText = currentDay.note;
  await loadCurrentDay(root);
}

function resetTransientDayState() {
  editingTaskId = null;
  isSearchOpen = false;
  searchQuery = '';
  activeTagPopoverTaskId = null;
  activeTagPopoverAnchor = null;
  activeTagGroupId = null;
  activeTagGroupPage = 0;
  temporaryTagText = '';
  clearDropPreview();
  dragState = null;
  dropPreview = null;
  document.body.classList.remove('is-task-dragging');
}

function normalizeDay(day) {
  const tasks = Array.isArray(day.tasks) ? day.tasks : [];
  return {
    date: day.date || currentDay.date,
    note: day.note || '',
    tasks: normalizeTaskTree(normalizeTaskTags(tasks, tagPalette)),
  };
}

function createEmptyDay(date) {
  return {
    date,
    note: '',
    tasks: [],
  };
}

function persistCurrentDaySoon() {
  if (isDayLoading) {
    return;
  }

  currentDay = {
    ...currentDay,
    note: dailyNoteText,
    tasks: taskState,
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
    event.defaultPrevented
    || editingTaskId
    || isSearchOpen
    || dragState
    || target?.closest('input, textarea, select, [contenteditable="true"]')
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
  persistCurrentDaySoon();
  renderDayView(root);
  revealTaskAfterRender(root, task.id);
}

function addChildTask(parentId) {
  const parent = findTask(taskState, parentId);
  const root = document.querySelector('.day-window');
  if (!parent || !root) {
    return;
  }

  const child = createBlankTask();
  parent.children ||= [];
  parent.children.push(child);
  parent.collapsed = false;
  editingTaskId = child.id;
  persistCurrentDaySoon();
  renderDayView(root);
  revealTaskAfterRender(root, child.id);
}

function revealTaskAfterRender(root, taskId) {
  window.requestAnimationFrame(() => {
    const row = Array.from(root?.querySelectorAll('.task-row') || [])
      .find((item) => item.dataset.taskId === taskId);
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

function animateChildrenCollapse(row, wrapper, children, collapsed) {
  const root = document.querySelector('.day-window');
  const toggle = row.querySelector('.collapse-toggle');
  const currentHeight = children.classList.contains('is-collapsed') ? 0 : children.scrollHeight;
  children.classList.add('is-animating');
  children.style.setProperty('--children-height', `${currentHeight}px`);
  children.getBoundingClientRect();

  row.classList.toggle('is-collapsed', collapsed);
  wrapper.classList.toggle('is-collapsed', collapsed);
  toggle?.setAttribute('aria-expanded', String(!collapsed));

  if (collapsed) {
    children.classList.add('is-collapsed');
    window.requestAnimationFrame(() => {
      children.style.setProperty('--children-height', '0px');
      applyTreeBranchLayout(root);
    });
    finishChildrenAnimation(root, [children]);
    return;
  }

  children.classList.remove('is-collapsed');
  children.style.setProperty('--children-height', '0px');
  children.getBoundingClientRect();
  const targetHeight = children.scrollHeight;
  window.requestAnimationFrame(() => {
    children.style.setProperty('--children-height', `${targetHeight}px`);
    applyTreeBranchLayout(root);
  });
  finishChildrenAnimation(root, [children]);
}

function finishChildrenAnimation(root, animatedChildren) {
  window.setTimeout(() => {
    animatedChildren.forEach((children) => {
      children.classList.remove('is-animating');
      children.style.removeProperty('--children-height');
    });
    applyTreeBranchLayout(root);
  }, 300);
}

function finishTaskEditing(task) {
  const normalizedTitle = task.title.trim();
  if (!normalizedTitle) {
    removeTask(taskState, task.id);
  } else {
    task.title = normalizedTitle;
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

  animateTaskLayout(document.querySelector('.day-window'), () => {
    const nextStatus = task.status === 'active' ? 'completed' : 'active';
    task.status = nextStatus;
    if (nextStatus === 'completed' && task.children?.length) {
      task.collapsed = true;
    }
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
  });
}

function softDeleteTask(taskId) {
  const task = findTask(taskState, taskId);
  if (!task) {
    return;
  }
  const root = document.querySelector('.day-window');
  animateTaskLayout(root, () => {
    task.previousStatus = task.status;
    task.status = 'deleted';
  }, { disappearingTaskId: showDeletedTasks ? null : taskId });
}

function restoreTask(taskId) {
  const task = findTask(taskState, taskId);
  if (!task) {
    return;
  }
  animateTaskLayout(document.querySelector('.day-window'), () => {
    task.status = task.previousStatus && task.previousStatus !== 'deleted' ? task.previousStatus : 'active';
    delete task.previousStatus;
  });
}

function destroyTask(taskId) {
  const task = findTask(taskState, taskId);
  if (!task) {
    return;
  }
  showDestroyConfirm(task);
}

function renderDayView(root) {
  if (!root) {
    return;
  }
  const currentList = root.querySelector('.task-list');
  const scrollTop = currentList?.scrollTop ?? 0;
  root.querySelector('.day-header')?.replaceWith(createHeader(root));
  root.querySelector('.day-toolbar')?.replaceWith(createToolbar(root));
  const nextList = createTaskList(taskState);
  currentList?.replaceWith(nextList);
  nextList.scrollTop = scrollTop;
  root.querySelector('.tag-popover-layer')?.replaceWith(createTagPopoverLayer());
  bindTagPopoverScrollHandler(root);
  queueTaskTreeLayout(root);
}

function renderTaskAreaOnly(root) {
  if (!root) {
    return;
  }
  const currentList = root.querySelector('.task-list');
  const scrollTop = currentList?.scrollTop ?? 0;
  const nextList = createTaskList(taskState);
  currentList?.replaceWith(nextList);
  nextList.scrollTop = scrollTop;
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
    root.querySelector(`.task-row[data-task-id="${activeTagPopoverTaskId}"]`)?.classList.add('has-tag-popover');
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
      row.addEventListener('transitionend', () => {
        row.style.transition = '';
        row.style.transform = '';
      }, { once: true });
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

function saveAndPreviewTheme(settings) {
  themeSettings = saveThemeSettings(settings);
  applyThemeSettings(themeSettings);
  return { ...themeSettings };
}

function showSettingsDialog(initialTab = 'theme') {
  closeDialog();
  let draftTheme = { ...themeSettings };
  let activeSettingsTab = initialTab;
  const overlay = el('div', 'dialog-overlay settings-overlay');
  overlay.innerHTML = `
    <section class="settings-dialog" role="dialog" aria-modal="true" aria-labelledby="settings-title">
      <header class="settings-header">
        <div>
          <h2 id="settings-title">设置</h2>
          <p class="settings-subtitle">调整日视图体验和本地数据位置。</p>
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
    if (!grid) {
      return;
    }
    grid.replaceChildren();
    themePresets.forEach((preset) => {
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
        draftTheme = saveAndPreviewTheme({ ...draftTheme, presetId: preset.id });
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
        <span>背景透明度</span>
        <strong class="theme-opacity-value">${Math.round(draftTheme.opacity * 100)}%</strong>
        <input class="theme-opacity-input" type="range" min="34" max="82" step="1" value="${Math.round(draftTheme.opacity * 100)}" />
      </label>
    `;
    renderThemePresets();
    const opacityInput = overlay.querySelector('.theme-opacity-input');
    const opacityValue = overlay.querySelector('.theme-opacity-value');
    opacityInput?.addEventListener('input', () => {
      const opacity = Number(opacityInput.value) / 100;
      opacityValue.textContent = `${opacityInput.value}%`;
      draftTheme = saveAndPreviewTheme({ ...draftTheme, opacity });
    });
  };

  const renderDataPanel = async () => {
    panel.innerHTML = `
      <div class="settings-section-title">数据存储位置</div>
      <p class="storage-description">任务、随笔和长期标签都会从这里读取，并保存到这里。</p>
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
        showConfirmDialog({
          title: '确认切换存储位置？',
          message: '应用会改从新文件夹读取和保存数据。旧数据不会自动迁移；新文件夹为空时，内容也会显示为空。',
          confirmText: '确认切换',
          confirmStyle: 'primary',
          onConfirm: async () => {
            await flushDaySave();
            storageLocation = await setStorageLocation(path);
            await reloadCurrentStorage(document.querySelector('.day-window'));
            renderDataPanel();
            showToast('已切换数据存储位置');
          },
        });
      } catch (error) {
        console.error(error);
        showToast('选择存储位置失败');
      }
    });

    panel.querySelector('.reset-storage')?.addEventListener('click', () => {
      showConfirmDialog({
        title: '确认恢复默认存储位置？',
        message: '应用会改回默认文件夹读取和保存数据。当前自定义文件夹里的数据不会被移动或删除。',
        confirmText: '确认恢复',
        confirmStyle: 'primary',
        onConfirm: async () => {
          await flushDaySave();
          storageLocation = await resetStorageLocation();
          await reloadCurrentStorage(document.querySelector('.day-window'));
          renderDataPanel();
          showToast('已恢复默认存储位置');
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
    draftTheme = saveAndPreviewTheme({ presetId: 'morning', opacity: 0.58 });
    renderThemePanel();
  });
  overlay.querySelectorAll('.settings-tab').forEach((button) => {
    button.addEventListener('click', () => {
      activeSettingsTab = button.dataset.settingsTab || 'theme';
      renderSettingsTab();
    });
  });
  overlay.querySelector('.save-settings')?.addEventListener('click', closeDialog);
  overlay.querySelector('.settings-close')?.addEventListener('click', closeDialog);
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) {
      closeDialog();
    }
  });
  overlay.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      closeDialog();
    }
  });

  document.body.append(overlay);
  renderSettingsTab();
  queueMicrotask(() => overlay.querySelector('.theme-preset.is-active, .choose-storage')?.focus({ preventScroll: true }));
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

function closeDialog() {
  const overlays = document.querySelectorAll('.dialog-overlay');
  overlays[overlays.length - 1]?.remove();
}

function showToast(message) {
  document.querySelector('.toast')?.remove();
  const toast = el('div', 'toast');
  toast.textContent = message;
  document.body.append(toast);
  window.setTimeout(() => {
    toast.classList.add('is-hiding');
    toast.addEventListener('animationend', () => toast.remove(), { once: true });
  }, 1800);
}

function getVisibleTaskTree(items) {
  return getVisibleTaskTreeByState(items, { showDeletedTasks, searchQuery });
}

function getNormalizedSearchQuery() {
  return normalizeSearchQuery(searchQuery);
}

function startDrag(event, taskId, row) {
  if (event.button !== 0 || editingTaskId) {
    return;
  }
  const task = findTask(taskState, taskId);
  if (!task || !canMoveTask(task)) {
    return;
  }
  if (!event.target.closest('.drag-handle')) {
    return;
  }
  event.preventDefault();

  dragState = {
    taskId,
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    row,
    isDragging: false,
    accent: row.style.getPropertyValue('--accent') || '#8da2b8',
    previewHeight: row.offsetHeight,
    stableTarget: null,
    emptySince: null,
  };

  row.setPointerCapture?.(event.pointerId);
  row.addEventListener('lostpointercapture', cancelDrag, { once: true });
}

function handleDragMove(event) {
  if (!dragState || event.pointerId !== dragState.pointerId) {
    return;
  }

  const distance = Math.hypot(event.clientX - dragState.startX, event.clientY - dragState.startY);
  if (!dragState.isDragging && distance < 6) {
    return;
  }

  if (!dragState.isDragging) {
    dragState.isDragging = true;
    dragState.row.classList.add('is-dragging');
    document.body.classList.add('is-task-dragging');
    createDropPreview(dragState.previewHeight);
  }

  const previewRect = getCurrentPreviewRect();
  const target = getStableDropTarget(getDropTargetWithoutPreview(event), event, previewRect);
  if (!target) {
    clearDropPreview();
    dropPreview = null;
    return;
  }

  dropPreview = target;
  placeDropPreview(target);
}

function finishDrag(event) {
  if (!dragState || event.pointerId !== dragState.pointerId) {
    return;
  }

  const taskId = dragState.taskId;
  const target = dropPreview;
  const shouldMove = dragState.isDragging && target && target.parentId !== taskId && !isDescendantTask(taskId, target.parentId);

  cleanupDrag();

  if (shouldMove) {
    animateTaskLayout(document.querySelector('.day-window'), () => {
      moveTaskWithinTree(taskState, taskId, target.parentId, target.index, { showDeletedTasks });
    });
  }
}

function cancelDrag() {
  if (!dragState) {
    return;
  }
  cleanupDrag();
}

function cancelDragContextMenu(event) {
  if (!dragState?.isDragging) {
    return;
  }
  event.preventDefault();
  cleanupDrag();
}

function cleanupDrag() {
  dragState?.row.classList.remove('is-dragging');
  document.body.classList.remove('is-task-dragging');
  clearDropPreview();
  dragState = null;
  dropPreview = null;
}

function getDropTarget(event) {
  const hoveredRow = document.elementFromPoint(event.clientX, event.clientY)?.closest('.task-row');
  const taskInfo = hoveredRow ? getTaskLocation(taskState, hoveredRow.dataset.taskId) : null;

  if (!hoveredRow || !taskInfo || taskInfo.task.id === dragState.taskId) {
    return getGapDropTarget(event);
  }

  if (isDescendantTask(dragState.taskId, taskInfo.task.id)) {
    return null;
  }

  const rect = hoveredRow.getBoundingClientRect();
  const gap = getRowGap(event.clientY, rect);
  if (!gap) {
    return null;
  }

  const asChild = event.clientX >= getChildThresholdX(hoveredRow);
  const childTarget = asChild && gap === 'after' && canAcceptChildTask(taskInfo.task)
    ? {
        parentId: taskInfo.task.id,
        index: taskInfo.task.children?.length || 0,
        mode: 'child',
        anchorRow: hoveredRow,
      }
    : null;

  if (childTarget && !isDescendantTask(dragState.taskId, childTarget.parentId)) {
    return resolveDropTarget(childTarget);
  }

  const siblingTarget = {
    parentId: taskInfo.parentId,
    index: getDropIndexAroundTask(taskInfo.parentId, taskInfo.task.id, gap),
    mode: gap,
    anchorRow: hoveredRow,
  };
  return resolveDropTarget(siblingTarget);
}

function getDropTargetWithoutPreview(event) {
  const preview = document.querySelector('.drop-preview');
  preview?.remove();
  return getDropTarget(event);
}

function getGapDropTarget(event) {
  const list = document.querySelector('.task-list');
  if (!list?.contains(document.elementFromPoint(event.clientX, event.clientY))) {
    return null;
  }

  const rows = [...document.querySelectorAll('.task-row:not(.is-dragging)')];
  if (rows.length === 0) {
    return { parentId: null, index: 0, mode: 'root' };
  }

  const trailingTarget = getTrailingDropTarget(event, rows);
  if (trailingTarget) {
    return trailingTarget;
  }

  const nearest = rows.reduce((best, row) => {
    const rect = row.getBoundingClientRect();
    const topDistance = Math.abs(event.clientY - rect.top);
    const bottomDistance = Math.abs(event.clientY - rect.bottom);
    const distance = Math.min(topDistance, bottomDistance);
    const edge = topDistance <= bottomDistance ? 'before' : 'after';
    return distance < best.distance ? { row, distance, edge } : best;
  }, { row: rows[0], distance: Number.POSITIVE_INFINITY }).row;

  const rect = nearest.getBoundingClientRect();
  const distance = Math.min(Math.abs(event.clientY - rect.top), Math.abs(event.clientY - rect.bottom));
  const edge = Math.abs(event.clientY - rect.top) <= Math.abs(event.clientY - rect.bottom) ? 'before' : 'after';
  if (edge === 'after') {
    const afterTarget = getAfterDropTargetFromRow(event, nearest, rect, { requireLastSibling: distance > 24 });
    if (afterTarget) {
      return afterTarget;
    }
  }

  if (distance > 24) {
    return null;
  }

  const info = getTaskLocation(taskState, nearest.dataset.taskId);
  const target = {
    parentId: info.parentId,
    index: getDropIndexAroundTask(info.parentId, info.task.id, edge),
    mode: edge,
    anchorRow: nearest,
  };
  return resolveDropTarget(target);
}

function getTrailingDropTarget(event, rows) {
  const list = document.querySelector('.task-list');
  const listRect = list?.getBoundingClientRect();
  const candidates = rows
    .map((row) => {
      const rect = row.getBoundingClientRect();
      const info = getTaskLocation(taskState, row.dataset.taskId);
      if (!info || info.task.id === dragState.taskId) {
        return null;
      }
      if (event.clientY < rect.bottom || event.clientY > (listRect?.bottom ?? Number.POSITIVE_INFINITY)) {
        return null;
      }
      if (!isLastVisibleSibling(info.parentId, info.task.id)) {
        return null;
      }
      if (!isPointerInRowLevel(event, row, rect)) {
        return null;
      }

      return {
        row,
        rect,
        info,
        depth: Number(row.dataset.depth || 0),
        distance: event.clientY - rect.bottom,
      };
    })
    .filter(Boolean)
    .sort((a, b) => {
      if (b.depth !== a.depth) {
        return b.depth - a.depth;
      }
      return a.distance - b.distance;
    });

  const candidate = candidates[0];
  if (!candidate) {
    return null;
  }

  return getAfterDropTargetFromRow(event, candidate.row, candidate.rect);
}

function isPointerInRowLevel(event, row, rect) {
  const list = document.querySelector('.task-list');
  const listRight = list?.getBoundingClientRect().right ?? Number.POSITIVE_INFINITY;
  const levelLeft = rect.left - getLevelHitSlop(row);
  return event.clientX >= levelLeft && event.clientX <= listRight;
}

function getLevelHitSlop(row) {
  const depth = Number(row.dataset.depth || 0);
  return depth === 0 ? 4 : 22;
}

function getAfterDropTargetFromRow(event, row, rect, { requireLastSibling = false } = {}) {
  if (event.clientY < rect.bottom) {
    return null;
  }

  const info = getTaskLocation(taskState, row.dataset.taskId);
  if (!info || info.task.id === dragState.taskId) {
    return null;
  }

  if (requireLastSibling && !isLastVisibleSibling(info.parentId, info.task.id)) {
    return null;
  }

  const childTarget = event.clientX >= getChildThresholdX(row) && canAcceptChildTask(info.task)
    ? {
        parentId: info.task.id,
        index: info.task.children?.length || 0,
        mode: 'child',
        anchorRow: row,
      }
    : null;

  if (childTarget && !isDescendantTask(dragState.taskId, childTarget.parentId)) {
    return resolveDropTarget(childTarget);
  }

  return resolveDropTarget({
    parentId: info.parentId,
    index: getDropIndexAroundTask(info.parentId, info.task.id, 'after'),
    mode: 'after',
    anchorRow: row,
  });
}

function isLastVisibleSibling(parentId, taskId) {
  const siblings = getVisibleSiblings(parentId).filter((task) => task.id !== dragState.taskId);
  return siblings[siblings.length - 1]?.id === taskId;
}

function getRowGap(clientY, rect) {
  const edgeSize = Math.min(12, rect.height * 0.28);
  if (clientY - rect.top <= edgeSize) {
    return 'before';
  }
  if (rect.bottom - clientY <= edgeSize) {
    return 'after';
  }
  return null;
}

function getChildThresholdX(row) {
  const wrapper = row.closest('.task-node');
  const children = wrapper?.querySelector(':scope > .children');
  const firstChildRow = children?.querySelector(':scope > .task-node > .task-row');

  if (firstChildRow) {
    return firstChildRow.querySelector('.drag-handle')?.getBoundingClientRect().left
      ?? firstChildRow.getBoundingClientRect().left;
  }

  const depth = Number(row.dataset.depth || 0);
  return row.getBoundingClientRect().left + (depth >= 3 ? 18 : 26);
}

function getStableDropTarget(candidate, event, previewRect = getCurrentPreviewRect()) {
  if (!candidate) {
    if (dragState.stableTarget && isPointerInsideRect(event, previewRect)) {
      dragState.emptySince = null;
      return dragState.stableTarget;
    }
    if (dragState.stableTarget) {
      dragState.emptySince ??= performance.now();
      if (performance.now() - dragState.emptySince < 80) {
        return dragState.stableTarget;
      }
    }
    dragState.stableTarget = null;
    dragState.emptySince = null;
    return null;
  }

  dragState.emptySince = null;
  dragState.stableTarget = candidate;
  return candidate;
}

function getCurrentPreviewRect() {
  const preview = document.querySelector('.drop-preview');
  return preview?.getBoundingClientRect() || null;
}

function isPointerInsideRect(event, rect) {
  if (!rect) {
    return false;
  }
  return (
    event.clientX >= rect.left
    && event.clientX <= rect.right
    && event.clientY >= rect.top
    && event.clientY <= rect.bottom
  );
}

function resolveDropTarget(target) {
  if (!target || target.parentId === dragState.taskId || isDescendantTask(dragState.taskId, target.parentId)) {
    return null;
  }

  const origin = getTaskLocation(taskState, dragState.taskId);
  if (!origin) {
    return null;
  }

  const resolved = normalizeTargetForStatus(target);
  if (!resolved) {
    return null;
  }

  if (isNoopDrop(resolved, origin)) {
    return null;
  }

  return resolved;
}

function normalizeTargetForStatus(target) {
  const dragged = findTask(taskState, dragState.taskId);
  const siblings = getVisibleSiblings(target.parentId).filter((task) => task.id !== dragState.taskId);
  if (!dragged || !siblings) {
    return null;
  }

  const statusOrder = taskStatusMeta[dragged.status].order;
  const intendedIndex = Math.max(0, Math.min(target.index, siblings.length));
  let minIndex = 0;
  let maxIndex = siblings.length;

  siblings.forEach((task, index) => {
    const order = taskStatusMeta[task.status].order;
    if (order < statusOrder) {
      minIndex = Math.max(minIndex, index + 1);
    }
    if (order > statusOrder) {
      maxIndex = Math.min(maxIndex, index);
    }
  });

  return {
    ...target,
    index: Math.max(minIndex, Math.min(intendedIndex, maxIndex)),
    mode: target.mode === 'child' ? 'child' : 'slot',
  };
}

function isNoopDrop(target, origin) {
  if (origin.parentId !== target.parentId) {
    return false;
  }

  const visibleSiblings = getVisibleSiblings(target.parentId);
  const originVisibleIndex = visibleSiblings.findIndex((task) => task.id === origin.task.id);
  const withoutDragged = visibleSiblings.filter((task) => task.id !== origin.task.id);
  const beforeTask = withoutDragged[target.index] || null;
  const currentBeforeTask = withoutDragged[originVisibleIndex] || null;
  return beforeTask?.id === currentBeforeTask?.id;
}

function createDropPreview(height) {
  clearDropPreview();
  const preview = el('div', 'drop-preview');
  document.body.append(preview);
}

function placeDropPreview(target) {
  const preview = ensureDropPreview();

  const container = getPreviewContainer(target);
  const beforeNode = getPreviewBeforeNode(target);
  container.insertBefore(preview, beforeNode);
  preview.classList.toggle('as-child', target.mode === 'child');
  preview.dataset.hint = target.mode === 'child' ? '成为子任务' : '移动到这里';
}

function clearDropPreview() {
  document.querySelector('.drop-preview')?.remove();
}

function ensureDropPreview() {
  let preview = document.querySelector('.drop-preview');
  if (!preview) {
    preview = el('div', 'drop-preview');
    document.body.append(preview);
  }
  preview.style.setProperty('--preview-accent', dragState?.accent || '#8da2b8');
  return preview;
}

function getPreviewContainer(target) {
  if (target.parentId === null) {
    return document.querySelector('.task-tree');
  }

  const parentWrapper = getTaskRow(target.parentId)?.closest('.task-node');
  let children = parentWrapper?.querySelector(':scope > .children');
  if (!children && parentWrapper) {
    children = el('div', 'children');
    parentWrapper.append(children);
  }
  return children || document.querySelector('.task-tree');
}

function getPreviewBeforeNode(target) {
  const siblings = getVisibleSiblings(target.parentId).filter((task) => task.id !== dragState.taskId);
  const beforeTask = siblings?.[target.index];
  if (!beforeTask) {
    return null;
  }
  return getTaskRow(beforeTask.id)?.closest('.task-node') || null;
}

function getTaskRow(taskId) {
  return document.querySelector(`.task-row[data-task-id="${taskId}"]`);
}

function getChildrenByParentId(parentId) {
  return getTreeChildrenByParentId(taskState, parentId);
}

function getVisibleSiblings(parentId) {
  return getTreeVisibleSiblings(taskState, parentId, showDeletedTasks);
}

function getDropIndexAroundTask(parentId, taskId, edge) {
  return getTreeDropIndexAroundTask(taskState, parentId, taskId, edge, {
    draggedTaskId: dragState.taskId,
    showDeletedTasks,
  });
}

function isDescendantTask(taskId, possibleDescendantId) {
  if (!possibleDescendantId) {
    return false;
  }
  const task = findTask(taskState, taskId);
  return hasDescendant(task, possibleDescendantId);
}

function canMoveTask(task) {
  return canMoveTaskByState(task, searchQuery);
}

function getTagColor(tag, fallback = '#8da2b8') {
  if (typeof tag === 'string') {
    return tagPalette[tag] || fallback;
  }
  return getSnapshotTagColor(tag, fallback);
}
