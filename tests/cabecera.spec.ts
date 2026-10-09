/**
 * First and last bus from a route's own cabecera
 * (`client/src/services/cabecera.ts`, `server/src/data/horarios_cabecera.json`,
 * spec §5.5.5). Pure logic and the committed dataset: no page, no network.
 *
 * A `.ts` spec on purpose: `cabecera.ts` imports only `schedule.ts`, which the
 * other `.ts` specs already load the same way.
 */

import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  cabeceraDe,
  cabeceraHorario,
  circularSinServicio,
  diasSinServicio,
  esCircular,
  type HorariosCabeceraData,
} from '../client/src/services/cabecera';
import { DAY_FESTIVO, DAY_FRI, DAY_MON, DAY_SAT, DAY_SUN, DAY_THU, DAY_TUE, DAY_WED, type ServiceSpan } from '../client/src/services/schedule';

const WEEKDAYS = DAY_MON | DAY_TUE | DAY_WED | DAY_THU | DAY_FRI;
const data: HorariosCabeceraData = JSON.parse(
  readFileSync(path.resolve(__dirname, '..', 'server', 'src', 'data', 'horarios_cabecera.json'), 'utf8')
);

test.describe('which entry a sentido gets', () => {
  test('the one whose cabecera is its first stop — never the código alone', () => {
    const c149 = { code: 'C149', stops: [{ codigo: '586E13' }] };
    expect(cabeceraDe(data, c149)?.n).toBe('Estación 1 de Mayo');
    // Same código read from another first stop: no entry, not the other end's.
    expect(cabeceraDe(data, { code: 'C149', stops: [{ codigo: '983V03' }] })).toBeNull();
    expect(cabeceraDe(data, { code: 'C149' })).toBeNull();
    expect(cabeceraDe(null, c149)).toBeNull();
  });
});

test.describe('what the page shows', () => {
  // C149 as the catalog files it: 4:00 a.m. – 9:00 p.m. every day.
  const catalogo: ServiceSpan[] = [
    { mask: WEEKDAYS | DAY_SAT, start: 240, end: 1260 },
    { mask: DAY_SUN | DAY_FESTIVO, start: 240, end: 1260 },
  ];

  test('C149: the first bus leaves Est. 1 de Mayo at 5:38, not at the catalog\'s 4:00', () => {
    const entry = cabeceraDe(data, { code: 'C149', stops: [{ codigo: '586E13' }] })!;
    const { rows, aporta, spans } = cabeceraHorario(entry, catalogo);
    expect(aporta).toBe(true);
    expect(rows[0]).toEqual({ days: 'Lun a vie', hours: '5:38 a.m. – 10:36 p.m.' });
    expect(rows.map((r) => r.days)).toEqual(['Lun a vie', 'Sábados', 'Dom y festivos']);
    // The status chip reads these, so it cannot say "último servicio 9:00 p.m.".
    expect(Math.max(...spans.filter((s) => s.mask & DAY_MON).map((s) => s.end))).toBe(1356);
  });

  test('same hours as the catalog: nothing to add, so no second table', () => {
    const entry = { n: 'X', t: 'C' as const, H: [[240, 1260]], S: [[240, 1260]], F: [[240, 1260]] };
    const { rows, aporta } = cabeceraHorario(entry, catalogo);
    expect(aporta).toBe(false);
    expect(rows).toEqual([{ days: 'Todos los días', hours: '4:00 a.m. – 9:00 p.m.' }]);
  });

  test('day types only share a row in an unbroken run from weekdays', () => {
    // Saturday and festivo alike but weekdays different: two rows, not a
    // "Dom y festivos" that silently swallowed Saturday.
    const a = cabeceraHorario({ n: 'X', H: [[300, 1300]], S: [[360, 1200]], F: [[360, 1200]] }, undefined);
    expect(a.rows.map((r) => r.days)).toEqual(['Lun a vie', 'Sábados', 'Dom y festivos']);
    // Weekdays and festivo alike with no Saturday: never "Lun a vie" for both.
    const b = cabeceraHorario({ n: 'X', H: [[300, 1300]], F: [[300, 1300]] }, undefined);
    expect(b.rows.map((r) => r.days)).toEqual(['Lun a vie', 'Dom y festivos']);
    const c = cabeceraHorario({ n: 'X', H: [[300, 1300]], S: [[300, 1300]], F: [[360, 1200]] }, undefined);
    expect(c.rows.map((r) => r.days)).toEqual(['Lun a sáb', 'Dom y festivos']);
  });

  test('two shifts are two windows on one row', () => {
    const { rows } = cabeceraHorario({ n: 'X', H: [[360, 630], [900, 1080]] }, undefined);
    expect(rows[0].hours).toBe('6:00 a.m. – 10:30 a.m. · 3:00 p.m. – 6:00 p.m.');
  });

  test('"No opera" needs both sources: silence in one is not a closed route', () => {
    const soloHabil = { n: 'X', H: [[360, 1200]] };
    // The catalog has no weekend window either → said outright.
    const agree = cabeceraHorario(soloHabil, [{ mask: WEEKDAYS, start: 360, end: 1200 }]);
    expect(agree.noOpera).toEqual(['S', 'F']);
    expect(agree.aporta).toBe(false);
    expect(diasSinServicio(agree.noOpera)).toBe('sábados, domingos ni festivos');
    // The catalog does list Sundays → no claim, and the chip keeps that window.
    const disagree = cabeceraHorario(soloHabil, [
      { mask: WEEKDAYS, start: 360, end: 1200 },
      { mask: DAY_SUN | DAY_FESTIVO, start: 420, end: 1080 },
    ]);
    expect(disagree.noOpera).toEqual(['S']);
    expect(disagree.spans.some((s) => (s.mask & DAY_SUN) !== 0 && s.start === 420)).toBe(true);
    // No catalog schedule at all: unknown, so nothing is asserted.
    expect(cabeceraHorario(soloHabil, undefined).noOpera).toEqual([]);
  });

  test('wording of the days without service', () => {
    expect(diasSinServicio(['S'])).toBe('sábados');
    expect(diasSinServicio(['F'])).toBe('domingos ni festivos');
    expect(diasSinServicio([])).toBe('');
  });
});

