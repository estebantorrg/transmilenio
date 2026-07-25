/**
 * Service schedules (`horarios`) — parser, Bogotá service calendar, and the
 * queries the router and both front-ends run against them.
 *
 * Single source of truth for "does this route operate at this moment": the
 * website planner, the native app planner, the shared graph router and both
 * route-detail views import it verbatim (spec §1.1 R2 — no duplicated logic).
 * Kept free of DOM / Vite globals so the router stays importable from Node.
 *
 * Source data (verified over the committed catalog, 1054 route variants / 2333
 * rows — every variant carries `horarios.data`):
 *   convención ∈ { L-V, L-S, S, D, D-F, L-D }
 *   hours are 12-hour clock strings ("4:30 AM", "04:00 AM", "2:00 pm")
 *   168 rows close after midnight ("12:30 AM") → the window spills into the
 *   next day and must not be read as a zero-length span.
 */

import type { CatalogRoute } from '../types/catalog';

export const MINUTES_PER_DAY = 1440;

// ─── Day masks ──────────────────────────────────────────────────────────────
// One bit per weekday, indexed like Date#getDay (0 = domingo), plus a dedicated
// FESTIVO bit: Bogotá files holiday service separately from weekday service
// ("D-F" = domingos y festivos), and on a holiday a route runs its holiday
// window, never the Monday–Friday one.
export const DAY_SUN = 1 << 0;
export const DAY_MON = 1 << 1;
export const DAY_TUE = 1 << 2;
export const DAY_WED = 1 << 3;
export const DAY_THU = 1 << 4;
export const DAY_FRI = 1 << 5;
export const DAY_SAT = 1 << 6;
export const DAY_FESTIVO = 1 << 7;

const WEEKDAY_BITS = DAY_MON | DAY_TUE | DAY_WED | DAY_THU | DAY_FRI;
const DAY_BIT_BY_INDEX = [DAY_SUN, DAY_MON, DAY_TUE, DAY_WED, DAY_THU, DAY_FRI, DAY_SAT];

/** Catalog `convencion` → day mask. Unknown strings yield 0 (see parseServiceSpans). */
const CONVENCION_MASKS: Record<string, number> = {
  'L-V': WEEKDAY_BITS,
  'L-S': WEEKDAY_BITS | DAY_SAT,
  'L-D': WEEKDAY_BITS | DAY_SAT | DAY_SUN | DAY_FESTIVO,
  L: DAY_MON,
  S: DAY_SAT,
  D: DAY_SUN,
  'D-F': DAY_SUN | DAY_FESTIVO,
  'D-F-A': DAY_SUN | DAY_FESTIVO,
  F: DAY_FESTIVO,
};

/** One operating window: `mask` days, `start`–`end` minutes from midnight. */
export interface ServiceSpan {
  mask: number;
  start: number;
  /** May exceed MINUTES_PER_DAY when the window closes after midnight. */
  end: number;
}

function normalizeConvencion(value: unknown): string {
  return String(value ?? '')
    .toUpperCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[\s.]/g, '');
}

const CLOCK_RE = /^(\d{1,2}):(\d{2})\s*(AM|PM)?$/;

/** "4:30 AM" / "04:00 am" / "23:15" → minutes from midnight. `null` if unreadable. */
export function parseClockMinutes(value: unknown): number | null {
  const text = String(value ?? '')
    .trim()
    .toUpperCase()
    .replace(/\./g, '')
    .replace(/\s+/g, ' ');
  const match = CLOCK_RE.exec(text);
  if (!match) return null;

  let hour = Number(match[1]);
  const minute = Number(match[2]);
  if (!Number.isFinite(hour) || !Number.isFinite(minute) || minute > 59) return null;

  if (match[3]) {
    if (hour < 1 || hour > 12) return null;
    hour %= 12;
    if (match[3] === 'PM') hour += 12;
  } else if (hour > 23) {
    return null;
  }

  return hour * 60 + minute;
}

