import {
  applyThemeSettings,
  defaultTheme,
  loadThemeSettings,
  saveThemeSettings,
  getThemePresets,
} from '../domain/theme.mjs';
import {
  loadStorageLocation,
  pickDataDirectory,
  resetStorageLocation,
  setStorageLocation,
} from '../storage/storage-location.mjs';
import { el, escapeHtml } from '../ui/dom.mjs';
import { createWindowTitleBar } from '../ui/window-titlebar.mjs';
import { getSettingsTab, SETTINGS_TABS } from '../ui/settings-window.mjs';
import { createTagManagerPanel } from './tag-manager-page.mjs';
import { openMonth } from '../ui/calendar-navigation.mjs';

let themeSettings = applyThemeSettings(loadThemeSettings());
let storageLocation = null;

export function createSettingsWindow(options = {}) {
  applyThemeSettings(themeSettings);
  const root = el('section', 'settings-window');
  const page = createSettingsPage({ initialTab: options.tab || getSettingsTab() });
  root.append(createTitleBar(page.requestClose), page.element);
  bindSettingsNavigation(page);
  return root;
}

function createTitleBar(onClose) {
  return createWindowTitleBar({
    title: '设置',
    className: 'settings-titlebar',
    onMinimize: () => window.calendarShell?.minimize?.(),
    onClose,
  });
}

