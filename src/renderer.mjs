import { createCalendarShell } from './calendar-shell.mjs';
import { createRequestedView } from './views/registry.mjs';

if (window.__TAURI__?.window?.getCurrentWindow) {
  const currentWindow = window.__TAURI__.window.getCurrentWindow();
  window.calendarShell = createCalendarShell(currentWindow);
} else {
  window.calendarShell = createCalendarShell();
}

window.addEventListener('DOMContentLoaded', () => {
  if (window.__TAURI__?.window?.getCurrentWindow) {
    const currentWindow = window.__TAURI__.window.getCurrentWindow();
    window.calendarShell = createCalendarShell(currentWindow);
  }
});

const app = document.querySelector('#app');
app.replaceChildren(createRequestedView());
