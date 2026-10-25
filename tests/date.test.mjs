import test from 'node:test';
import assert from 'node:assert/strict';
import { getMonthGridDates, shiftDateKey } from '../src/domain/date.mjs';

test('month grids use the necessary four, five or six whole weeks without dropping dates', () => {
  for (const [month, weeks, dayCount] of [
    ['2021-02', 4, 28],
    ['2026-10', 5, 31],
    ['2026-03', 6, 31],
    ['2024-02', 5, 29],
  ]) {
    const dates = getMonthGridDates(month);
    assert.equal(dates.length, weeks * 7);
    assert.equal(dates[0].date.getDay(), 1);
    assert.equal(dates.at(-1).date.getDay(), 0);
    assert.deepEqual(
      dates.filter((day) => day.isCurrentMonth).map((day) => day.day),
      Array.from({ length: dayCount }, (_, i) => i + 1),
    );
    dates.slice(1).forEach((day, index) => assert.equal(day.dateKey, shiftDateKey(dates[index].dateKey, 1)));
  }
});
