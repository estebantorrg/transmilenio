/**
 * Departure-moment model for both planners (spec §5.6.2, §1.1 R2).
 *
 * The two clients render different chrome, but WHAT a departure moment means —
 * which days are offerable, which service column applies, how far away it is,
 * and whether it already passed — is decided here once. The website and the app
 * previously each carried their own `serviceDayLabel` copy and their own hint
 * string, so the same instant could be described two ways.
 */

import {
  MINUTES_PER_DAY,
  bogotaNow,
  dayOfWeek,
  festivoName,
  formatClockMinute,
  formatPlanDay,
  planTimeAddMinutes,
  planTimeToInputs,
  type PlanTime,
} from './schedule';

/** Days offered as one-tap chips: today plus a week. */
export const DEPART_DAY_COUNT = 8;

/** Minutes a ± step moves the departure clock. */
export const DEPART_STEP_MINUTES = 15;

export interface DepartDayOption {
  /** `yyyy-mm-dd` — the value an `<input type="date">` carries. */
  date: string;
  /** "Hoy" · "Mañana" · "sáb 8 ago". */
  label: string;
  /** Holiday name when this day runs holiday service (§5.6.2). */
  festivo?: string;
}

/** Whole days between two calendar dates (UTC math: no host-zone drift). */
export function planDayDelta(from: PlanTime, to: PlanTime): number {
  const a = Date.UTC(from.year, from.month - 1, from.day);
  const b = Date.UTC(to.year, to.month - 1, to.day);
  return Math.round((b - a) / 86_400_000);
}

/** Signed minutes from `from` to `to`, across calendar days. */
export function planMinuteDelta(from: PlanTime, to: PlanTime): number {
  return planDayDelta(from, to) * MINUTES_PER_DAY + (to.minute - from.minute);
}

const DAY_SHORT = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];
const MONTH_SHORT = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

/** Chip label for one offerable day, relative to the plan day when it is near. */
export function departDayLabel(day: PlanTime, offset: number): string {
  if (offset === 0) return 'Hoy';
  if (offset === 1) return 'Mañana';
  return `${DAY_SHORT[dayOfWeek(day.year, day.month, day.day)]} ${day.day} ${MONTH_SHORT[day.month - 1]}`;
}

/**
 * The day chips: `count` consecutive days from `now`. A festivo carries its name
 * so the rider can see, before planning, that the day runs holiday service — the
 * single most common reason an itinerary they expected does not exist.
 */
export function departDayOptions(now: PlanTime = bogotaNow(), count = DEPART_DAY_COUNT): DepartDayOption[] {
  const options: DepartDayOption[] = [];
  for (let offset = 0; offset < count; offset++) {
    const day = planTimeAddMinutes({ ...now, minute: 0 }, offset * MINUTES_PER_DAY);
    options.push({
      date: planTimeToInputs(day).date,
      label: departDayLabel(day, offset),
      festivo: festivoName(day.year, day.month, day.day),
    });
  }
  return options;
}

/** "día hábil" / "sábado" / "domingo" / "festivo · <nombre>" — which schedule column applies. */
export function serviceDayLabel(plan: PlanTime): string {
  const holiday = festivoName(plan.year, plan.month, plan.day);
  if (holiday) return `servicio de festivo (${holiday})`;
  const dow = dayOfWeek(plan.year, plan.month, plan.day);
  if (dow === 0) return 'servicio de domingo';
  if (dow === 6) return 'servicio de sábado';
  return 'servicio de día hábil';
}

/** "en 25 min" / "en 3 h 10 min" / "en 2 días" — never a bare timestamp. */
export function formatDepartOffset(minutes: number): string {
  const abs = Math.abs(minutes);
  if (abs < 1) return 'ahora mismo';
  const prefix = minutes < 0 ? 'hace' : 'en';
  if (abs < 60) return `${prefix} ${abs} min`;
  if (abs < MINUTES_PER_DAY) {
    const h = Math.floor(abs / 60);
    const m = abs % 60;
    return m === 0 ? `${prefix} ${h} h` : `${prefix} ${h} h ${m} min`;
  }
  const days = Math.round(abs / MINUTES_PER_DAY);
  return `${prefix} ${days} ${days === 1 ? 'día' : 'días'}`;
}

export interface DepartureDescription {
  /** "mié 5 ago" (holiday named by `service`, never twice). */
  day: string;
  /** "4:30 p.m.". */
  clock: string;
  /** "servicio de día hábil". */
  service: string;
  /** "en 25 min" — how far the moment is from the Bogotá clock. */
  relative: string;
  /** The chosen moment is behind the Bogotá clock: the plan describes the past. */
  past: boolean;
}

export function describeDeparture(plan: PlanTime, now: PlanTime = bogotaNow()): DepartureDescription {
  const delta = planMinuteDelta(now, plan);
  return {
    day: formatPlanDay(plan, false),
    clock: formatClockMinute(plan.minute),
    service: serviceDayLabel(plan),
    relative: formatDepartOffset(delta),
    past: delta <= -1,
  };
}

/**
 * The one-line hint under the control. `mode` only changes the lead-in: the day,
 * clock and service column are stated in both modes, because "Ahora" still has
 * to answer "which service is running right now".
 */
export function departureHint(plan: PlanTime, mode: 'now' | 'custom', now: PlanTime = bogotaNow()): string {
  const d = describeDeparture(plan, now);
  if (mode === 'now') return `Ahora · ${d.day}, ${d.clock} (hora de Bogotá) · ${d.service}`;
  const when = d.past ? 'ya pasó' : d.relative;
  return `${d.day}, ${d.clock} · ${when} · ${d.service}`;
}
