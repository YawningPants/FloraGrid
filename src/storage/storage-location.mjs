const browserStorageKey = 'desktop-calendar:storage-location';

export async function loadStorageLocation() {
  if (!isTauriRuntime()) {
    return loadBrowserStorageLocation();
  }

  return window.__TAURI__.core.invoke('load_storage_location');
}

export async function pickDataDirectory() {
  if (!isTauriRuntime()) {
    return null;
  }

  return window.__TAURI__.core.invoke('pick_data_directory');
}

export async function setStorageLocation(path) {
  if (!isTauriRuntime()) {
    const location = {
      isDefault: false,
      path,
      effectivePath: path,
    };
    window.localStorage.setItem(browserStorageKey, JSON.stringify(location));
    return location;
  }

  return window.__TAURI__.core.invoke('set_storage_location', { path });
}

export async function resetStorageLocation() {
  if (!isTauriRuntime()) {
    window.localStorage.removeItem(browserStorageKey);
    return loadBrowserStorageLocation();
  }

  return window.__TAURI__.core.invoke('reset_storage_location');
}

function loadBrowserStorageLocation() {
  try {
    const stored = JSON.parse(window.localStorage.getItem(browserStorageKey) || 'null');
    if (stored?.path) {
      return stored;
    }
  } catch {
    window.localStorage.removeItem(browserStorageKey);
  }

  return {
    isDefault: true,
    path: null,
    effectivePath: 'browser localStorage',
  };
}

function isTauriRuntime() {
  return Boolean(window.__TAURI__?.core?.invoke);
}
