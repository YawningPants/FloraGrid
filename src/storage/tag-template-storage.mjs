import { normalizeTagTemplates } from '../domain/tags.mjs';

export async function loadTagTemplates() {
  if (!isTauriRuntime()) {
    return loadTagTemplatesFromBrowser();
  }

  const data = await window.__TAURI__.core.invoke('load_tag_templates');
  return normalizeTagTemplates(data);
}

export async function saveTagTemplates(templates) {
  const normalized = normalizeTagTemplates(templates);
  if (!isTauriRuntime()) {
    saveTagTemplatesToBrowser(normalized);
    return normalized;
  }

  await window.__TAURI__.core.invoke('save_tag_templates', { templates: normalized });
  return normalized;
}

function isTauriRuntime() {
  return Boolean(window.__TAURI__?.core?.invoke);
}

function loadTagTemplatesFromBrowser() {
  const raw = window.localStorage.getItem('desktop-calendar:tag-templates');
  return normalizeTagTemplates(raw ? JSON.parse(raw) : null);
}

function saveTagTemplatesToBrowser(templates) {
  window.localStorage.setItem('desktop-calendar:tag-templates', JSON.stringify(templates));
}
