const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

export function getTodayDateKey() {
  return toDateKey(new Date());
}

export function toDateKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function getDayDisplayMeta(dateKey) {
  const date = parseDateKey(dateKey);
  const isToday = dateKey === getTodayDateKey();
  return {
    title: `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日 ${WEEKDAYS[date.getDay()]}`,
    subtitle: isToday ? `${dateKey} · 今日` : dateKey,
  };
}

export function shiftDateKey(dateKey, offsetDays) {
  const date = parseDateKey(dateKey);
  date.setDate(date.getDate() + offsetDays);
  return toDateKey(date);
}

export function parseDateKey(dateKey) {
  const [year, month, day] = dateKey.split('-').map(Number);
  return new Date(year, month - 1, day);
}
