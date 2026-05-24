import { createDayView } from './day-view.mjs';
import { createTagManagerWindow } from './tag-manager-page.mjs';

const viewFactories = {
  day: createDayView,
  'tag-manager': createTagManagerWindow,
};

export function getRequestedViewName(location = window.location) {
  const params = new URLSearchParams(location.search);
  return params.get('view') || location.hash.replace(/^#/, '') || 'day';
}

export function createRequestedView(name = getRequestedViewName()) {
  const factory = viewFactories[name] || viewFactories.day;
  return factory();
}