/**
 * Catalog `horarios` → operating windows.
 *
 * Returns `undefined` when nothing readable is present — the deliberate
 * "unknown schedule" signal, which every consumer treats as *always operating*.
 * A route is never hidden because its hours could not be parsed (spec §1 —
 * certainty over guessing, and §4.2 graceful degradation).
 */
export function parseServiceSpans(horarios: CatalogRoute['horarios'] | undefined): ServiceSpan[] | undefined {
  const rows = horarios?.data;
  if (!Array.isArray(rows) || rows.length === 0) return undefined;

  const spans: ServiceSpan[] = [];
  const seen = new Set<string>();

  for (const row of rows) {
    const mask = CONVENCION_MASKS[normalizeConvencion(row?.convencion)] ?? 0;
    const start = parseClockMinutes(row?.hora_inicio);
    const rawEnd = parseClockMinutes(row?.hora_fin);
    if (mask === 0 || start === null || rawEnd === null) continue;

    // "4:30 AM – 12:30 AM" closes 30 min into the next day, not 20 h earlier.
    const end = rawEnd <= start ? rawEnd + MINUTES_PER_DAY : rawEnd;

    const key = `${mask}|${start}|${end}`;
    if (seen.has(key)) continue;
    seen.add(key);
    spans.push({ mask, start, end });
  }

  return spans.length > 0 ? spans : undefined;
}