function createSettingsPage({ initialTab }) {
  let draftTheme = { ...themeSettings };
  let rememberedTab = 'theme';
  try { rememberedTab = localStorage.getItem('desktop-calendar:settings-tab') || 'theme'; } catch { /* Use the default when storage is unavailable. */ }
  let activeSettingsTab = SETTINGS_TABS.includes(initialTab) ? initialTab : SETTINGS_TABS.includes(rememberedTab) ? rememberedTab : 'theme';
  let tagPanel = null;
  let pendingTab = null;
  let dataRenderRevision = 0;
  const page = el('section', 'settings-page');
  page.innerHTML = `
    <header class="settings-header">
      <div>
        <h2>设置</h2>
        <p class="settings-subtitle">调整主题、管理长期标签和本地数据。</p>
      </div>
    </header>
    <div class="settings-body">
      <aside class="settings-tabs">
        <button class="settings-tab" type="button" data-settings-tab="theme">主题</button>
        <button class="settings-tab" type="button" data-settings-tab="data">数据</button>
        <button class="settings-tab" type="button" data-settings-tab="tags">长期标签</button>
        <button class="settings-tab settings-reminders-link" type="button" aria-label="在月视图中管理提醒">提醒管理 ↗</button>
      </aside>
      <section class="settings-panel">
        <section class="settings-pane" data-settings-pane="theme" hidden></section>
        <section class="settings-pane" data-settings-pane="data" hidden></section>
        <section class="settings-pane settings-tags-pane" data-settings-pane="tags" hidden></section>
      </section>
    </div>
    <footer class="settings-actions">
      <button class="dialog-button reset-theme" type="button">恢复默认</button>
      <button class="dialog-button primary close-settings" type="button">完成</button>
    </footer>
  `;

  const themePanel = page.querySelector('[data-settings-pane="theme"]');
  const dataPanel = page.querySelector('[data-settings-pane="data"]');
  const tagsPane = page.querySelector('[data-settings-pane="tags"]');
  const resetThemeButton = page.querySelector('.reset-theme');

  const renderThemePresets = () => {
    const grid = page.querySelector('.theme-preset-grid');
    if (!grid) {
      return;
    }
    grid.replaceChildren();
    getThemePresets(draftTheme.appearance).forEach((preset) => {
      const button = el('button', `theme-preset${draftTheme.presetId === preset.id ? ' is-active' : ''}`);
      button.type = 'button';
      button.style.setProperty('--preset-base', preset.color);
      button.style.setProperty('--preset-glow', preset.glow);
      button.style.setProperty('--preset-warm', preset.warm);
      button.innerHTML = `
        <span class="theme-preset-swatch"></span>
        <span>${escapeHtml(preset.name)}</span>
      `;
      button.addEventListener('click', () => {
        draftTheme = saveAndPreviewTheme({ ...draftTheme, presetId: preset.id });
        renderThemePresets();
      });
      grid.append(button);
    });
  };

  const renderThemePanel = () => {
    const panel = themePanel;
    panel.innerHTML = `
      <div class="settings-section-title">外观</div>
      <div class="appearance-options" role="group" aria-label="外观模式">
        <button class="appearance-option" type="button" data-appearance="botanical" aria-pressed="${draftTheme.appearance === 'botanical'}"><strong>日枝</strong><span>小花、枝叶与自然配色</span></button>
        <button class="appearance-option" type="button" data-appearance="minimal" aria-pressed="${draftTheme.appearance === 'minimal'}"><strong>精简</strong><span>保留原来的对勾与配色</span></button>
      </div>
      <label class="completion-motion-control" ${draftTheme.appearance === 'minimal' ? 'hidden' : ''}>
        <span>完成时开花</span><input class="completion-motion-input" type="checkbox" ${draftTheme.completionMotion ? 'checked' : ''}/>
        <small>关闭后直接显示小花；跟随系统减少动态效果。</small>
      </label>
      <div class="settings-section-title">背景颜色</div>
      <div class="theme-preset-grid"></div>
      <label class="theme-opacity-control">
        <span>背景不透明度</span>
        <strong class="theme-opacity-value">${Math.round(draftTheme.opacity * 100)}%</strong>
        <input class="theme-opacity-input" type="range" min="34" max="100" step="1" value="${Math.round(draftTheme.opacity * 100)}" />
      </label>
    `;
    renderThemePresets();
    panel.querySelectorAll('.appearance-option').forEach(button => button.addEventListener('click', () => {
      draftTheme = saveAndPreviewTheme({ ...draftTheme, appearance: button.dataset.appearance });
      renderThemePanel();
      panel.querySelector(`[data-appearance="${draftTheme.appearance}"]`)?.focus({ preventScroll: true });
    }));
    panel.querySelector('.completion-motion-input')?.addEventListener('change', event => {
      draftTheme = saveAndPreviewTheme({ ...draftTheme, completionMotion: event.target.checked });
    });
    const opacityInput = page.querySelector('.theme-opacity-input');
    const opacityValue = page.querySelector('.theme-opacity-value');
    opacityInput?.addEventListener('input', () => {
      const opacity = Number(opacityInput.value) / 100;
      opacityValue.textContent = `${opacityInput.value}%`;
      draftTheme = saveAndPreviewTheme({ ...draftTheme, opacity });
    });
  };

  const renderDataPanel = async () => {
    const revision = ++dataRenderRevision;
    const panel = dataPanel;
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
      if (revision !== dataRenderRevision) return;
      panel.querySelector('.storage-path-label').textContent = getStoragePathLabel(storageLocation);
      panel.querySelector('.storage-path-value').textContent = getStoragePathText(storageLocation);
    } catch (error) {
      if (revision !== dataRenderRevision) return;
      console.error(error);
      panel.querySelector('.storage-path-value').textContent = '读取存储位置失败';
    }

    panel.querySelector('.choose-storage')?.addEventListener('click', async () => {
      if (!canChangeStorage()) return;
      try {
        const path = await pickDataDirectory();
        if (!path) {
          return;
        }
        showConfirmDialog({
          title: '确认切换存储位置？',
          message: '应用会改从新文件夹读取和保存数据；旧数据不会自动迁移。',
          confirmText: '确认切换',
          onConfirm: async () => {
            if (!canChangeStorage()) return;
            storageLocation = await setStorageLocation(path);
            notifyStorageUpdated(storageLocation);
            renderDataPanel();
          },
        });
      } catch (error) {
        console.error(error);
      }
    });

    panel.querySelector('.reset-storage')?.addEventListener('click', () => {
      if (!canChangeStorage()) return;
      showConfirmDialog({
        title: '确认恢复默认存储位置？',
        message: '应用会改回默认文件夹读取和保存数据；当前自定义文件夹不会被移动或删除。',
        confirmText: '确认恢复',
        onConfirm: async () => {
          if (!canChangeStorage()) return;
          storageLocation = await resetStorageLocation();
          notifyStorageUpdated(storageLocation);
          renderDataPanel();
        },
      });
    });
  };

  const renderSettingsTab = () => {
    page.querySelectorAll('.settings-tab[data-settings-tab]').forEach((button) => {
      button.classList.toggle('is-active', button.dataset.settingsTab === activeSettingsTab);
      button.setAttribute('aria-pressed', String(button.dataset.settingsTab === activeSettingsTab));
    });
    page.querySelectorAll('.settings-pane').forEach((pane) => {
      pane.hidden = pane.dataset.settingsPane !== activeSettingsTab;
    });
    resetThemeButton.hidden = activeSettingsTab !== 'theme';
    if (activeSettingsTab === 'tags') {
      if (!tagPanel) {
        tagPanel = createTagManagerPanel({
          onBusyChange: ({ busy, saved }) => {
            page.querySelectorAll('.settings-tab, .close-settings').forEach((button) => { button.disabled = busy; });
            if (!busy && pendingTab) {
              const nextTab = pendingTab;
              pendingTab = null;
              if (saved) selectTab(nextTab);
            }
          },
        });
        tagsPane.append(tagPanel.element);
      }
      tagPanel.setActive(true);
      return;
    }
    if (activeSettingsTab === 'data') {
      renderDataPanel();
      return;
    }
    renderThemePanel();
  };

  function rememberTab() {
    try { localStorage.setItem('desktop-calendar:settings-tab', activeSettingsTab); } catch { /* Navigation still works without persistence. */ }
    const url = new URL(window.location.href);
    url.searchParams.delete('tab');
    url.hash = `settings?tab=${activeSettingsTab}`;
    history.replaceState(null, '', url);
  }

  function selectTab(tab, { focus = false } = {}) {
    if (!SETTINGS_TABS.includes(tab)) return;
    if (tab === activeSettingsTab) pendingTab = null;
    if (tab !== activeSettingsTab) {
      if (activeSettingsTab === 'tags' && tagPanel && !tagPanel.canLeave()) {
        if (tagPanel.isBusy()) pendingTab = tab;
        return;
      }
      tagPanel?.setActive(false);
      activeSettingsTab = tab;
      renderSettingsTab();
    }
    rememberTab();
    if (focus) {
      if (tab === 'tags') tagPanel.focus();
      else page.querySelector(`[data-settings-tab="${tab}"]`).focus({ preventScroll: true });
    }
  }

  function canChangeStorage() {
    if (!tagPanel?.hasDraft() && !tagPanel?.isBusy()) return true;
    selectTab('tags');
    tagPanel.requestFinishEditing();
    return false;
  }

  function requestClose() {
    if (tagPanel?.isBusy()) return;
    window.calendarShell?.close?.();
  }

  page.querySelector('.reset-theme')?.addEventListener('click', () => {
    draftTheme = saveAndPreviewTheme(defaultTheme);
    renderThemePanel();
  });
  page.querySelectorAll('.settings-tab[data-settings-tab]').forEach((button) => {
    button.addEventListener('click', () => {
      selectTab(button.dataset.settingsTab || 'theme');
    });
  });
  page.querySelector('.settings-reminders-link').onclick = () => openMonth({ panel: 'reminders' }).catch(console.error);
  page.querySelector('.close-settings')?.addEventListener('click', () => {
    requestClose();
  });
  renderSettingsTab();
  rememberTab();
  queueMicrotask(() => {
    if (activeSettingsTab === 'tags') tagPanel.focus();
    else page.querySelector('.settings-pane:not([hidden]) button')?.focus({ preventScroll: true });
  });
  return { element: page, selectTab, requestClose, destroy: () => tagPanel?.destroy() };
}

