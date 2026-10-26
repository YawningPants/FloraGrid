import { createCalendarShell } from './calendar-shell.mjs';
import { createRequestedView } from './views/registry.mjs';
import { startReminderClock } from './storage/reminder-service.mjs';

// Cancel the WebView's fallback menu everywhere, including inputs and empty space.
// Keep propagation intact so our task/calendar context menus still receive the event.
window.addEventListener('contextmenu', (event) => event.preventDefault(), { capture: true });

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
startReminderClock();
