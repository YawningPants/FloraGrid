import { createDayView } from './day-view.mjs';
import { createMonthView } from './month-view.mjs';
import { createSettingsWindow } from './settings-page.mjs';
import { openSettingsWindow } from '../ui/settings-window.mjs';
import { el } from '../ui/dom.mjs';

const viewFactories = {
  day: createDayView,
  month: createMonthView,
  settings: createSettingsWindow,
  'tag-manager': createTagManagerRedirect,
};

export function getRequestedViewName(location = window.location) {
  const params = new URLSearchParams(location.search);
  return params.get('view') || location.hash.replace(/^#/, '').split('?')[0] || 'day';
}

export function getRequestedViewOptions(location = window.location) {
  const params = new URLSearchParams(location.search);
  const hashParams = new URLSearchParams(location.hash.split('?')[1] || '');
  return {
    date: params.get('date'),
    month: params.get('month'),
    tab: hashParams.get('tab') || params.get('tab'),
    params,
  };
}

function createTagManagerRedirect() {
  const message = el('section', 'settings-redirect');
  message.textContent = '正在打开长期标签…';
  queueMicrotask(async () => {
    try {
      await openSettingsWindow('tags');
      window.calendarShell?.close?.();
    } catch (error) {
      console.error(error);
      message.textContent = '打开失败，请从设置中进入长期标签。';
    }
  });
  return message;
}

export function createRequestedView(name = getRequestedViewName(), options = getRequestedViewOptions()) {
  const factory = viewFactories[name] || viewFactories.day;
  return factory(options);
}
