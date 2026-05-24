import {
  createTagGroup,
  createTagTemplate,
  normalizeTagTemplates,
  tagColors,
} from '../domain/tags.mjs';
import {
  applyThemeSettings,
  loadThemeSettings,
} from '../domain/theme.mjs';
import { loadTagTemplates, saveTagTemplates } from '../storage/tag-template-storage.mjs';
import { el, escapeHtml } from '../ui/dom.mjs';
import { icon } from '../ui/icons.mjs';
import { createWindowTitleBar } from '../ui/window-titlebar.mjs';

let templates = normalizeTagTemplates(null);
let activeGroupId = templates.groups[0]?.id || null;
let selectedColor = tagColors[0];
let dragState = null;
let isEscapeCloseBound = false;

export function createTagManagerWindow() {
  applyThemeSettings(loadThemeSettings());

  const root = el('section', 'tag-manager-window');
  root.append(createTitleBar(), createTagManagerPage({ standalone: true }));
  root.addEventListener('pointermove', handleDragMove);
  root.addEventListener('pointerup', () => finishDrag(root));
  root.addEventListener('pointercancel', cancelDrag);
  bindEscapeCloseShortcut();
  loadTemplatesInto(root);
  return root;
}

export async function openTagManagerPage({ onClose, onSaved } = {}) {
  document.querySelector('.tag-manager-page')?.remove();

  const page = createTagManagerPage({
    onClose: () => {
      cancelDrag();
      page.remove();
      onClose?.();
    },
    onSaved,
  });
  page.addEventListener('pointermove', handleDragMove);
  page.addEventListener('pointerup', () => finishDrag(page, onSaved));
  page.addEventListener('pointercancel', cancelDrag);
  document.body.append(page);
  await loadTemplatesInto(page, onSaved);
}

function createTitleBar() {
  return createWindowTitleBar({
    title: '长期标签管理',
    className: 'tag-manager-titlebar',
    onMinimize: () => window.calendarShell?.minimize?.(),
    onClose: () => window.calendarShell?.close?.(),
  });
}

function createTagManagerPage({ standalone = false, onClose } = {}) {
  const page = el('section', `tag-manager-page${standalone ? ' tag-manager-standalone' : ''}`);
  page.setAttribute('role', 'dialog');
  page.setAttribute('aria-modal', 'true');
  page.innerHTML = `
    <header class="tag-manager-page-header">
      ${onClose ? '<button class="dialog-button secondary tag-manager-back" type="button">返回</button>' : ''}
      <div>
        <h2>长期标签管理</h2>
        <p>管理常用标签模板，不会修改已经添加到任务中的标签。</p>
      </div>
    </header>
    <div class="tag-manager-body">
      <section class="tag-manager-groups">
        <div class="tag-manager-section-title">分组</div>
        <div class="tag-manager-group-list" aria-live="polite"></div>
        <div class="tag-manager-add-row">
          <input class="tag-manager-group-input" type="text" placeholder="新分组名称" aria-label="新分组名称" />
          <button class="dialog-button add-group icon-only" type="button" title="新建分组" aria-label="新建分组">${icon('plus')}</button>
        </div>
      </section>
      <section class="tag-manager-tags">
        <div class="tag-manager-section-title">分组下的标签</div>
        <div class="tag-manager-tag-list" aria-live="polite"></div>
        <div class="tag-manager-add-row">
          <input class="tag-manager-tag-input" type="text" placeholder="新标签名称" aria-label="新标签名称" />
          <button class="dialog-button add-template-tag" type="button">新建标签</button>
          <div class="tag-manager-color-row"></div>
        </div>
      </section>
    </div>
  `;

  page.querySelector('.tag-manager-back')?.addEventListener('click', onClose);
  renderLoading(page);
  return page;
}

function bindEscapeCloseShortcut() {
  if (isEscapeCloseBound) {
    return;
  }

  isEscapeCloseBound = true;
  window.addEventListener('keydown', handleWindowKeydown);
  window.addEventListener('beforeunload', () => {
    window.removeEventListener('keydown', handleWindowKeydown);
    isEscapeCloseBound = false;
  }, { once: true });
}

