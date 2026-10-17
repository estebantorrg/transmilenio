/**
 * The one Bogotá wall clock (`shared/bogota_clock.js`) behind the planner's
 * schedules, the live window and the arrivals board. It is a fixed UTC−5
 * offset; the planner used to ask `Intl` for `America/Bogota` instead, and this
 * holds the two to the same answer so dropping `Intl` changed nothing.
 */

import { expect, test } from '@playwright/test';
import { bogotaClock } from '../shared/bogota_clock.js';
import { liveWindowOpenAt } from '../shared/live_window.js';

test('late UTC is still yesterday in Bogotá', () => {
  expect(bogotaClock(Date.UTC(2026, 9, 16, 3, 30))).toEqual({
    year: 2026, month: 10, day: 15, weekday: 4, minute: 22 * 60 + 30,
  });
  expect(bogotaClock(Date.UTC(2027, 0, 1, 4, 59))).toMatchObject({ year: 2026, month: 12, day: 31, minute: 23 * 60 + 59 });
});

test('the fixed offset is what the tz database says, every hour of a year', () => {
  const format = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Bogota', hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short',
  });
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  for (let t = Date.UTC(2026, 0, 1); t < Date.UTC(2027, 0, 1); t += 3_600_000 + 60_000) {
    const p = Object.fromEntries(format.formatToParts(t).map((part) => [part.type, part.value]));
    expect(bogotaClock(t)).toEqual({
      year: Number(p.year), month: Number(p.month), day: Number(p.day),
      weekday: days.indexOf(p.weekday), minute: Number(p.hour) * 60 + Number(p.minute),
    });
  }
});

test('the live window opens at 05:00 and shuts at 23:00 Bogotá', () => {
  expect(liveWindowOpenAt(Date.UTC(2026, 9, 16, 9, 59))).toBe(false); // 04:59
  expect(liveWindowOpenAt(Date.UTC(2026, 9, 16, 10, 0))).toBe(true); // 05:00
  expect(liveWindowOpenAt(Date.UTC(2026, 9, 17, 3, 59))).toBe(true); // 22:59
  expect(liveWindowOpenAt(Date.UTC(2026, 9, 17, 4, 0))).toBe(false); // 23:00
});