function bindSettingsNavigation(page) {
  const abort = new AbortController();
  let lastRevision = 0;
  const navigate = (request) => {
    if (!request || request.revision < lastRevision || abort.signal.aborted) return;
    lastRevision = request.revision;
    if (request.tab) page.selectTab(request.tab, { focus: true });
  };
  window.addEventListener('hashchange', () => {
    const tab = getSettingsTab();
    if (tab) page.selectTab(tab, { focus: true });
  }, { signal: abort.signal });
  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !event.defaultPrevented && !event.isComposing && !document.querySelector('.dialog-overlay')) {
      event.preventDefault();
      page.requestClose();
    }
  }, { signal: abort.signal });
  window.addEventListener('beforeunload', () => {
    abort.abort();
    page.destroy();
  }, { once: true });
  if (window.__TAURI__?.event?.listen && window.__TAURI__?.core?.invoke) {
    // Register first, then read the latest request. Revisions prevent an older reply
    // from overriding a newer navigation event during the initial load.
    (async () => {
      const unlisten = await window.__TAURI__.event.listen('calendar://settings-navigate', (event) => navigate(event.payload));
      if (abort.signal.aborted) { unlisten(); return; }
      abort.signal.addEventListener('abort', unlisten, { once: true });
      navigate(await window.__TAURI__.core.invoke('get_settings_navigation'));
    })().catch(console.error);
  }
}

function saveAndPreviewTheme(settings) {
  themeSettings = saveThemeSettings(settings);
  applyThemeSettings(themeSettings);
  notifyThemeUpdated(themeSettings);
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

function showConfirmDialog({ title, message, confirmText, onConfirm }) {
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