function handleWindowKeydown(event) {
  if (event.key !== 'Escape') {
    return;
  }

  event.preventDefault();
  cancelDrag();
  document.querySelector('.dialog-overlay')?.remove();
  window.calendarShell?.close?.();
}

async function loadTemplatesInto(page, onSaved) {
  try {
    templates = await loadTagTemplates();
    syncActiveGroup();
    render(page, onSaved);
    queueMicrotask(() => page.querySelector('.tag-manager-group-input')?.focus({ preventScroll: true }));
  } catch (error) {
    console.error(error);
    renderLoadError(page);
  }
}

function renderLoading(page) {
  page.querySelector('.tag-manager-group-list')?.replaceChildren(emptyState('正在读取分组...'));
  page.querySelector('.tag-manager-tag-list')?.replaceChildren(emptyState('正在读取标签...'));
}

function renderLoadError(page) {
  page.querySelector('.tag-manager-group-list')?.replaceChildren(emptyState('读取长期标签失败'));
  page.querySelector('.tag-manager-tag-list')?.replaceChildren(emptyState('请稍后重试'));
}

function render(page, onSaved) {
  renderGroups(page, onSaved);
  renderTags(page, onSaved);
  renderColorRow(page);
}

function renderGroups(page, onSaved) {
  const list = page.querySelector('.tag-manager-group-list');
  list.replaceChildren();

  templates.groups.forEach((group) => {
    const item = el('div', `tag-manager-group-item${group.id === activeGroupId ? ' is-active' : ''}`);
    item.dataset.groupId = group.id;
    item.innerHTML = `
      ${dragHandleMarkup()}
      <span class="tag-manager-group-name" title="${escapeHtml(group.name)}">${escapeHtml(group.name)}</span>
      <button class="action-button edit-group" type="button" title="编辑分组" aria-label="编辑分组">${icon('edit')}</button>
      <button class="action-button delete-group" type="button" title="删除分组" aria-label="删除分组">${icon('trash')}</button>
    `;
    item.addEventListener('click', (event) => {
      if (event.target.closest('button, input')) {
        return;
      }
      activeGroupId = group.id;
      render(page, onSaved);
    });
    item.querySelector('.manager-drag-handle')?.addEventListener('pointerdown', (event) => {
      startDrag(event, 'group', group.id);
    });
    item.querySelector('.edit-group')?.addEventListener('click', () => editGroupName(item, group, page, onSaved));
    item.querySelector('.delete-group')?.addEventListener('click', () => {
      if (templates.groups.length <= 1) {
        showToast('至少保留一个分组');
        return;
      }
      showConfirm({
        title: '删除分组',
        message: `确认删除分组“${group.name}”吗？该分组下的长期标签也会被删除，但不会影响已经添加到任务中的标签。`,
        confirmText: '删除分组',
        onConfirm: async () => {
          templates.groups = templates.groups.filter((itemGroup) => itemGroup.id !== group.id);
          activeGroupId = templates.groups[0]?.id || null;
          await saveAndRender(page, onSaved);
        },
      });
    });
    list.append(item);
  });

  page.querySelector('.add-group').onclick = async () => {
    const input = page.querySelector('.tag-manager-group-input');
    const name = input.value.trim();
    if (!name) {
      showToast('请输入分组名称');
      input.focus({ preventScroll: true });
      return;
    }
    const group = createTagGroup(name);
    templates.groups.push(group);
    activeGroupId = group.id;
    input.value = '';
    await saveAndRender(page, onSaved);
  };
}

function editGroupName(item, group, page, onSaved) {
  cancelDrag();
  const nameNode = item.querySelector('.tag-manager-group-name');
  const input = el('input', 'tag-manager-inline-input');
  input.type = 'text';
  input.value = group.name;
  input.setAttribute('aria-label', '分组名称');
  nameNode.replaceWith(input);
  let isSaving = false;

  const save = async () => {
    if (isSaving || !input.isConnected) {
      return;
    }
    const name = input.value.trim();
    if (!name) {
      showToast('分组名称不能为空');
      input.focus({ preventScroll: true });
      return;
    }
    isSaving = true;
    group.name = name;
    await saveAndRender(page, onSaved);
  };

  input.addEventListener('click', (event) => event.stopPropagation());
  input.addEventListener('pointerdown', (event) => event.stopPropagation());
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      save();
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      render(page, onSaved);
    }
  });
  input.addEventListener('blur', save);
  queueMicrotask(() => {
    input.focus({ preventScroll: true });
    input.select();
  });
}