test.describe('circular routes', () => {
  test('both códigos of a loop are circular; only the one at the cabecera has hours', () => {
    const a410 = { code: 'A410', stops: [{ codigo: '603A08' }] };
    const f410 = { code: 'F410', stops: [{ codigo: '000X00' }] };
    expect(esCircular(data, a410)).toBe(true);
    expect(esCircular(data, f410)).toBe(true);
    expect(cabeceraDe(data, a410)).not.toBeNull();
    expect(cabeceraDe(data, f410)).toBeNull();
    expect(esCircular(data, { code: 'C149', stops: [{ codigo: '586E13' }] })).toBe(false);
  });

  test('the loop\'s days off hold for the código without a cabecera, if the catalog agrees', () => {
    const a003 = { code: 'A003' };
    expect(circularSinServicio(data, a003, [{ mask: WEEKDAYS, start: 360, end: 1200 }])).toEqual(['S', 'F']);
    expect(circularSinServicio(data, a003, [{ mask: WEEKDAYS | DAY_SAT, start: 360, end: 1200 }])).toEqual(['F']);
    expect(circularSinServicio(data, a003, undefined)).toEqual([]);
  });
});

test.describe('the committed dataset', () => {
  test('every window is ordered and inside a service day', () => {
    const wrong: string[] = [];
    for (const [codigo, cabeceras] of Object.entries(data.rutas)) {
      for (const [cenefa, entry] of Object.entries(cabeceras)) {
        if (!/^\d{3}[A-Z]\d{2}$/.test(cenefa)) wrong.push(`${codigo}: cabecera "${cenefa}"`);
        for (const dia of ['H', 'S', 'F'] as const) {
          for (const [start, end] of entry[dia] ?? []) {
            if (!(start >= 0 && start < 1440 && end > start && end <= 1440 + 6 * 60)) wrong.push(`${codigo} ${dia}: ${start}–${end}`);
          }
        }
        if (!entry.H && !entry.S && !entry.F) wrong.push(`${codigo}@${cenefa}: no day type`);
      }
    }
    expect(wrong).toEqual([]);
  });
});
