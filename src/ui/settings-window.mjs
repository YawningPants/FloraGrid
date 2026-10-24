export const SETTINGS_TABS = ['theme', 'data', 'tags'];

export function getSettingsTab(location = window.location) {
  const hashParams = new URLSearchParams(location.hash.split('?')[1] || '');
  const tab = hashParams.get('tab') || new URLSearchParams(location.search).get('tab');
  return SETTINGS_TABS.includes(tab) ? tab : null;
}

// All entry points share this window name. Reopening an existing page must not reload its drafts.
export async function openSettingsWindow(tab = null) {
  if (tab !== null && !SETTINGS_TABS.includes(tab)) throw new Error('Unknown settings tab');
  if (window.__TAURI__?.core?.invoke) {
    await window.__TAURI__.core.invoke('open_settings_window', { tab });
    return;
  }
  const target = window.open('', 'settings', 'width=780,height=560');
  if (!target) throw new Error('Settings window could not be opened');
  if (target.location.href === 'about:blank') {
    const url = new URL('index.html', window.location.href);
    url.hash = tab ? `settings?tab=${tab}` : 'settings';
    target.location.replace(url.href);
  } else if (tab) {
    target.location.hash = `settings?tab=${tab}`;
  }
  target.focus();
}