function renderTags(page, onSaved) {
  const list = page.querySelector('.tag-manager-tag-list');
  const title = page.querySelector('.tag-manager-tags > .tag-manager-section-title');
  const group = getActiveGroup();
  list.replaceChildren();

  if (title) {
    title.textContent = group ? `${group.name} 下的标签` : '分组下的标签';
  }

  if (!group) {
    list.append(emptyState('请先创建分组'));
    return;
  }

  if (!group.tags.length) {
    list.append(emptyState('该分组暂无长期标签'));
  }

  group.tags.forEach((template) => {
    const item = el('div', 'tag-manager-tag-item');
    item.dataset.tagId = template.id;
    item.innerHTML = `
      ${dragHandleMarkup()}
      <button class="tag-manager-color-dot" style="--tag-color:${template.color}" type="button" title="点击切换颜色" aria-label="点击切换颜色"></button>
      <input class="tag-manager-inline-input" type="text" value="${escapeHtml(template.text)}" aria-label="标签名称" />
      <button class="action-button delete-template-tag" type="button" title="删除标签" aria-label="删除标签">${icon('trash')}</button>
    `;
    item.querySelector('.manager-drag-handle')?.addEventListener('pointerdown', (event) => {
      startDrag(event, 'tag', template.id);
    });
    item.querySelector('.tag-manager-inline-input')?.addEventListener('change', async (event) => {
      const text = event.target.value.trim();
      if (!text) {
        event.target.value = template.text;
        showToast('请输入标签名称');
        return;
      }
      template.text = text;
      await saveAndRender(page, onSaved);
    });
    item.querySelector('.tag-manager-color-dot')?.addEventListener('click', async () => {
      const index = tagColors.indexOf(template.color);
      template.color = tagColors[(index + 1) % tagColors.length];
      await saveAndRender(page, onSaved);
    });
    item.querySelector('.delete-template-tag')?.addEventListener('click', () => {
      showConfirm({
        title: '删除标签',
        message: `确认删除长期标签“${template.text}”吗？不会影响已经添加到任务中的标签。`,
        confirmText: '删除标签',
        onConfirm: async () => {
          group.tags = group.tags.filter((tag) => tag.id !== template.id);
          await saveAndRender(page, onSaved);
        },
      });
    });
    list.append(item);
  });

  page.querySelector('.add-template-tag').onclick = async () => {
    const input = page.querySelector('.tag-manager-tag-input');
    const group = getActiveGroup();
    const text = input.value.trim();
    if (!text) {
      showToast('请输入标签名称');
      input.focus({ preventScroll: true });
      return;
    }
    if (!group) {
      showToast('请先创建分组');
      return;
    }
    group.tags.push(createTagTemplate(text, selectedColor));
    input.value = '';
    await saveAndRender(page, onSaved);
  };
}

function renderColorRow(page) {
  const row = page.querySelector('.tag-manager-color-row');
  row.replaceChildren();
  tagColors.forEach((color) => {
    const swatch = el('button', `tag-color-swatch${selectedColor === color ? ' is-selected' : ''}`);
    swatch.type = 'button';
    swatch.style.setProperty('--swatch', color);
    swatch.setAttribute('aria-label', `选择颜色 ${color}`);
    swatch.addEventListener('click', () => {
      selectedColor = color;
      renderColorRow(page);
    });
    row.append(swatch);
  });
}

function dragHandleMarkup() {
  return '<button class="manager-drag-handle" type="button" title="拖拽排序" aria-label="拖拽排序"><span></span><span></span><span></span><span></span><span></span><span></span></button>';
}

function startDrag(event, type, id) {
  if (event.button !== 0) {
    return;
  }
  const row = event.currentTarget.closest(type === 'group' ? '.tag-manager-group-item' : '.tag-manager-tag-item');
  const list = row?.parentElement;
  if (!row || !list) {
    return;
  }
  event.preventDefault();
  event.stopPropagation();

  const rect = row.getBoundingClientRect();
  const placeholder = el('div', 'manager-drag-placeholder');
  placeholder.style.width = `${rect.width}px`;
  placeholder.style.height = `${rect.height}px`;
  row.after(placeholder);
  row.style.display = 'none';
  dragState = { type, id, row, list, placeholder };
}

