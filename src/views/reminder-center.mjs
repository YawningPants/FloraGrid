import { taskColorInk } from '../domain/color-ink.mjs';
import { getTodayDateKey } from '../domain/date.mjs';
import {
  addDays,
  describeReminder,
  generateReminderTasks,
  lunarDate,
  reminderKinds,
  validateReminderSpec,
} from '../domain/reminders.mjs';
import { tagColors } from '../domain/tags.mjs';
import { readReminderStore, saveReminder } from '../storage/reminder-service.mjs';
import { el, escapeHtml } from '../ui/dom.mjs';
import { icon } from '../ui/icons.mjs';

export function createReminderCenter({ onChanged, onOpenDay }) {
  const root = el('section', 'reminder-center');
  let store = null,
    busy = false,
    editing = false,
    archived = false,
    revision = 0,
    editorState = null;
  async function refresh() {
    if (editing || busy) return;
    const token = ++revision;
    try {
      const data = await readReminderStore();
      if (token === revision && !editing) {
        store = data;
        render();
      }
    } catch (error) {
      root.replaceChildren(message(`读取提醒失败：${error.message || error}`));
    }
  }
  function message(text) {
    const p = el('p', 'workspace-message');
    p.textContent = text;
    return p;
  }
  async function change(change) {
    if (busy) return;
    busy = true;
    try {
      await saveReminder({ ...change, storageIdentity: store?.storageIdentity });
      store = await readReminderStore();
      editing = false;
      editorState = null;
      busy = false;
      if (!['stop', 'delete'].includes(change.action)) archived = false;
      render();
      onChanged?.();
    } catch (error) {
      busy = false;
      throw error;
    }
  }
  function render() {
    root.innerHTML = `<div class="reminder-center-head"><div><h2>提醒</h2><p>到期自动加入当天任务</p></div><button type="button" class="workspace-primary add-reminder">${icon('plus')}新建提醒</button></div>
      <div class="reminder-center-tabs"><button type="button" class="quiet-button ${archived ? '' : 'is-active'}" data-archived="false">进行中</button><button type="button" class="quiet-button ${archived ? 'is-active' : ''}" data-archived="true">已停用</button></div><div class="reminder-rule-list"></div>`;
    root.querySelector('.add-reminder').onclick = () => edit();
    root.querySelectorAll('[data-archived]').forEach((button) => {
      button.onclick = () => {
        archived = button.dataset.archived === 'true';
        render();
      };
    });
    const list = root.querySelector('.reminder-rule-list');
    const rules = (store?.rules || []).filter((rule) => Boolean(rule.archived) === archived);
    rules.sort(
      (a, b) =>
        Number(Boolean((b.segments.at(-1)?.spec || b.lastSpec)?.pinned)) -
        Number(Boolean((a.segments.at(-1)?.spec || a.lastSpec)?.pinned)),
    );
    if (!rules.length) list.append(message(archived ? '暂无已停用提醒' : '添加生日、纪念日或周期提醒'));
    for (const rule of rules) {
      const spec = rule.segments.at(-1)?.spec || rule.lastSpec;
      const card = el('article', 'reminder-rule-card');
      card.dataset.ruleId = rule.id;
      card.style.setProperty('--reminder-color', spec.color);
      const open = el('button', 'reminder-rule-main');
      open.type = 'button';
      const title = el('strong');
      title.textContent = spec.title;
      const schedule = el('span');
      schedule.textContent = `${reminderKinds[spec.kind] || '提醒'} · ${describeReminder(spec)}`;
      open.append(title, schedule);
      open.onclick = () => edit(rule);
      card.append(open);
      if (!archived) {
        const dates = [
          ...generateReminderTasks(
            { ...store, rules: [rule] },
            getTodayDateKey(),
            addDays(getTodayDateKey(), 430),
          ).keys(),
        ].sort();
        const next = el('button', 'reminder-next-date');
        next.type = 'button';
        next.textContent = dates[0] ? `下一次 ${dates[0]}` : '启用日期之后提醒';
        next.disabled = !dates[0];
        next.onclick = () => onOpenDay(dates[0]);
        card.append(next);
      }
      const actions = el('div', 'reminder-rule-actions');
      const pin = el('button', 'quiet-button');
      pin.type = 'button';
      pin.innerHTML = icon('pin');
      pin.title = spec.pinned ? '取消任务置顶' : '生成的任务置顶';
      pin.setAttribute('aria-pressed', String(Boolean(spec.pinned)));
      pin.onclick = async () => {
        try {
          await change({ id: rule.id, spec: { ...spec, pinned: !spec.pinned } });
        } catch (error) {
          list.prepend(message(`保存失败：${error.message || error}`));
        }
      };
      const stop = el('button', 'quiet-button reminder-stop');
      stop.type = 'button';
      stop.textContent = archived ? '恢复' : '以后不再提醒';
      stop.onclick = () => {
        if (archived) edit(rule);
        else confirmRuleAction(rule, 'stop');
      };
      if (!archived) actions.append(pin);
      actions.append(stop);
      if (archived) {
        const remove = el('button', 'quiet-button reminder-delete');
        remove.type = 'button';
        remove.textContent = '彻底删除';
        remove.onclick = () => confirmRuleAction(rule, 'delete');
        actions.append(remove);
      }
      card.append(actions);
      list.append(card);
    }
  }
  function edit(rule = null, selectedDate = getTodayDateKey()) {
    if (busy) return;
    ++revision;
    editing = true;
    const today = getTodayDateKey();
    const spec = structuredClone(
      rule?.segments.at(-1)?.spec ||
        rule?.lastSpec || {
          title: '',
          kind: 'birthday',
          frequency: 'yearly',
          calendar: 'solar',
          month: Number(selectedDate.slice(5, 7)),
          day: Number(selectedDate.slice(8)),
          leapMonth: false,
          weekdays: [new Date(selectedDate + 'T12:00:00').getDay()],
          color: tagColors[4],
          pinned: false,
        },
    );
    const start = rule?.archived ? addDays(today, 1) : selectedDate > today ? selectedDate : today;
    root.innerHTML = `<form class="reminder-editor"><div class="reminder-editor-head"><h2>${rule ? (rule.archived ? '恢复提醒' : '编辑提醒') : '新增提醒'}</h2><button type="button" class="quiet-button reminder-edit-back">返回列表</button></div><div class="reminder-editor-fields">
      <label>名称<input class="reminder-title-input" type="text" maxlength="200" placeholder="例如：妈妈的生日" value="${escapeHtml(spec.title)}" required/></label>
      <div class="reminder-form-row"><label>类型<select name="kind">${Object.entries(reminderKinds)
        .map(([key, label]) => `<option value="${key}">${label}</option>`)
        .join(
          '',
        )}</select></label><label>重复<select name="frequency"><option value="yearly">每年</option><option value="monthly">每月</option><option value="weekly">每周</option></select></label></div>
      <div class="reminder-date-fields"><label>历法<select name="calendar"><option value="solar">公历</option><option value="lunar">农历</option></select></label><div class="reminder-form-row"><label class="reminder-month-field">月份<select name="month">${Array.from({ length: 12 }, (_, i) => `<option value="${i + 1}">${i + 1} 月</option>`).join('')}</select></label><label>日期<input name="day" type="number" min="1" max="31" value="${spec.day}" aria-describedby="reminder-date-help" required/></label></div><label class="reminder-leap-field"><input name="leapMonth" type="checkbox" aria-describedby="reminder-date-help"/>日期在闰月</label><p id="reminder-date-help" class="reminder-form-hint reminder-calendar-hint" hidden></p></div>
      <div class="reminder-weekdays">${[1, 2, 3, 4, 5, 6, 0].map((day) => `<label><input type="checkbox" value="${day}"/>周${['日', '一', '二', '三', '四', '五', '六'][day]}</label>`).join('')}</div>
      ${!rule || rule.archived ? `<label>开始日期<input name="startDate" type="date" value="${start}" min="${rule?.archived ? addDays(today, 1) : today}" required/></label>` : '<p class="reminder-form-hint">内容和日期修改从明天生效；只调整颜色、置顶则当天生效。历史任务保留。</p>'}
      <div class="reminder-colors"><span>任务颜色</span><div class="reminder-color-options"></div><input type="color" aria-label="自定义提醒颜色" value="${spec.color}"/></div><label class="reminder-pin-field"><input name="pinned" type="checkbox"/>生成的任务置顶</label>
      </div><p class="reminder-form-error" role="status"></p><div class="reminder-form-actions"><button class="quiet-button reminder-edit-cancel" type="button">取消</button><button class="workspace-primary reminder-save" type="submit">${icon('check')}${rule?.archived ? '恢复提醒' : '保存提醒'}</button></div></form>`;
    const form = root.querySelector('form');
    for (const name of ['kind', 'frequency', 'calendar', 'month']) form.elements[name].value = spec[name];
    form.elements.leapMonth.checked = Boolean(spec.leapMonth);
    form.elements.pinned.checked = Boolean(spec.pinned);
    root.querySelectorAll('.reminder-weekdays input').forEach((input) => {
      input.checked = spec.weekdays?.includes(Number(input.value));
    });
    function calendarFields() {
      const weekly = form.elements.frequency.value === 'weekly',
        lunar = form.elements.calendar.value === 'lunar',
        monthly = form.elements.frequency.value === 'monthly';
      root.querySelector('.reminder-date-fields').hidden = weekly;
      root.querySelector('.reminder-weekdays').hidden = !weekly;
      root.querySelector('.reminder-month-field').hidden = monthly;
      root.querySelector('.reminder-leap-field').hidden = weekly || monthly || !lunar;
      form.elements.day.max = lunar ? 30 : 31;
      form.elements.day.required = !weekly;
      const day = Number(form.elements.day.value),
        month = Number(form.elements.month.value),
        hints = [];
      if (!weekly) {
        if (lunar && day === 30) hints.push('遇到只有 29 天的农历月，会在当月 29 日提醒。');
        if (lunar && !monthly && form.elements.leapMonth.checked)
          hints.push('没有这个闰月的年份，会在同名的普通月提醒。');
        if (!lunar && !monthly && month === 2 && day === 29)
          hints.push('不是闰年的年份，会在 2 月 28 日提醒。');
        if (!lunar && monthly && day === 29) hints.push('2 月没有 29 日时，会在 2 月 28 日提醒。');
        if (!lunar && monthly && day === 30) hints.push('2 月没有 30 日，会在 2 月的最后一天提醒。');
        if (!lunar && monthly && day === 31)
          hints.push('没有 31 日的月份，会在该月最后一天提醒，例如 4 月 30 日。');
      }
      const hint = root.querySelector('.reminder-calendar-hint');
      hint.textContent = hints.join(' ');
      hint.hidden = !hints.length;
    }
    form.elements.frequency.onchange = calendarFields;
    form.elements.month.onchange = calendarFields;
    form.elements.day.oninput = calendarFields;
    form.elements.leapMonth.onchange = calendarFields;
    form.elements.calendar.onchange = () => {
      try {
        if (!rule) {
          const date =
            form.elements.calendar.value === 'lunar'
              ? lunarDate(selectedDate)
              : { month: Number(selectedDate.slice(5, 7)), day: Number(selectedDate.slice(8)), leap: false };
          form.elements.month.value = date.month;
          form.elements.day.value = date.day;
          form.elements.leapMonth.checked = date.leap;
        }
        calendarFields();
      } catch (error) {
        root.querySelector('.reminder-form-error').textContent = error.message || String(error);
      }
    };
    const colorInput = root.querySelector('input[type="color"]');
    const updateColor = (color) => {
      spec.color = color;
      colorInput.value = color;
      form.style.setProperty('--reminder-color', color);
      root
        .querySelectorAll('.tag-color-swatch')
        .forEach((button) => button.classList.toggle('is-selected', button.dataset.color === color));
    };
    tagColors.forEach((color) => {
      const button = el('button', 'tag-color-swatch');
      button.type = 'button';
      button.dataset.color = color;
      button.style.setProperty('--swatch', color);
      button.style.setProperty('--swatch-ink', taskColorInk(button.style.getPropertyValue('--swatch')));
      button.setAttribute('aria-label', `提醒颜色 ${color}`);
      button.onclick = () => updateColor(color);
      root.querySelector('.reminder-color-options').append(button);
    });
    colorInput.oninput = () => updateColor(colorInput.value);
    updateColor(spec.color);
    calendarFields();
    const cancel = () => {
      if (!busy) {
        editing = false;
        editorState = null;
        refresh();
      }
    };
    root.querySelector('.reminder-edit-back').onclick = cancel;
    root.querySelector('.reminder-edit-cancel').onclick = cancel;
    form.onsubmit = async (event) => {
      event.preventDefault();
      if (busy) return;
      const errorNode = root.querySelector('.reminder-form-error');
      const next = {
        ...spec,
        title: root.querySelector('.reminder-title-input').value.trim(),
        kind: form.elements.kind.value,
        frequency: form.elements.frequency.value,
        calendar: form.elements.calendar.value,
        month: Number(form.elements.month.value),
        day: Number(form.elements.day.value),
        leapMonth: form.elements.leapMonth.checked,
        pinned: form.elements.pinned.checked,
        weekdays: [...root.querySelectorAll('.reminder-weekdays input:checked')].map((input) =>
          Number(input.value),
        ),
      };
      try {
        validateReminderSpec(next);
        errorNode.textContent = '正在保存…';
        form.querySelectorAll('button,input,select').forEach((input) => {
          input.disabled = true;
        });
        await change({ id: rule?.id, spec: next, startDate: form.elements.startDate?.value });
      } catch (error) {
        errorNode.textContent = `保存失败：${error.message || error}`;
        form.querySelectorAll('button,input,select').forEach((input) => {
          input.disabled = false;
        });
      }
    };
    editorState = {
      isNew: !rule,
      snapshot: () =>
        JSON.stringify({
          values: [...form.querySelectorAll('input,select')].map((input) => [
            input.name || input.type,
            input.type === 'checkbox' ? input.checked : input.value,
          ]),
        }),
    };
    editorState.initial = editorState.snapshot();
    root.querySelector('.reminder-title-input').focus({ preventScroll: true });
  }
  function confirmRuleAction(rule, action) {
    if (busy) return;
    const deleting = action === 'delete';
    const label = deleting ? '彻底删除' : '以后不再提醒';
    const overlay = el(
      'div',
      `dialog-overlay reminder-confirm-overlay${deleting ? ' reminder-delete-overlay' : ''}`,
    );
    overlay.innerHTML = `<section class="confirm-dialog" role="dialog" aria-modal="true" aria-label="${label}"><h2>${deleting ? '彻底删除这条提醒？' : '以后不再提醒？'}</h2><p>${deleting ? '删除后不能恢复这条重复规则。已经生成的今天和历史任务会保留。' : '今天和过去的任务保留。从明天起不再添加提醒；未来尚未改动的自动任务会撤销，已修改、完成或失败的任务保留为独立任务。'}</p><p class="reminder-form-error" role="status"></p><div class="dialog-actions"><button type="button" class="dialog-button cancel">取消</button><button type="button" class="dialog-button danger">${label}</button></div></section>`;
    overlay.querySelector('.cancel').onclick = () => {
      if (!busy) overlay.remove();
    };
    overlay.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        if (!busy) overlay.remove();
      }
    });
    overlay.querySelector('.danger').onclick = async () => {
      try {
        await change({ id: rule.id, action });
        overlay.remove();
      } catch (error) {
        overlay.querySelector('.reminder-form-error').textContent = `操作失败：${error.message || error}`;
      }
    };
    document.body.append(overlay);
    overlay.querySelector('.cancel').focus();
  }
  refresh();
  return {
    element: root,
    refresh,
    isEditing: () => editing,
    isBusy: () => busy,
    onPanelClose() {
      if (busy || !editing || !editorState?.isNew || editorState.initial !== editorState.snapshot()) return;
      editing = false;
      editorState = null;
      archived = false;
      render();
    },
    create: (date) => {
      if (editing) {
        root.querySelector('.reminder-form-error').textContent = '请先保存或返回，再创建其他提醒';
        root.querySelector('.reminder-title-input').focus();
        return;
      }
      edit(null, date);
    },
    focusRule: async (id) => {
      if (editing) return;
      await refresh();
      const rule = store?.rules.find((rule) => rule.id === id);
      if (rule) edit(rule);
    },
  };
}
