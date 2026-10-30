/**
 * The bus log (spec §5.2.7): which móvil was on which route, where and when.
 *
 * It records what a rider's poll already fetched and never asks the live host
 * itself, so it adds nothing to the upstream volume (§5.2.3). Off unless
 * BUS_LOG_D1_URL and BUS_LOG_D1_TOKEN are set: Render's disk is wiped by every
 * deploy, so the rows live in a Cloudflare D1 database.
 */

import { toFiniteNumber } from '../../../shared/live_payload.js';
import {
  LIVE_DESTINATION_MAX_LENGTH,
  LIVE_ROUTE_CODE_MAX_LENGTH,
  normalizeLiveText,
} from './live_payload.js';

// Every viewer polls every 15 s; without this the log is the same bus over and over.
export const SIGHTING_INTERVAL_MS = 5 * 60_000;
const FLUSH_DELAY_MS = 60_000;
const D1_TIMEOUT_MS = 15_000;
// What a D1 outage may hold in memory on the 512 MB box; the oldest rows go first.
export const MAX_PENDING_SIGHTINGS = 5000;

// The primary key doubles as the lookup by móvil, and makes a retried batch harmless.
const CREATE_TABLE = `CREATE TABLE IF NOT EXISTS sightings (
  movil TEXT NOT NULL,
  ruta TEXT NOT NULL,
  destino TEXT NOT NULL,
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  posicion REAL,
  lasttime TEXT NOT NULL,
  seen_at TEXT NOT NULL,
  PRIMARY KEY (movil, ruta, seen_at)
) WITHOUT ROWID`;

// One bound JSON array, because D1 allows only 100 bound values per statement.
const INSERT_ROWS = `INSERT OR IGNORE INTO sightings (movil, ruta, destino, lat, lng, posicion, lasttime, seen_at)
SELECT value->>'movil', value->>'ruta', value->>'destino', value->>'lat', value->>'lng', value->>'posicion', value->>'lasttime', value->>'seen_at'
FROM json_each(?)`;

export interface Sighting {
  movil: string;
  ruta: string;
  destino: string;
  lat: number;
  lng: number;
  /** Metres along the route, as the feed reports it. */
  posicion: number | null;
  /** The fix's Bogotá clock time, as the feed writes it ("06:59:24 AM"); it can lag `seen_at`. */
  lasttime: string;
  /** When the server read it, ISO UTC. */
  seen_at: string;
}

/** The rows a poll's answer adds to the log. `seen` remembers when each bus last went in. */
export function pickSightings(ruta: string, buses: any[], now: number, seen: Map<string, number>): Sighting[] {
  const rows: Sighting[] = [];
  for (const bus of buses) {
    const movil = normalizeLiveText(bus?.label ?? bus?.id, LIVE_ROUTE_CODE_MAX_LENGTH);
    const lat = toFiniteNumber(bus?.latitude ?? bus?.lat);
    const lng = toFiniteNumber(bus?.longitude ?? bus?.lng ?? bus?.lon);
    if (!movil || !lat || !lng) continue; // 0 is a bus with no fix, not a place
    const busRuta = normalizeLiveText(bus.ruta_extraida, LIVE_ROUTE_CODE_MAX_LENGTH) || ruta;
    const key = `${movil}|${busRuta}`;
    if (now - (seen.get(key) ?? -Infinity) < SIGHTING_INTERVAL_MS) continue;
    seen.set(key, now);
    rows.push({
      movil,
      ruta: busRuta,
      destino: normalizeLiveText(bus.destino_limpio, LIVE_DESTINATION_MAX_LENGTH),
      lat,
      lng,
      posicion: toFiniteNumber(bus.posicion),
      lasttime: normalizeLiveText(bus.lasttime, LIVE_ROUTE_CODE_MAX_LENGTH),
      seen_at: new Date(now).toISOString(),
    });
  }
  return rows;
}

const lastLogged = new Map<string, number>();
// shortcut: a restart loses up to a minute of rows; add a SIGTERM flush if that ever matters.
const pending: Sighting[] = [];
let flushTimer: NodeJS.Timeout | null = null;
let tableReady = false;

function capPending(): void {
  if (pending.length > MAX_PENDING_SIGHTINGS) pending.splice(0, pending.length - MAX_PENDING_SIGHTINGS);
}

async function queryD1(url: string, token: string, sql: string, params: string[] = []): Promise<void> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ sql, params }),
    signal: AbortSignal.timeout(D1_TIMEOUT_MS),
  });
  const body: any = await res.json().catch(() => null);
  if (!res.ok || !body?.success) throw new Error(`D1 answered ${res.status}`);
}

/** Queue a poll's buses. Called from inside `/api/buses`, which must never fail, so it cannot throw. */
export function logSightings(ruta: string, buses: any[]): void {
  if (!process.env.BUS_LOG_D1_URL || !process.env.BUS_LOG_D1_TOKEN) return;
  pending.push(...pickSightings(ruta, buses, Date.now(), lastLogged));
  capPending();
  if (pending.length > 0 && !flushTimer) {
    flushTimer = setTimeout(() => void flushSightings(), FLUSH_DELAY_MS);
    flushTimer.unref();
  }
}

/** Send what is queued. A failed batch goes back in line for the flush the next poll schedules. */
export async function flushSightings(): Promise<void> {
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = null;
  const url = process.env.BUS_LOG_D1_URL;
  const token = process.env.BUS_LOG_D1_TOKEN;
  if (!url || !token || pending.length === 0) return;

  const batch = pending.splice(0, pending.length);
  try {
    if (!tableReady) {
      await queryD1(url, token, CREATE_TABLE);
      tableReady = true;
    }
    await queryD1(url, token, INSERT_ROWS, [JSON.stringify(batch)]);
  } catch (error: any) {
    console.error(`[bus log] ${batch.length} rows not saved, will retry: ${error?.message ?? error}`);
    pending.unshift(...batch);
    capPending();
  }

  const now = Date.now();
  for (const [key, at] of lastLogged) if (now - at >= SIGHTING_INTERVAL_MS) lastLogged.delete(key);
}
