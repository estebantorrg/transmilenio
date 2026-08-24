/**
 * The route the rider probably means (spec §5.9).
 *
 * This is what collapses the interaction to a single utterance. "Hey Google, abre
 * TransMi Go" opens the app with the mic hot; if the rider then says nothing, the
 * answer they wanted is usually the route they ask about at this hour anyway, and
 * guessing it costs nothing — they can still speak over it.
 *
 * The model is deliberately trivial: a count per (código, part of day), most-used
 * wins, ties broken by recency. A rider has two or three routes, not a
 * distribution. Counts live in localStorage on this device only (spec §3.3, zero
 * PII) and are capped so the store cannot grow without bound.
 */

import { bogotaNow } from '@shared/services/schedule';

const KEY = 'tmgo.voice.history.v1';
const MAX_ROUTES = 24;

/**
 * Four buckets, not 24 hours: a commute is "mornings" and "evenings", and hourly
 * resolution would just spread the same three routes thinner.
 */
export type DayPart = 'madrugada' | 'manana' | 'tarde' | 'noche';

export function dayPart(hour: number): DayPart {
  if (hour < 5) return 'madrugada';
  if (hour < 12) return 'manana';
  if (hour < 19) return 'tarde';
  return 'noche';
}

/**
 * Bogotá's hour, not the device's. Every other clock in the flow is the city's
 * (`bogotaNow`, schedules, service windows); a phone left on another timezone
 * would otherwise file the morning commute under "tarde" and never match the
 * bucket the prediction is read from.
 */
function bogotaHour(at: Date): number {
  return Math.floor(bogotaNow(at).minute / 60);
}

interface RouteHistory {
  /** Times asked, per part of day. */
  counts: Partial<Record<DayPart, number>>;
  /** Epoch ms of the last question, for tie-breaking. */
  last: number;
}

type Store = Record<string, RouteHistory>;

function read(): Store {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const store: Store = {};
    for (const [code, value] of Object.entries(parsed as Record<string, unknown>)) {
      const entry = value as RouteHistory;
      if (!entry || typeof entry !== 'object') continue;
      if (typeof entry.last !== 'number' || !entry.counts || typeof entry.counts !== 'object') continue;
      store[code] = { counts: entry.counts, last: entry.last };
    }
    return store;
  } catch {
    return {}; // corrupt storage just means no prediction, never a broken launch
  }
}

function write(store: Store): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(store));
  } catch {
    /* storage may be full/blocked — a lost prediction is not worth failing over */
  }
}

/** Record that the rider asked about `code` now. */
export function rememberAsked(code: string, at: Date = new Date()): void {
  if (!code) return;
  const store = read();
  const part = dayPart(bogotaHour(at));
  const entry = store[code] ?? { counts: {}, last: 0 };
  entry.counts[part] = (entry.counts[part] ?? 0) + 1;
  entry.last = at.getTime();
  store[code] = entry;

  const codes = Object.keys(store);
  if (codes.length > MAX_ROUTES) {
    // Evict the least recently asked, not the least used: a route someone rode
    // for a month and then stopped should age out.
    codes
      .sort((a, b) => store[a].last - store[b].last)
      .slice(0, codes.length - MAX_ROUTES)
      .forEach((stale) => delete store[stale]);
  }
  write(store);
}

/**
 * The código to answer when the rider says nothing, or null when there is no
 * honest guess. Requires the route to have been asked about **twice** in this
 * part of the day: answering a one-off as if it were a habit is worse than
 * asking "¿cuál ruta?".
 */
export function predictRoute(at: Date = new Date()): string | null {
  const store = read();
  const part = dayPart(bogotaHour(at));
  let best: { code: string; count: number; last: number } | null = null;

  for (const [code, entry] of Object.entries(store)) {
    const count = entry.counts[part] ?? 0;
    if (count < 2) continue;
    if (!best || count > best.count || (count === best.count && entry.last > best.last)) {
      best = { code, count, last: entry.last };
    }
  }
  return best?.code ?? null;
}