function handleDragMove(event) {
  if (!dragState) {
    return;
  }
  const selector = dragState.type === 'group' ? '.tag-manager-group-item' : '.tag-manager-tag-item';
  const candidates = Array.from(dragState.list.querySelectorAll(selector))
    .filter((item) => item !== dragState.row && item.style.display !== 'none');
  const target = getVerticalDropTarget(candidates, event);
  if (target) {
    dragState.list.insertBefore(dragState.placeholder, target);
  } else {
    dragState.list.append(dragState.placeholder);
  }
}

function getVerticalDropTarget(candidates, event) {
  return candidates.find((item) => {
    const rect = item.getBoundingClientRect();
    return event.clientY < rect.top + rect.height / 2;
  });
}

async function finishDrag(page, onSaved) {
  if (!dragState) {
    return;
  }
  const state = dragState;
  const nextIndex = Array.from(state.list.children).filter((item) => item !== state.row).indexOf(state.placeholder);
  cancelDrag();
  if (nextIndex < 0) {
    return;
  }
  if (state.type === 'group') {
    reorderById(templates.groups, state.id, nextIndex);
    activeGroupId = state.id;
  } else {
    reorderById(getActiveGroup()?.tags || [], state.id, nextIndex);
  }
  await saveAndRender(page, onSaved);
}

function cancelDrag() {
  if (!dragState) {
    return;
  }
  dragState.row.style.display = '';
  dragState.placeholder.remove();
  dragState = null;
}

function reorderById(items, id, nextIndex) {
  const currentIndex = items.findIndex((item) => item.id === id);
  if (currentIndex < 0) {
    return;
  }
  const [item] = items.splice(currentIndex, 1);
  items.splice(Math.min(Math.max(nextIndex, 0), items.length), 0, item);
}

async function saveAndRender(page, onSaved) {
  templates = await saveTagTemplates(templates);
  syncActiveGroup();
  await notifyTagTemplatesUpdated();
  await onSaved?.(templates);
  render(page, onSaved);
}

async function notifyTagTemplatesUpdated() {
  if (window.__TAURI__?.event?.emit) {
    try {
      await window.__TAURI__.event.emit('calendar://tag-templates-updated', {});
    } catch (error) {
      console.error(error);
    }
  }
  window.dispatchEvent(new CustomEvent('calendar://tag-templates-updated'));
}

function syncActiveGroup() {
  activeGroupId = templates.groups.some((group) => group.id === activeGroupId)
    ? activeGroupId
    : templates.groups[0]?.id || null;
}

function getActiveGroup() {
  return templates.groups.find((group) => group.id === activeGroupId) || templates.groups[0] || null;
}

function emptyState(text) {
  const node = el('div', 'tag-template-empty');
  node.textContent = text;
  return node;
}

function showConfirm({ title, message, confirmText, onConfirm }) {
  document.querySelector('.confirm-overlay')?.remove();
  const overlay = el('div', 'dialog-overlay confirm-overlay');
  overlay.innerHTML = `
    <section class="confirm-dialog" role="dialog" aria-modal="true">
      <h2>${escapeHtml(title)}</h2>
      <p>${escapeHtml(message)}</p>
      <div class="dialog-actions">
        <button class="dialog-button cancel" type="button">取消</button>
        <button class="dialog-button danger" type="button">${escapeHtml(confirmText)}</button>
      </div>
    </section>
  `;
  overlay.querySelector('.cancel')?.addEventListener('click', () => overlay.remove());
  overlay.querySelector('.danger')?.addEventListener('click', async () => {
    await onConfirm?.();
    overlay.remove();
  });
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) {
      overlay.remove();
    }
  });
  document.body.append(overlay);
}

function showToast(message) {
  document.querySelector('.toast')?.remove();
  const toast = el('div', 'toast');
  toast.textContent = message;
  document.body.append(toast);
  window.setTimeout(() => toast.remove(), 1800);
}
