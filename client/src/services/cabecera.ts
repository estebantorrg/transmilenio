/**
 * First and last scheduled bus from a route's own cabecera (spec §5.5.5).
 *
 * The catalog carries one operating window per código. For a route with a
 * cabecera at each end that window is frequently the *other* end's: C149 (to
 * Bilbao) reads 4:00 a.m. in the catalog, and the first bus leaves Est. Av. 1 de
 * Mayo at 5:38 — 4:00 is when it leaves Bilbao. TRANSMILENIO's own schedule
 * ("HORARIOS OPERACION RUTAS URBANAS", `server/src/data/horarios_cabecera.json`,
 * built by `scripts/calibration/cabeceras.mjs`) says when buses leave each
 * cabecera, and this module turns that into what the route page shows.
 *
 * Pure: no DOM, no fetch. Its only runtime import is `schedule.ts`, which the
 * `.ts` specs already load (see the note on spec loading in the test).
 */

import {
  DAY_FESTIVO,
  DAY_FRI,
  DAY_MON,
  DAY_SAT,
  DAY_SUN,
  DAY_THU,
  DAY_TUE,
  DAY_WED,
  describeServiceSpans,
  type ServiceSpan,
} from './schedule';

export type DiaTipo = 'H' | 'S' | 'F';

/** One cabecera of one código: its name, topología and windows per day type. */
export interface CabeceraEntry {
  /** The cabecera's name as the schedule prints it. */
  n: string;
  /** `C` circular (one cabecera, the bus comes back to it) · `D` doble cabecera. */
  t?: 'C' | 'D';
  /** `[start, end]` minutes from midnight; `end` past 1440 = after midnight. */
  H?: number[][];
  S?: number[][];
  F?: number[][];
}

/** `server/src/data/horarios_cabecera.json`: código → cabecera (cenefa) → entry. */
export interface HorariosCabeceraData {
  fuente: string;
  rutas: Record<string, Record<string, CabeceraEntry>>;
  /**
   * código → the loop it belongs to: its one cabecera and the day types it runs.
   * Filed under every código of a circular route, including the one that starts
   * mid-loop and so has no entry in `rutas`.
   */
  circulares?: Record<string, { c: string; n: string; d: DiaTipo[] }>;
}

const DIAS: DiaTipo[] = ['H', 'S', 'F'];
const MASK: Record<DiaTipo, number> = {
  H: DAY_MON | DAY_TUE | DAY_WED | DAY_THU | DAY_FRI,
  S: DAY_SAT,
  F: DAY_SUN | DAY_FESTIVO,
};
/** The day each type is recognised by in a catalog span's mask. */
const PROBE: Record<DiaTipo, number> = { H: DAY_MON, S: DAY_SAT, F: DAY_SUN };
const NOMBRE: Record<DiaTipo, string> = { H: 'Lun a vie', S: 'Sábados', F: 'Dom y festivos' };

/**
 * The schedule entry for the sentido on screen: the one whose cabecera is this
 * route's first stop. Nothing is matched by código alone — a código has two
 * ends, and the wrong end's hours are exactly the error this exists to fix.
 */
export function cabeceraDe(
  data: HorariosCabeceraData | null | undefined,
  route: { code: string; stops?: Array<{ codigo: string }> }
): CabeceraEntry | null {
  const first = String(route.stops?.[0]?.codigo ?? '').trim().toUpperCase();
  if (!data || !first) return null;
  return data.rutas[route.code.toUpperCase()]?.[first] ?? null;
}

/** Whether this código is one side of a circular route (true of the loop, whichever sentido is on screen). */
export function esCircular(
  data: HorariosCabeceraData | null | undefined,
  route: { code: string; stops?: Array<{ codigo: string }> }
): boolean {
  return Boolean(data?.circulares?.[route.code.toUpperCase()]) || cabeceraDe(data, route)?.t === 'C';
}

/**
 * The day types a circular route does not run, for the sentido that has no
 * cabecera entry of its own. Same rule as `cabeceraHorario`: only where the
 * catalog agrees it has no window that day.
 */
export function circularSinServicio(
  data: HorariosCabeceraData | null | undefined,
  route: { code: string },
  catalogo: ServiceSpan[] | undefined
): DiaTipo[] {
  const lazo = data?.circulares?.[route.code.toUpperCase()];
  if (!lazo || !catalogo) return [];
  return DIAS.filter((dia) => !lazo.d.includes(dia) && !catalogo.some((s) => (s.mask & PROBE[dia]) !== 0));
}

