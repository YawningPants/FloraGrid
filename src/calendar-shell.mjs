export function createCalendarShell(currentWindow = null) {
  if (window.__TAURI__?.window?.getCurrentWindow) {
    const activeWindow = currentWindow || window.__TAURI__.window.getCurrentWindow();
    return {
      platform: 'tauri',
      minimize: () => activeWindow.minimize(),
      hide: () => activeWindow.hide(),
      close: () => activeWindow.close(),
      setAlwaysOnTop: (enabled) => activeWindow.setAlwaysOnTop(enabled),
      exit: () => window.__TAURI__.core.invoke('exit_app'),
    };
  }

  return {
    platform: 'browser',
    minimize: () => {},
    hide: () => {},
    close: () => window.close(),
    setAlwaysOnTop: () => Promise.resolve(),
    exit: () => window.close(),
  };
}