/** Union of two schedule sets (used when the catalog merges route variants). */
export function mergeServiceSpans(
  a: ServiceSpan[] | undefined,
  b: ServiceSpan[] | undefined
): ServiceSpan[] | undefined {
  // An unknown schedule means "always operating", so it absorbs the other side.
  if (!a || !b) return undefined;
  const merged: ServiceSpan[] = [];
  const seen = new Set<string>();
  for (const span of [...a, ...b]) {
    const key = `${span.mask}|${span.start}|${span.end}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(span);
  }
  return merged;
}

// ─── Bogotá wall clock ──────────────────────────────────────────────────────
// Schedules are Bogotá local time. The device may be anywhere (a maintainer
// outside Colombia, a traveller's phone), so the planning clock is always
// resolved in America/Bogota and carried as plain wall-clock fields — no Date
// arithmetic that a host time zone could shift underneath us.

const BOGOTA_TIME_ZONE = 'America/Bogota';
const BOGOTA_UTC_OFFSET_MINUTES = -300; // fixed, no DST — the Intl fallback

/** A wall-clock instant in Bogotá. `minute` is minutes from local midnight. */
export interface PlanTime {
  year: number;
  month: number; // 1–12
  day: number;
  minute: number;
}

let bogotaParts: Intl.DateTimeFormat | null | undefined;

function getBogotaFormatter(): Intl.DateTimeFormat | null {
  if (bogotaParts !== undefined) return bogotaParts;
  try {
    bogotaParts = new Intl.DateTimeFormat('en-CA', {
      timeZone: BOGOTA_TIME_ZONE,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    bogotaParts = null;
  }
  return bogotaParts;
}

/** The current Bogotá wall clock. */
export function bogotaNow(now: Date = new Date()): PlanTime {
  const formatter = getBogotaFormatter();
  if (formatter) {
    const parts: Record<string, string> = {};
    for (const part of formatter.formatToParts(now)) parts[part.type] = part.value;
    const year = Number(parts.year);
    const month = Number(parts.month);
    const day = Number(parts.day);
    const hour = Number(parts.hour);
    const minute = Number(parts.minute);
    if ([year, month, day, hour, minute].every(Number.isFinite)) {
      return { year, month, day, minute: hour * 60 + minute };
    }
  }

  const shifted = new Date(now.getTime() + BOGOTA_UTC_OFFSET_MINUTES * 60_000);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    minute: shifted.getUTCHours() * 60 + shifted.getUTCMinutes(),
  };
}

/** `"2026-07-24"` + `"14:05"` → PlanTime. `null` when either input is unusable. */
export function planTimeFromInputs(dateValue: string, timeValue: string): PlanTime | null {
  const date = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateValue || '').trim());
  const time = /^(\d{1,2}):(\d{2})/.exec(String(timeValue || '').trim());
  if (!date || !time) return null;

  const year = Number(date[1]);
  const month = Number(date[2]);
  const day = Number(date[3]);
  const hour = Number(time[1]);
  const minute = Number(time[2]);
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) return null;

  return { year, month, day, minute: hour * 60 + minute };
}

/** `PlanTime` → the `<input type="date">` / `<input type="time">` pair. */
export function planTimeToInputs(plan: PlanTime): { date: string; time: string } {
  const pad = (n: number) => String(n).padStart(2, '0');
  const minute = ((plan.minute % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  return {
    date: `${plan.year}-${pad(plan.month)}-${pad(plan.day)}`,
    time: `${pad(Math.floor(minute / 60))}:${pad(minute % 60)}`,
  };
}

/** Shifts a plan time by whole minutes, rolling the calendar date as needed. */
export function planTimeAddMinutes(plan: PlanTime, minutes: number): PlanTime {
  const total = plan.minute + Math.round(minutes);
  const dayShift = Math.floor(total / MINUTES_PER_DAY);
  const minute = total - dayShift * MINUTES_PER_DAY;
  const shifted = new Date(Date.UTC(plan.year, plan.month - 1, plan.day + dayShift));
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    minute,
  };
}

/** 0 = domingo … 6 = sábado. UTC math so the host time zone can never shift it. */
export function dayOfWeek(year: number, month: number, day: number): number {
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

// ─── Colombian holiday calendar ─────────────────────────────────────────────
// Festivos are law, not a guess: six fixed dates, seven Emiliani dates (Ley 51
// de 1983 — observed the following Monday), and five Easter-relative dates.
// Computed, not tabulated, so the calendar never expires.

const FIXED_HOLIDAYS: Array<[number, number, string]> = [
  [1, 1, 'Año Nuevo'],
  [5, 1, 'Día del Trabajo'],
  [7, 20, 'Día de la Independencia'],
  [8, 7, 'Batalla de Boyacá'],
  [12, 8, 'Inmaculada Concepción'],
  [12, 25, 'Navidad'],
];

const EMILIANI_HOLIDAYS: Array<[number, number, string]> = [
  [1, 6, 'Día de los Reyes Magos'],
  [3, 19, 'Día de San José'],
  [6, 29, 'San Pedro y San Pablo'],
  [8, 15, 'Asunción de la Virgen'],
  [10, 12, 'Día de la Raza'],
  [11, 1, 'Todos los Santos'],
  [11, 11, 'Independencia de Cartagena'],
];

/** Easter Sunday (Gregorian, Meeus/Jones/Butcher). */
function easterSunday(year: number): Date {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(Date.UTC(year, month - 1, day));
}

function keyOf(date: Date): string {
  return `${date.getUTCFullYear()}-${date.getUTCMonth() + 1}-${date.getUTCDate()}`;
}

/** Same date, or the following Monday when it falls on any other weekday. */
function nextMonday(date: Date): Date {
  const dow = date.getUTCDay();
  if (dow === 1) return date;
  const shift = (8 - dow) % 7;
  return new Date(date.getTime() + shift * 86_400_000);
}

const holidayCache = new Map<number, Map<string, string>>();

function holidaysForYear(year: number): Map<string, string> {
  const cached = holidayCache.get(year);
  if (cached) return cached;

  const holidays = new Map<string, string>();
  const add = (date: Date, name: string) => holidays.set(keyOf(date), name);

  for (const [month, day, name] of FIXED_HOLIDAYS) add(new Date(Date.UTC(year, month - 1, day)), name);
  for (const [month, day, name] of EMILIANI_HOLIDAYS) add(nextMonday(new Date(Date.UTC(year, month - 1, day))), name);

  const easter = easterSunday(year);
  const fromEaster = (days: number) => new Date(easter.getTime() + days * 86_400_000);
  add(fromEaster(-3), 'Jueves Santo');
  add(fromEaster(-2), 'Viernes Santo');
  add(fromEaster(43), 'Ascensión del Señor'); // Thursday +39, observed Monday
  add(fromEaster(64), 'Corpus Christi'); //      Thursday +60, observed Monday
  add(fromEaster(71), 'Sagrado Corazón'); //     Friday   +68, observed Monday

  holidayCache.set(year, holidays);
  return holidays;
}

/** Colombian public-holiday name for a date, or `undefined` on a normal day. */
export function festivoName(year: number, month: number, day: number): string | undefined {
  return holidaysForYear(year).get(`${year}-${month}-${day}`);
}

export function isFestivo(year: number, month: number, day: number): boolean {
  return holidaysForYear(year).has(`${year}-${month}-${day}`);
}

// ─── Service clock ──────────────────────────────────────────────────────────

/**
 * The calendar context of one planning request. Windows are evaluated over
 * three days — the day before, the plan day, the day after — so a trip that
 * starts at 00:20 still sees the previous day's "…–12:30 AM" window and one
 * that starts at 23:50 sees tomorrow's opening.
 */
export interface ServiceClock {
  plan: PlanTime;
  /** Minutes from the plan day's midnight at which the traveller departs. */
  departMinute: number;
  /** Day masks for plan-day offsets −1, 0, +1. */
  dayMasks: [number, number, number];
  /** Whether each of those days is a holiday. */
  festivos: [boolean, boolean, boolean];
}

function dayMaskFor(plan: PlanTime, offsetDays: number): { mask: number; festivo: boolean } {
  const date = new Date(Date.UTC(plan.year, plan.month - 1, plan.day + offsetDays));
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + 1;
  const day = date.getUTCDate();
  const festivo = isFestivo(year, month, day);
  const dow = date.getUTCDay();
  // On a holiday the weekday bit is deliberately NOT set: holiday service is
  // its own convención, so a Monday–Friday window must not apply on a Monday
  // festivo. A Sunday that is also a holiday keeps both bits.
  const mask = festivo ? DAY_FESTIVO | (dow === 0 ? DAY_SUN : 0) : DAY_BIT_BY_INDEX[dow];
  return { mask, festivo };
}

export function createServiceClock(plan: PlanTime): ServiceClock {
  const before = dayMaskFor(plan, -1);
  const today = dayMaskFor(plan, 0);
  const after = dayMaskFor(plan, 1);
  return {
    plan,
    departMinute: plan.minute,
    dayMasks: [before.mask, today.mask, after.mask],
    festivos: [before.festivo, today.festivo, after.festivo],
  };
}

/**
 * Concrete operating intervals (flat `[start, end, start, end, …]` pairs, in
 * minutes from the plan day's midnight — negative values are the day before)
 * for one route under one clock. Sorted and merged, so membership tests are a
 * short linear scan.
 */
export function serviceIntervals(spans: ServiceSpan[], clock: ServiceClock): number[] {
  const spansMask = spans.reduce((mask, span) => mask | span.mask, 0);
  const pairs: Array<[number, number]> = [];

  for (let i = 0; i < 3; i++) {
    let mask = clock.dayMasks[i];
    // Festivo fallback: a route that files no holiday window (no D-F / L-D row)
    // but does run Sundays keeps its Sunday window on holidays — the Bogotá
    // convention. Without this, holidays would read as "everything is closed".
    if (clock.festivos[i] && (spansMask & DAY_FESTIVO) === 0) mask |= DAY_SUN;

    const offset = (i - 1) * MINUTES_PER_DAY;
    for (const span of spans) {
      if ((span.mask & mask) === 0) continue;
      pairs.push([offset + span.start, offset + span.end]);
    }
  }

  pairs.sort((a, b) => a[0] - b[0]);

  const flat: number[] = [];
  for (const [start, end] of pairs) {
    const lastEndIdx = flat.length - 1;
    if (lastEndIdx >= 0 && start <= flat[lastEndIdx]) {
      if (end > flat[lastEndIdx]) flat[lastEndIdx] = end;
      continue;
    }
    flat.push(start, end);
  }
  return flat;
}

/**
 * Minutes of the plan day (00:00–24:00) this service actually covers.
 *
 * The intervals span three days, so clipping to the plan day is what turns them
 * into "how long does this route run today" — a route open 4:30 a.m.–11:00 p.m.
 * scores 1110, a 3 h peak-only shuttle scores 180. The planner ranks boardings
 * by this (§5.6.2): a long-running service is the more useful answer even when
 * both are open at the moment of the query.
 */
export function serviceMinutesOnPlanDay(intervals: number[]): number {
  let total = 0;
  for (let i = 0; i < intervals.length; i += 2) {
    const start = Math.max(intervals[i], 0);
    const end = Math.min(intervals[i + 1], MINUTES_PER_DAY);
    if (end > start) total += end - start;
  }
  return total;
}

/** Is the service running at `minute` (plan-day minutes)? */
export function isOpenAt(intervals: number[], minute: number): boolean {
  for (let i = 0; i < intervals.length; i += 2) {
    if (minute < intervals[i]) return false;
    if (minute <= intervals[i + 1]) return true;
  }
  return false;
}

/** Start of the first window that begins at or after `minute`, else `null`. */
export function nextOpeningAt(intervals: number[], minute: number): number | null {
  for (let i = 0; i < intervals.length; i += 2) {
    if (intervals[i] >= minute) return intervals[i];
  }
  return null;
}

/** End of the window covering `minute` (i.e. its last service), else `null`. */
export function closingAfter(intervals: number[], minute: number): number | null {
  for (let i = 0; i < intervals.length; i += 2) {
    if (minute < intervals[i]) return null;
    if (minute <= intervals[i + 1]) return intervals[i + 1];
  }
  return null;
}

/**
 * Minutes the traveller must wait at the stop before this service can be
 * boarded at `minute`: `0` when it is already running, a positive wait when it
 * opens within `maxWait`, `null` when it cannot be boarded at all.
 */
export function boardingWaitAt(intervals: number[], minute: number, maxWait: number): number | null {
  if (isOpenAt(intervals, minute)) return 0;
  const next = nextOpeningAt(intervals, minute);
  if (next === null) return null;
  const wait = next - minute;
  return wait <= maxWait ? wait : null;
}

// ─── Presentation ───────────────────────────────────────────────────────────

const DAY_NAMES_SHORT = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];
const MONTH_NAMES_SHORT = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

/** Minutes (any day offset) → "2:05 p.m.". */
export function formatClockMinute(minute: number): string {
  const normalized = ((Math.round(minute) % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  const hour24 = Math.floor(normalized / 60);
  const mins = normalized % 60;
  const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
  return `${hour12}:${String(mins).padStart(2, '0')} ${hour24 < 12 ? 'a.m.' : 'p.m.'}`;
}

/** A daily operating length: "18 h" / "6 h 30 min" / "45 min". */
export function formatServiceDuration(minutes: number): string {
  const total = Math.max(0, Math.round(minutes));
  const hours = Math.floor(total / 60);
  const mins = total % 60;
  if (hours === 0) return `${mins} min`;
  return mins === 0 ? `${hours} h` : `${hours} h ${mins} min`;
}

/** " (mañana)" / " (ayer)" when a minute falls outside the plan day. */
export function dayOffsetSuffix(minute: number): string {
  const offset = Math.floor(minute / MINUTES_PER_DAY);
  if (offset === 0) return '';
  if (offset === 1) return ' (mañana)';
  if (offset === -1) return ' (ayer)';
  return offset > 0 ? ` (+${offset} días)` : ` (${offset} días)`;
}

/** "4:30 a.m. – 11:00 p.m." (the closing side marked when it is past midnight). */
export function formatServiceRange(start: number, end: number): string {
  const endLabel = formatClockMinute(end);
  const crosses = end >= MINUTES_PER_DAY;
  return `${formatClockMinute(start)} – ${endLabel}${crosses ? ' (día siguiente)' : ''}`;
}

export function formatDayMask(mask: number): string {
  const hasAllWeekdays = (mask & WEEKDAY_BITS) === WEEKDAY_BITS;
  const hasSat = (mask & DAY_SAT) !== 0;
  const hasSun = (mask & DAY_SUN) !== 0;
  const hasFestivo = (mask & DAY_FESTIVO) !== 0;

  if (hasAllWeekdays && hasSat && hasSun) return 'Todos los días';
  if (hasAllWeekdays && hasSat) return 'Lun a sáb';
  if (hasAllWeekdays) return 'Lun a vie';
  if (hasSun && hasFestivo) return 'Dom y festivos';
  if (hasSun) return 'Domingos';
  if (hasFestivo) return 'Festivos';
  if (hasSat) return 'Sábados';

  const names: string[] = [];
  for (let i = 0; i < 7; i++) {
    if (mask & DAY_BIT_BY_INDEX[i]) names.push(DAY_NAMES_SHORT[i]);
  }
  return names.length > 0 ? names.join(', ') : 'Sin horario';
}

/** Day-grouped rows for the route-detail schedule table. */
export function describeServiceSpans(spans: ServiceSpan[]): Array<{ days: string; hours: string }> {
  const byMask = new Map<number, ServiceSpan[]>();
  for (const span of spans) {
    const group = byMask.get(span.mask);
    if (group) group.push(span);
    else byMask.set(span.mask, [span]);
  }

  const rank = (mask: number): number => {
    if (mask & DAY_MON) return (mask & DAY_SAT) === 0 ? 0 : 1;
    if (mask & DAY_SAT) return 2;
    if (mask & DAY_SUN) return 3;
    return 4;
  };

  return [...byMask.entries()]
    .sort((a, b) => rank(a[0]) - rank(b[0]) || a[1][0].start - b[1][0].start)
    .map(([mask, group]) => ({
      days: formatDayMask(mask),
      hours: group
        .slice()
        .sort((a, b) => a.start - b.start)
        .map((span) => formatServiceRange(span.start, span.end))
        .join(' · '),
    }));
}

/** "vie 24 jul", plus the holiday name unless the caller already states it. */
export function formatPlanDay(plan: PlanTime, includeFestivo = true): string {
  const dow = dayOfWeek(plan.year, plan.month, plan.day);
  const base = `${DAY_NAMES_SHORT[dow]} ${plan.day} ${MONTH_NAMES_SHORT[plan.month - 1]}`;
  const holiday = includeFestivo ? festivoName(plan.year, plan.month, plan.day) : undefined;
  return holiday ? `${base} · festivo (${holiday})` : base;
}

export interface ServiceStatus {
  state: 'open' | 'closed' | 'unknown';
  /** Short chip label, e.g. "En servicio" / "Fuera de servicio". */
  label: string;
  /** Supporting line, e.g. "Cierra 11:00 p.m." / "Abre 4:30 a.m. (mañana)". */
  detail: string;
}

/** Live "is it running right now" status for a route, for the detail views. */
export function serviceStatus(spans: ServiceSpan[] | undefined, plan: PlanTime): ServiceStatus {
  if (!spans || spans.length === 0) {
    return { state: 'unknown', label: 'Horario no disponible', detail: '' };
  }

  const clock = createServiceClock(plan);
  const intervals = serviceIntervals(spans, clock);
  const minute = clock.departMinute;

  if (isOpenAt(intervals, minute)) {
    const closes = closingAfter(intervals, minute);
    return {
      state: 'open',
      label: 'En servicio',
      detail: closes === null ? '' : `Último servicio ${formatClockMinute(closes)}${dayOffsetSuffix(closes)}`,
    };
  }

  const opens = nextOpeningAt(intervals, minute);
  return {
    state: 'closed',
    label: 'Fuera de servicio',
    detail: opens === null ? 'No opera hoy' : `Abre ${formatClockMinute(opens)}${dayOffsetSuffix(opens)}`,
  };
}