/** First start and last end of a set of windows, or null when there are none. */
function extent(windows: Array<{ start: number; end: number }>): [number, number] | null {
  if (windows.length === 0) return null;
  return [Math.min(...windows.map((w) => w.start)), Math.max(...windows.map((w) => w.end))];
}

export interface CabeceraHorario {
  /** Rows for the table, weekdays first; identical day types share a row. */
  rows: Array<{ days: string; hours: string }>;
  /**
   * Whether this says something the catalog's window does not: a different
   * first or last bus on some day, or a day the catalog has no window for.
   * When it is false the catalog's table already tells the rider the same.
   */
  aporta: boolean;
  /**
   * The windows this sentido actually runs in, for the "en servicio" chip: the
   * cabecera's own, plus the catalog's on any day type the schedule is silent
   * about while the catalog is not (the disagreement left out of `rows`) — so
   * the chip never calls a route closed on one source's silence either.
   */
  spans: ServiceSpan[];
  /**
   * Day types this sentido does not run on, where the schedule and the catalog
   * agree. Stated on the page even when the hours add nothing: a table with no
   * Saturday row implies it, and a rider planning a Saturday should be told.
   */
  noOpera: DiaTipo[];
}

/** "sábados" · "domingos ni festivos" · "sábados, domingos ni festivos" — after "No opera". */
export function diasSinServicio(dias: DiaTipo[]): string {
  const sabado = dias.includes('S');
  const festivo = dias.includes('F');
  if (dias.includes('H')) return sabado && festivo ? 'ningún día' : 'de lunes a viernes';
  if (sabado && festivo) return 'sábados, domingos ni festivos';
  if (sabado) return 'sábados';
  return festivo ? 'domingos ni festivos' : '';
}

/**
 * The cabecera's schedule as table rows, compared with the catalog's windows.
 *
 * A day type the schedule does not list is "No opera" only when the catalog
 * agrees (it has no window for that day either). Where the catalog does have
 * one, the two sources disagree and the row is left out: saying a route does
 * not run is not something to assert on one source's silence (§1 Certainty).
 */
export function cabeceraHorario(entry: CabeceraEntry, catalogo: ServiceSpan[] | undefined): CabeceraHorario {
  const spans: ServiceSpan[] = [];
  const noOpera: DiaTipo[] = [];
  const delCatalogo: ServiceSpan[] = [];
  let aporta = false;

  const grupos: Array<{ mask: number; ventanas: number[][]; ultimo: DiaTipo }> = [];
  for (const dia of DIAS) {
    const ventanas = entry[dia];
    const enCatalogo = extent((catalogo ?? []).filter((s) => (s.mask & PROBE[dia]) !== 0));
    if (!ventanas || ventanas.length === 0) {
      if (catalogo && !enCatalogo) noOpera.push(dia);
      for (const span of catalogo ?? []) {
        if ((span.mask & MASK[dia]) !== 0) delCatalogo.push({ ...span, mask: span.mask & MASK[dia] });
      }
      continue;
    }
    const propio = extent(ventanas.map(([start, end]) => ({ start, end })))!;
    if (!enCatalogo || Math.abs(propio[0] - enCatalogo[0]) > 1 || Math.abs(propio[1] - enCatalogo[1]) > 1) aporta = true;
    // A day type with the same windows as the one before it joins its row
    // ("Lun a sáb", "Todos los días"), the way the catalog's table groups them.
    // Only an unbroken run that starts on weekdays (H+S, H+S+F): `formatDayMask`
    // has no name for "sábados, domingos y festivos" or for "lun a vie y
    // festivos", and would print either as something it is not.
    const anterior = grupos[grupos.length - 1];
    const sigue = anterior && DIAS.indexOf(anterior.ultimo) === DIAS.indexOf(dia) - 1 && (anterior.mask & DAY_MON) !== 0;
    if (anterior && sigue && JSON.stringify(anterior.ventanas) === JSON.stringify(ventanas)) {
      anterior.mask |= MASK[dia];
      anterior.ultimo = dia;
    } else {
      grupos.push({ mask: MASK[dia], ventanas, ultimo: dia });
    }
  }
  for (const { mask, ventanas } of grupos) {
    for (const [start, end] of ventanas) spans.push({ mask, start, end });
  }

  const rows = describeServiceSpans(spans);
  if (noOpera.length > 0) rows.push({ days: noOpera.map((d) => NOMBRE[d]).join(' · '), hours: 'No opera' });
  return { rows, aporta, spans: [...spans, ...delCatalogo], noOpera };
}
