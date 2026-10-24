import { getTodayDateKey } from '../domain/date.mjs';
import { addDays, dateNumber } from '../domain/reminders.mjs';
import { searchCalendar } from '../domain/calendar-search.mjs';
import { readCalendarDays, readReminderStore } from '../storage/calendar-io.mjs';
import { loadLongTasks } from '../storage/long-task-storage.mjs';
import { el } from '../ui/dom.mjs';
import { icon } from '../ui/icons.mjs';

export function createMonthSearch({ onOpen, onLocate, onClose }) {
  const root = el('section', 'month-search-workspace');
  const today = getTodayDateKey();
  const state = { query: '', from: addDays(today, -29), through: today, types: ['task', 'reminder', 'note', 'long'], includeDeleted: false };
  let revision = 0, timer, results = [], limit = 100;
  root.innerHTML = `<div class="global-search-top"><h2>全局搜索</h2><button type="button" class="quiet-button search-back">${icon('restore')}返回日历</button></div>
    <label class="global-search-query">${icon('search')}<input type="search" placeholder="搜索任务、标签、随笔或提醒" aria-label="全局搜索关键词" /></label>
    <div class="search-range"><select aria-label="搜索日期范围"><option value="recent">最近 30 天</option><option value="month">本月</option><option value="quarter">最近 90 天</option><option value="custom">自定义</option></select>
    <input type="date" class="search-from" aria-label="搜索开始日期" value="${state.from}"/><span>至</span><input type="date" class="search-through" aria-label="搜索结束日期" value="${state.through}"/></div>
    <div class="search-filters">${[['task', '任务'], ['reminder', '提醒任务'], ['note', '随笔'], ['long', '无日期长期任务']].map(([key, name]) => `<label><input type="checkbox" data-search-type="${key}" checked/>${name}</label>`).join('')}<label><input type="checkbox" class="search-deleted"/>包含已删除</label></div>
    <div class="search-count" role="status" aria-live="polite">输入关键词开始搜索</div><div class="global-search-results"></div>`;
  const status = root.querySelector('.search-count'), list = root.querySelector('.global-search-results');
  function highlight(node, text) {
    const words = state.query.toLocaleLowerCase().split(/\s+/).filter(Boolean), lower = text.toLocaleLowerCase();
    let cursor = 0;
    while (cursor < text.length) {
      const hit = words.map(word => ({ index: lower.indexOf(word, cursor), word })).filter(hit => hit.index >= 0).sort((a, b) => a.index - b.index)[0];
      if (!hit) { node.append(document.createTextNode(text.slice(cursor))); break; }
      node.append(document.createTextNode(text.slice(cursor, hit.index)));
      const mark = el('mark', 'search-hit'); mark.textContent = text.slice(hit.index, hit.index + hit.word.length); node.append(mark);
      cursor = hit.index + hit.word.length;
    }
  }
  function render() {
    list.replaceChildren(); let date = undefined;
    results.slice(0, limit).forEach(result => {
      if (date !== result.date) { date = result.date; const heading = el('h3', 'search-date-heading'); heading.textContent = date || '无日期 · 长期任务'; list.append(heading); }
      const row = el('article', `search-result search-result-${result.type}`);
      const button = el('button', 'search-result-main'); button.type = 'button';
      const title = el('span', 'search-result-title'); highlight(title, result.title);
      const detail = el('span', 'search-result-detail');
      const labels = { task: '任务', reminder: '提醒任务', note: '随笔', long: '长期任务' };
      let snippet = result.snippet || '';
      const firstHit = state.query.toLocaleLowerCase().split(/\s+/).map(word => snippet.toLocaleLowerCase().indexOf(word)).filter(index => index >= 0).sort((a, b) => a - b)[0] || 0;
      const start = Math.max(0, firstHit - 30);
      snippet = `${start ? '…' : ''}${snippet.slice(start, start + 160)}${snippet.length > start + 160 ? '…' : ''}`;
      highlight(detail, [labels[result.type], result.breadcrumb, snippet].filter(Boolean).join(' · '));
      button.append(title, detail); button.addEventListener('click', () => onOpen(result, state)); row.append(button);
      if (result.date) { const locate = el('button', 'quiet-button search-locate'); locate.type = 'button'; locate.textContent = '月历定位'; locate.addEventListener('click', () => onLocate(result.date)); row.append(locate); }
      list.append(row);
    });
    if (results.length > limit) { const more = el('button', 'quiet-button search-more'); more.type = 'button'; more.textContent = `继续显示（还有 ${results.length - limit} 项）`; more.onclick = () => { limit += 100; render(); }; list.append(more); }
  }
  async function search() {
    const current = ++revision;
    if (!state.query.trim()) { results = []; render(); status.textContent = '输入关键词开始搜索'; return; }
    try {
      dateNumber(state.from); dateNumber(state.through);
      if (state.from > state.through) throw new Error('开始日期不能晚于结束日期');
      if (dateNumber(state.through) - dateNumber(state.from) > 36600 * 86400000) throw new Error('搜索范围请控制在 100 年以内');
      status.textContent = '正在搜索…';
      const [days, longTasks, store] = await Promise.all([readCalendarDays(state.from, state.through), loadLongTasks(), readReminderStore()]);
      if (current !== revision) return;
      results = searchCalendar({ ...state, days, longTasks, store }); limit = 100; render();
      status.textContent = results.length ? `找到 ${results.length} 项 · ${state.from} 至 ${state.through}${state.types.includes('long') ? '，另包含无日期长期任务' : ''}` : '没有找到匹配内容';
    } catch (error) { if (current === revision) { results = []; render(); status.textContent = `搜索失败：${error.message || error}`; } }
  }
  function schedule() { ++revision; clearTimeout(timer); timer = setTimeout(search, 240); }
  root.querySelector('input[type="search"]').oninput = event => { state.query = event.target.value; schedule(); };
  root.querySelector('input[type="search"]').onkeydown = event => { if (event.key === 'Enter' && !event.isComposing) { clearTimeout(timer); search(); } if (event.key === 'Escape') { event.stopPropagation(); onClose(); } };
  root.querySelector('select').onchange = event => {
    const value = event.target.value;
    if (value === 'custom') return;
    state.through = getTodayDateKey(); state.from = value === 'month' ? state.through.slice(0, 8) + '01' : addDays(state.through, value === 'quarter' ? -89 : -29);
    if (value === 'month') state.through = state.through.slice(0, 8) + String(new Date(Number(state.through.slice(0, 4)), Number(state.through.slice(5, 7)), 0).getDate());
    root.querySelector('.search-from').value = state.from; root.querySelector('.search-through').value = state.through; schedule();
  };
  for (const [selector, field] of [['.search-from', 'from'], ['.search-through', 'through']]) root.querySelector(selector).onchange = event => { state[field] = event.target.value; root.querySelector('select').value = 'custom'; schedule(); };
  root.querySelectorAll('[data-search-type]').forEach(input => { input.onchange = () => { state.types = [...root.querySelectorAll('[data-search-type]:checked')].map(i => i.dataset.searchType); schedule(); }; });
  root.querySelector('.search-deleted').onchange = event => { state.includeDeleted = event.target.checked; schedule(); };
  root.querySelector('.search-back').onclick = onClose;
  return { element: root, focus: () => root.querySelector('input[type="search"]').focus({ preventScroll: true }), refresh: search };
}
