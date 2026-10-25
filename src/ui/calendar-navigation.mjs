async function openNamed(name, url, hash, features) {
  const target = window.open('', name, features);
  if (!target) throw new Error('窗口未能打开');
  if (target.location.href === 'about:blank') target.location.replace(new URL(url, location.href).href);
  else if (hash) target.location.hash = hash;
  target.focus();
}
export async function openDay(date, { taskId = null, note = false, includeDeleted = false } = {}) {
  if (window.__TAURI__?.core?.invoke)
    return window.__TAURI__.core.invoke('open_day_window', { date, taskId, note, includeDeleted });
  const params = new URLSearchParams({
    date,
    ...(taskId ? { taskId } : {}),
    ...(note ? { note: '1' } : {}),
    ...(includeDeleted ? { deleted: '1' } : {}),
  });
  return openNamed(`day-${date}`, `index.html?view=day&${params}`, `day?${params}`, 'width=400,height=820');
}
export async function openMonth({ panel = null, ruleId = null } = {}) {
  if (window.__TAURI__?.core?.invoke)
    return window.__TAURI__.core.invoke('open_month_window', { panel, ruleId });
  const hash = panel ? `month?${new URLSearchParams({ panel, ...(ruleId ? { ruleId } : {}) })}` : null;
  return openNamed('month-view', `index.html#${hash || 'month'}`, hash, 'width=1180,height=820');
}
export function bindCalendarNavigation(handler) {
  let latest = 0;
  const apply = (payload) => {
    if (!payload || (payload.revision && payload.revision < latest)) return;
    if (payload.revision) latest = payload.revision;
    handler(payload);
  };
  const readLocation = () => {
    const params = new URLSearchParams(location.search),
      hash = new URLSearchParams(location.hash.split('?')[1] || '');
    const get = (key) => hash.get(key) || params.get(key);
    apply({
      date: get('date'),
      taskId: get('taskId'),
      note: get('note') === '1',
      includeDeleted: get('deleted') === '1',
      panel: get('panel'),
      ruleId: get('ruleId'),
    });
  };
  window.addEventListener('hashchange', readLocation);
  readLocation();
  if (window.__TAURI__?.event?.listen && window.__TAURI__?.core?.invoke)
    (async () => {
      await window.__TAURI__.event.listen('calendar://navigate', (event) => apply(event.payload));
      apply(await window.__TAURI__.core.invoke('get_calendar_navigation'));
    })().catch(console.error);
}
