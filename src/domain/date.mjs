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

export function getMonthKeyFromDateKey(dateKey) {
  const date = parseDateKey(dateKey);
  return toMonthKey(date);
}

export function getMonthDisplayMeta(monthKey) {
  const date = parseMonthKey(monthKey);
  return {
    title: `${date.getFullYear()}年${date.getMonth() + 1}月`,
    subtitle: `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`,
  };
}

export function shiftMonthKey(monthKey, offsetMonths) {
  const date = parseMonthKey(monthKey);
  date.setMonth(date.getMonth() + offsetMonths);
  return toMonthKey(date);
}

export function getMonthGridDates(monthKey, weekStartsOn = 1) {
  const monthDate = parseMonthKey(monthKey);
  const firstDay = new Date(monthDate.getFullYear(), monthDate.getMonth(), 1);
  const start = new Date(firstDay);
  const offset = (firstDay.getDay() - weekStartsOn + 7) % 7;
  start.setDate(firstDay.getDate() - offset);
  const todayKey = getTodayDateKey();
  const daysInMonth = new Date(monthDate.getFullYear(), monthDate.getMonth() + 1, 0).getDate();
  const cellCount = Math.ceil((offset + daysInMonth) / 7) * 7;

  return Array.from({ length: cellCount }, (_, index) => {
    const date = new Date(start);
    date.setDate(start.getDate() + index);
    const dateKey = toDateKey(date);
    return {
      date,
      dateKey,
      day: date.getDate(),
      isCurrentMonth: date.getMonth() === monthDate.getMonth(),
      isToday: dateKey === todayKey,
    };
  });
}

export function parseDateKey(dateKey) {
  const [year, month, day] = dateKey.split('-').map(Number);
  return new Date(year, month - 1, day);
}

function toMonthKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
}

function parseMonthKey(monthKey) {
  const [year, month] = monthKey.split('-').map(Number);
  return new Date(year, month - 1, 1);
}
