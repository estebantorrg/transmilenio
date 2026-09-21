/**
 * `scripts/horarios.mjs` — the standalone "is this route running now?" check the
 * scripts use to skip polling closed routes (spec §5.2.3: cut live-host volume).
 *
 * It is a self-contained mirror of `client/src/services/schedule.ts` and
 * `shared/festivos.js`, because scripts get copied around on their own. A mirror
 * is a second definition, so these pin it to the app's answer.
 */

import { expect, test } from '@playwright/test';
import { createServiceClock, parseServiceSpans, serviceIntervals } from '../client/src/services/schedule';
import { isFestivo } from '../shared/festivos.js';
import { routeOpenAt } from '../scripts/horarios.mjs';

type Row = { convencion: string; hora_inicio: string; hora_fin: string };
const h = (...rows: Array<[string, string, string]>) => ({
  data: rows.map(([convencion, hora_inicio, hora_fin]): Row => ({ convencion, hora_inicio, hora_fin })),
});

// Every convención the catalog files, plus the messy clock strings and
// after-midnight closes it is known to carry.
const SCHEDULES = [
  h(['L-V', '4:30 AM', '11:00 PM'], ['S', '5:30 AM', '11:00 PM'], ['D-F', '4:30 AM', '10:00 PM']),
  h(['L-S', '04:00 AM', '11:00 PM'], ['D-F', '5:00 AM', '10:00 PM']),
  h(['D-F', '5:00 AM', '02:00 PM']),
  h(['L-S', '4:30 AM', '12:30 AM']),
  h(['L-D', '5:00 AM', '1:00 am']),
  h(['L-V', '5:00 AM', '9:00 AM'], ['L-V', '4:00 pm', '8:00 PM']),
  h(['D', '6:00 AM', '6:00 PM']),
  h(['L-S', '5:00 AM', '10:00 PM'], ['D', '6:00 AM', '8:00 PM']),
];

// Bogotá dates: a normal week, Monday/Tuesday/Friday/Sunday festivos, Holy
// Thursday, and the day after a Saturday so after-midnight spill is exercised.
const DAYS = [
  '2026-09-14', '2026-09-18', '2026-09-19', '2026-09-20',
  '2026-10-12', '2026-12-08', '2026-12-25', '2026-04-02', '2026-11-01', '2026-11-02',
];

function appSays(horarios: object, year: number, month: number, day: number, minute: number): boolean {
  const spans = parseServiceSpans(horarios as never);
  if (!spans) return true;
  const flat = serviceIntervals(spans, createServiceClock({ year, month, day, minute }));
  for (let i = 0; i < flat.length; i += 2) if (minute >= flat[i] && minute <= flat[i + 1]) return true;
  return false;
}

test.describe('scripts/horarios.mjs', () => {
  test('agrees with the app schedule at every minute of every test day (no margin)', () => {
    const mismatches: string[] = [];
    for (const iso of DAYS) {
      const [year, month, day] = iso.split('-').map(Number);
      for (let minute = 0; minute < 1440; minute += 5) {
        const instant = new Date(Date.UTC(year, month - 1, day) + (minute + 5 * 60) * 60_000);
        for (const horarios of SCHEDULES) {
          const app = appSays(horarios, year, month, day, minute);
          const script = routeOpenAt(horarios, instant, { before: 0, after: 0 });
          if (app !== script) mismatches.push(`${iso} ${minute} ${JSON.stringify(horarios.data)} app=${app}`);
        }
      }
    }
    expect(mismatches.slice(0, 5)).toEqual([]);
  });

  test('its holiday calendar is the shared one', () => {
    // The festivos behind the checks above are only as good as this agreement.
    for (let year = 2025; year <= 2030; year++) {
      for (let t = Date.UTC(year, 0, 1); t < Date.UTC(year + 1, 0, 1); t += 86_400_000) {
        const d = new Date(t);
        const [y, m, day] = [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()];
        // 04:00 Bogotá on that date, against a festivo-only schedule.
        const instant = new Date(t + 9 * 3_600_000);
        const open = routeOpenAt(h(['F', '3:00 AM', '5:00 AM']), instant, { before: 0, after: 0 });
        expect(open, `${y}-${m}-${day}`).toBe(isFestivo(y, m, day));
      }
    }
  });

  test('the margin widens the window on both sides, and an unreadable schedule stays open', () => {
    const weekday = h(['L-V', '5:00 AM', '10:00 PM']);
    const at = (hh: number, mm: number) => new Date(Date.UTC(2026, 8, 15, hh + 5, mm)); // Tue 15-sep, Bogotá
    expect(routeOpenAt(weekday, at(4, 50), { before: 0, after: 0 })).toBe(false);
    expect(routeOpenAt(weekday, at(4, 50))).toBe(true); // 15 min before
    expect(routeOpenAt(weekday, at(22, 55))).toBe(true); // 60 min after
    expect(routeOpenAt(weekday, at(23, 5))).toBe(false);
    expect(routeOpenAt({ data: [{ convencion: '??', hora_inicio: 'x', hora_fin: 'y' }] }, at(3, 0))).toBe(true);
    expect(routeOpenAt(undefined, at(3, 0))).toBe(true);
  });
});
