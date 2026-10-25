import { taskColorInk } from '../domain/color-ink.mjs';
import { createTagGroup, createTagTemplate, normalizeTagTemplates, tagColors } from '../domain/tags.mjs';
import { applyThemeSettings, loadThemeSettings } from '../domain/theme.mjs';
import { loadTagTemplates, saveTagTemplates } from '../storage/tag-template-storage.mjs';
import { el } from '../ui/dom.mjs';
import { icon } from '../ui/icons.mjs';
import { createTagManagerSort } from '../ui/tag-manager-sort.mjs';
export function createTagManagerPanel({ onSaved, onBusyChange } = {}) {
  const page = el('section', 'tag-manager-page tag-manager-embedded');
  page.setAttribute('aria-label', '长期标签管理');
  page.innerHTML = `
    <header class="tag-manager-page-header">
      <div class="tag-manager-heading"><h2>长期标签</h2><p>把常用标签收进分组，添加任务时随手选用。</p></div>
      <button class="tag-manager-new-button" type="button">${icon('plus')}<span>新建分组</span></button>
    </header>
    <div class="tag-manager-body">
      <div class="tag-manager-new-group"></div>
      <div class="tag-manager-group-list" data-sort-type="group"></div>
    </div>
    <footer class="tag-manager-footer"><span class="tag-manager-summary"></span><span class="tag-manager-save-status" role="status" aria-live="polite">正在读取…</span><p>单击标签编辑 · 长按拖拽排序 · 修改模板不会影响任务中已有的标签</p></footer>
  `;
  const abort = new AbortController();
  const options = { signal: abort.signal };
  const body = page.querySelector('.tag-manager-body');
  const list = page.querySelector('.tag-manager-group-list');
  const status = page.querySelector('.tag-manager-save-status');
  let templates = null;
  const collapsed = new Set();
  let draft = null; // Inputs appear only after Add or Edit is requested.
  let saving = false;
  let loading = false;
  let flyout = null;
  let confirmation = null;
  let active = false;
  let needsReload = false;
  let loadRevision = 0;
  page.hidden = true;

  const sorter = createTagManagerSort({
    root: page,
    scroller: body,
    canStart: () => active && !draft && !saving && !loading && !flyout && !confirmation,
    onCommit: (type, groupId, ids) =>
      commit((next) => {
        const items = type === 'group' ? next.groups : next.groups.find((group) => group.id === groupId).tags;
        const byId = new Map(items.map((item) => [item.id, item]));
        items.splice(0, items.length, ...ids.map((id) => byId.get(id)));
      }),
  });

  function setStatus(text, error = false) {
    status.textContent = text;
    status.classList.toggle('is-error', error);
  }

  function closeFlyout({ focus = false } = {}) {
    if (!flyout) return;
    const anchor = flyout.anchor;
    anchor.setAttribute('aria-expanded', 'false');
    flyout.node.remove();
    flyout = null;
    if (focus && anchor.isConnected) anchor.focus({ preventScroll: true });
  }

  function openFlyout(anchor, node) {
    closeFlyout();
    node.classList.add('tag-manager-flyout');
    document.body.append(node);
    flyout = { anchor, node };
    anchor.setAttribute('aria-expanded', 'true');
    const rect = anchor.getBoundingClientRect();
    const bounds = node.getBoundingClientRect();
    node.style.left = `${Math.max(8, Math.min(rect.left, innerWidth - bounds.width - 8))}px`;
    node.style.top = `${Math.max(8, Math.min(rect.bottom + 6, innerHeight - bounds.height - 8))}px`;
    node.querySelector('button')?.focus({ preventScroll: true });
  }

  function destroy() {
    closeFlyout();
    confirmation?.remove();
    sorter.destroy();
    abort.abort();
    page.remove();
  }
  page
    .querySelector('.tag-manager-new-button')
    .addEventListener('click', () => beginDraft({ kind: 'group', name: '' }), options);
  document.addEventListener(
    'pointerdown',
    (event) => {
      if (flyout && !flyout.node.contains(event.target) && !flyout.anchor.contains(event.target))
        closeFlyout();
    },
    { ...options, capture: true },
  );
  body.addEventListener('scroll', () => closeFlyout(), options);
  window.addEventListener('resize', () => closeFlyout(), options);
  window.addEventListener(
    'keydown',
    (event) => {
      if (!active || !page.isConnected) return;
      if (event.key === 'Tab' && confirmation) {
        const controls = [...confirmation.querySelectorAll('button:not(:disabled)')];
        const index = controls.indexOf(document.activeElement);
        event.preventDefault();
        controls[(index + (event.shiftKey ? -1 : 1) + controls.length) % controls.length]?.focus();
        return;
      }
      if (event.key !== 'Escape' || event.isComposing) return;
      if (
        !saving &&
        !confirmation &&
        !flyout &&
        !draft &&
        !document.body.classList.contains('is-tag-sorting')
      ) {
        // A pending hold also needs cancelling; otherwise let Settings handle Escape.
        if (!sorter.cancel()) return;
      }
      event.preventDefault();
      event.stopImmediatePropagation();
      if (saving) return;
      if (confirmation) {
        dismissConfirmation();
        return;
      }
      if (sorter.cancel()) return;
      if (flyout) {
        closeFlyout({ focus: true });
        return;
      }
      if (draft) {
        cancelDraft();
        return;
      }
    },
    { ...options, capture: true },
  );
  const refreshTheme = () => applyThemeSettings(loadThemeSettings());
  window.addEventListener('calendar://theme-updated', refreshTheme, options);
  const refreshTemplates = () => {
    if (draft || saving) {
      needsReload = true;
      setStatus('数据位置已切换，请取消当前编辑后重新读取标签', true);
    } else load();
  };
  window.addEventListener('calendar://storage-updated', refreshTemplates, options);
  window.addEventListener(
    'storage',
    (event) => {
      if (event.key === 'desktop-calendar-theme') refreshTheme();
    },
    options,
  );
  if (window.__TAURI__?.event?.listen) {
    for (const [name, handler] of [
      ['calendar://theme-updated', refreshTheme],
      ['calendar://storage-updated', refreshTemplates],
    ]) {
      window.__TAURI__.event
        .listen(name, handler)
        .then((unlisten) => {
          if (abort.signal.aborted) unlisten();
          else abort.signal.addEventListener('abort', unlisten, { once: true });
        })
        .catch(console.error);
    }
  }
  window.addEventListener('beforeunload', destroy, { ...options, once: true });

  function render() {
    closeFlyout();
    const scrollTop = body.scrollTop;
    const editing =
      page.contains(document.activeElement) && document.activeElement.matches('.tag-manager-draft-input');
    const selection = editing
      ? [document.activeElement.selectionStart, document.activeElement.selectionEnd]
      : null;
    list.replaceChildren();
    page.querySelector('.tag-manager-new-group').replaceChildren();
    if (!templates) return;
    if (draft?.kind === 'group' && !draft.groupId)
      page.querySelector('.tag-manager-new-group').append(createEditor());
    templates.groups.forEach((group) => list.append(createGroupCard(group)));
    page.querySelector('.tag-manager-summary').textContent =
      `${templates.groups.length} 个分组 · ${templates.groups.reduce((sum, group) => sum + group.tags.length, 0)} 个标签`;
    body.scrollTop = scrollTop;
    if (selection) {
      const input = page.querySelector('.tag-manager-draft-input');
      input?.focus({ preventScroll: true });
      input?.setSelectionRange(...selection);
    }
  }

  function createGroupCard(group) {
    const card = el('section', 'tag-group-card');
    card.dataset.sortId = group.id;
    card.dataset.groupId = group.id;
    const header = el('div', 'tag-group-card-header');
    header.append(sortHandle('拖拽分组排序（Alt + 方向键）'));
    if (draft?.kind === 'group' && draft.groupId === group.id) header.append(createEditor());
    else {
      const toggle = el('button', 'tag-group-toggle');
      toggle.type = 'button';
      toggle.innerHTML = `${icon('chevron')}${icon('folder')}`;
      toggle.setAttribute('aria-expanded', String(!collapsed.has(group.id)));
      const name = el('span', 'tag-group-name');
      name.textContent = group.name;
      name.title = group.name;
      const count = el('span', 'tag-group-count');
      count.textContent = group.tags.length;
      toggle.append(name, count);
      toggle.addEventListener('click', () => {
        if (saving) return;
        if (draft?.groupId === group.id) {
          focusDraft();
          return;
        }
        if (collapsed.has(group.id)) collapsed.delete(group.id);
        else collapsed.add(group.id);
        render();
        [...list.children]
          .find((item) => item.dataset.groupId === group.id)
          ?.querySelector('.tag-group-toggle')
          ?.focus({ preventScroll: true });
      });
      header.append(toggle);
      const more = actionButton('more', `管理分组 ${group.name}`, 'tag-group-more');
      more.setAttribute('aria-haspopup', 'menu');
      more.setAttribute('aria-expanded', 'false');
      more.addEventListener('click', () => {
        if (saving || loading) return;
        if (flyout?.anchor === more) {
          closeFlyout();
          return;
        }
        const menu = el('div', 'tag-group-menu');
        menu.setAttribute('role', 'menu');
        const rename = actionButton('edit', '重命名', 'tag-group-rename', true);
        const remove = actionButton('trash', '删除分组', 'tag-group-delete', true);
        [rename, remove].forEach((button) => button.setAttribute('role', 'menuitem'));
        remove.disabled = templates.groups.length <= 1;
        if (remove.disabled) remove.title = '至少保留一个分组';
        rename.addEventListener('click', () =>
          beginDraft({ kind: 'group', groupId: group.id, name: group.name }),
        );
        remove.addEventListener('click', () =>
          confirmDelete('分组', group.name, (next) => {
            next.groups = next.groups.filter((item) => item.id !== group.id);
          }),
        );
        menu.append(rename, remove);
        openFlyout(more, menu);
      });
      header.append(more);
    }
    card.append(header);
    if (!collapsed.has(group.id)) {
      const content = el('div', 'tag-group-card-content');
      const tags = el('div', 'tag-manager-chips');
      tags.dataset.sortType = 'tag';
      tags.dataset.groupId = group.id;
      group.tags.forEach((template) => {
        const chip = el('div', 'tag-manager-chip');
        chip.dataset.sortId = template.id;
        chip.style.setProperty('--tag-color', template.color);
        chip.style.setProperty('--tag-ink', taskColorInk(chip.style.getPropertyValue('--tag-color')));
        const edit = el('button', 'tag-manager-chip-edit');
        edit.type = 'button';
        edit.dataset.sortPress = '';
        edit.textContent = template.text;
        edit.title = `编辑标签 ${template.text}（长按拖拽排序，Alt + 方向键也可排序）`;
        edit.addEventListener('click', () =>
          beginDraft({
            kind: 'tag',
            groupId: group.id,
            tagId: template.id,
            name: template.text,
            color: template.color,
          }),
        );
        chip.classList.toggle('is-editing', draft?.tagId === template.id);
        chip.append(edit);
        tags.append(chip);
      });
      if (group.tags.length) content.append(tags);
      if (draft?.kind === 'tag' && draft.groupId === group.id) content.append(createEditor());
      else {
        const add = actionButton('plus', '添加标签', 'tag-manager-add-tag', true);
        add.addEventListener('click', () =>
          beginDraft({ kind: 'tag', groupId: group.id, name: '', color: tagColors[0] }),
        );
        content.append(add);
      }
      card.append(content);
    }
    return card;
  }

  function beginDraft(next) {
    if (saving || loading || !templates) return;
    closeFlyout();
    if (draft) {
      focusDraft();
      setStatus('请先保存或取消当前编辑');
      return;
    }
    draft = next;
    setStatus('编辑中');
    collapsed.delete(next.groupId);
    render();
    focusDraft();
  }

  function focusDraft() {
    const input = page.querySelector('.tag-manager-draft-input');
    input?.focus({ preventScroll: true });
    input?.scrollIntoView({ block: 'nearest' });
  }

  function cancelDraft() {
    const previous = draft;
    closeFlyout();
    draft = null;
    render();
    setStatus('已取消编辑');
    if (needsReload) {
      needsReload = false;
      load();
    }
    const card = [...list.children].find((item) => item.dataset.groupId === previous?.groupId);
    const chip = [...(card?.querySelectorAll('.tag-manager-chip') || [])].find(
      (item) => item.dataset.sortId === previous?.tagId,
    );
    (
      chip?.querySelector('.tag-manager-chip-edit') ||
      card?.querySelector('.tag-manager-add-tag') ||
      page.querySelector('.tag-manager-new-button')
    ).focus({ preventScroll: true });
  }

  function createEditor() {
    const editor = el('form', `tag-manager-editor${draft.kind === 'tag' ? ' is-tag' : ' is-group'}`);
    if (draft.kind === 'tag') {
      editor.style.setProperty('--tag-color', draft.color);
      editor.style.setProperty('--tag-ink', taskColorInk(editor.style.getPropertyValue('--tag-color')));
      const color = actionButton('', '选择标签颜色', 'tag-manager-color-dot');
      color.setAttribute('aria-haspopup', 'dialog');
      color.setAttribute('aria-expanded', 'false');
      color.addEventListener('click', () => {
        if (flyout?.anchor === color) {
          closeFlyout();
          return;
        }
        const palette = el('div', 'tag-manager-palette');
        palette.setAttribute('role', 'dialog');
        palette.setAttribute('aria-label', '标签颜色');
        const colorNames = ['浅蓝', '淡紫', '柔粉', '暖橙', '沙黄', '草绿', '青绿', '蓝灰'];
        tagColors.forEach((value, index) => {
          const swatch = el('button', 'tag-color-swatch');
          swatch.type = 'button';
          swatch.style.setProperty('--swatch', value);
          swatch.style.setProperty('--swatch-ink', taskColorInk(swatch.style.getPropertyValue('--swatch')));
          swatch.setAttribute('aria-label', colorNames[index]);
          swatch.setAttribute('aria-pressed', String(draft.color === value));
          swatch.classList.toggle('is-selected', draft.color === value);
          swatch.addEventListener('click', () => {
            draft.color = value;
            editor.style.setProperty('--tag-color', value);
            editor.style.setProperty('--tag-ink', taskColorInk(editor.style.getPropertyValue('--tag-color')));
            closeFlyout({ focus: true });
          });
          palette.append(swatch);
        });
        openFlyout(color, palette);
      });
      editor.append(color);
    }
    const input = el('input', 'tag-manager-draft-input');
    input.type = 'text';
    input.placeholder = draft.kind === 'tag' ? '标签名称' : '分组名称';
    input.setAttribute('aria-label', input.placeholder);
    input.autocomplete = 'off';
    input.value = draft.name;
    input.addEventListener('input', () => {
      draft.name = input.value;
      input.removeAttribute('aria-invalid');
      setStatus('编辑中');
    });
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && event.isComposing) event.preventDefault();
    });
    const save = actionButton(
      'check',
      draft.tagId || (draft.groupId && draft.kind === 'group') ? '保存修改' : '确认添加',
      'tag-manager-draft-save',
    );
    save.type = 'submit';
    const cancel = actionButton('close', '取消编辑', 'tag-manager-draft-cancel');
    cancel.addEventListener('click', cancelDraft);
    editor.append(input, save, cancel);
    if (draft.tagId) {
      const remove = actionButton('trash', '删除标签', 'tag-manager-draft-delete');
      remove.addEventListener('click', () =>
        confirmDelete('标签', draft.name, (next) => {
          const group = next.groups.find((item) => item.id === draft.groupId);
          group.tags = group.tags.filter((item) => item.id !== draft.tagId);
        }),
      );
      editor.append(remove);
    }
    editor.addEventListener('submit', (event) => {
      event.preventDefault();
      if (saving) return;
      if (!draft.name.trim()) {
        input.setAttribute('aria-invalid', 'true');
        setStatus(`请输入${draft.kind === 'tag' ? '标签' : '分组'}名称`, true);
        input.focus();
        return;
      }
      const current = { ...draft, name: draft.name.trim() };
      commit(
        (next) => {
          if (current.kind === 'group') {
            if (current.groupId)
              next.groups.find((group) => group.id === current.groupId).name = current.name;
            else next.groups.push(createTagGroup(current.name));
          } else {
            const group = next.groups.find((item) => item.id === current.groupId);
            if (current.tagId)
              Object.assign(
                group.tags.find((tag) => tag.id === current.tagId),
                { text: current.name, color: current.color },
              );
            else group.tags.push(createTagTemplate(current.name, current.color));
          }
        },
        { clearDraft: true },
      );
    });
    return editor;
  }

  async function commit(change, { clearDraft = false } = {}) {
    if (saving || loading) return false;
    if (needsReload) {
      setStatus('数据位置已切换，请取消当前编辑后重新读取标签', true);
      return false;
    }
    saving = true;
    let saved = false;
    onBusyChange?.({ busy: true });
    closeFlyout();
    setStatus('正在保存…');
    page.setAttribute('aria-busy', 'true');
    const controls = [...page.querySelectorAll('button,input')].map((node) => [node, node.disabled]);
    controls.forEach(([node]) => {
      node.disabled = true;
    });
    try {
      const next = normalizeTagTemplates(templates);
      change(next);
      templates = await saveTagTemplates(next);
      saved = true;
      if (abort.signal.aborted) return true;
      if (clearDraft) draft = null;
      render();
      setStatus('已保存');
      await notifyTagTemplatesUpdated();
      try {
        await onSaved?.(templates);
      } catch (error) {
        console.error(error);
      }
      return true;
    } catch (error) {
      console.error(error);
      render(); // Restore a failed reorder; keep the editor for retry.
      setStatus('保存失败，请重试', true);
      if (draft) focusDraft();
      return false;
    } finally {
      saving = false;
      page.removeAttribute('aria-busy');
      controls.forEach(([node, disabled]) => {
        node.disabled = disabled;
      });
      if (!abort.signal.aborted) onBusyChange?.({ busy: false, saved });
      if (needsReload && !draft && !abort.signal.aborted) {
        needsReload = false;
        load();
      }
    }
  }

  function dismissConfirmation() {
    confirmation?.remove();
    confirmation = null;
    page.inert = false;
    if (draft) focusDraft();
  }

  function confirmDelete(kind, name, change) {
    closeFlyout();
    if (saving) return;
    if (draft && !(kind === '标签' && draft.tagId)) {
      focusDraft();
      setStatus('请先保存或取消当前编辑');
      return;
    }
    confirmation = el('div', 'dialog-overlay confirm-overlay');
    const dialog = el('section', 'confirm-dialog');
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-label', `删除${kind}`);
    const title = el('h2');
    title.textContent = `删除${kind}`;
    const message = el('p');
    message.textContent = `删除“${name}”${kind === '分组' ? '及其全部标签' : ''}？任务中已有的标签会保留。`;
    const actions = el('div', 'dialog-actions');
    const cancel = el('button', 'dialog-button secondary');
    cancel.type = 'button';
    cancel.textContent = '取消';
    cancel.addEventListener('click', dismissConfirmation);
    const remove = el('button', 'dialog-button danger');
    remove.type = 'button';
    remove.textContent = `删除${kind}`;
    remove.addEventListener('click', async () => {
      if (saving) return;
      remove.disabled = true;
      cancel.disabled = true;
      if (await commit(change, { clearDraft: true })) dismissConfirmation();
      else {
        remove.disabled = false;
        cancel.disabled = false;
      }
    });
    actions.append(cancel, remove);
    dialog.append(title, message, actions);
    confirmation.append(dialog);
    confirmation.addEventListener('click', (event) => {
      if (event.target === confirmation && !saving) dismissConfirmation();
    });
    document.body.append(confirmation);
    page.inert = true;
    cancel.focus();
  }

  async function load() {
    if (abort.signal.aborted) return;
    const revision = ++loadRevision;
    loading = true;
    setStatus('正在读取…');
    try {
      const loaded = await loadTagTemplates();
      if (abort.signal.aborted || revision !== loadRevision) return;
      templates = loaded;
      render();
      setStatus('已保存');
    } catch (error) {
      if (abort.signal.aborted || revision !== loadRevision) return;
      console.error(error);
      setStatus('读取失败，请重试', true);
      const retry = el('button', 'dialog-button secondary');
      retry.textContent = '重新读取';
      retry.addEventListener('click', load);
      list.replaceChildren(retry);
    } finally {
      if (revision === loadRevision) loading = false;
    }
  }
  load();
  return {
    element: page,
    isBusy: () => saving,
    hasDraft: () => Boolean(draft),
    canLeave: () => !saving && !confirmation,
    setActive(value) {
      if (!value && (saving || confirmation)) return false;
      if (!value) {
        closeFlyout();
        sorter.cancel();
      }
      active = value;
      page.hidden = !value;
      page.inert = !value;
      return true;
    },
    focus() {
      if (draft) focusDraft();
      else page.querySelector('.tag-manager-new-button').focus({ preventScroll: true });
    },
    requestFinishEditing() {
      setStatus('请先保存或取消标签编辑，再切换数据位置', true);
      focusDraft();
    },
    destroy,
  };
}

function actionButton(name, label, className, withText = false) {
  const button = el('button', className);
  button.type = 'button';
  button.title = label;
  button.setAttribute('aria-label', label);
  button.innerHTML = icon(name);
  if (withText) button.append(document.createTextNode(label));
  return button;
}

function sortHandle(label) {
  const button = actionButton('drag', label, 'tag-manager-sort-handle');
  button.dataset.sortHandle = '';
  return button;
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
