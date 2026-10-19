/**
 * Builds the station-demand catalog (`data/station_demand.json`) from TRANSMILENIO's
 * open "Salidas" dataset — daily per-station entry/exit (validation) counts.
 *
 * Source: TRANSMILENIO's open-data site for validaciones (spec §5.8,
 * "Validaciones/Salidas"), which replaced the public `gs://validaciones_tmsa`
 * bucket on 2026-10-13 — the bucket now answers 403 to every anonymous read,
 * with the same file names served from the new host. Each
 * `Salidas/salidasYYYYMMDD.zip` holds one CSV of
 * per-access, per-15-min `Entradas_E`/`Salidas_S` counts. Like the master catalog
 * and recharge points, we aggregate offline and commit the small result so
 * production serves it read-only with no bulk download/parse on the hot path
 * (the raw files are ~1.5 MB × N days, 130k rows each — far past the 512 MB
 * box's budget, spec §5.1.3).
 *
 * We sample the most recent WEEKDAYS (service demand is a weekday phenomenon;
 * weekends/holidays would only depress the average) and report the mean daily
 * footfall per station. Each station code (`Estacion` = `(NNNNN)Name`) is joined
 * to the ArcGIS troncal station layer by `numero_estacion` for its name +
 * coordinates; unmatched codes (bike parks, yards, temporary stops) are dropped.
 *
 * Run from anywhere (the site is public, no Colombian egress needed):
 *   npm run sync:demand
 */
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { aggregateDay, isOrdinaryWeekday, unzipSingleEntry } from './services/salidas.js';

// The host refuses GitHub's runners, so the workflow sets SALIDAS_BASE_URL to the
// relay Worker (`scripts/salidas-relay/worker`); anywhere else asks it directly.
const SALIDAS = (process.env.SALIDAS_BASE_URL || 'https://validaciones.datosabiertos.transmilenio.gov.co/Salidas').replace(/\/$/, '');
const STATIONS_URL =
  'https://gis.transmilenio.gov.co/arcgis/rest/services/Troncal/consulta_estaciones_troncales/FeatureServer/0/query' +
  '?where=1=1&outFields=numero_estacion,nombre_estacion,codigo_nodo_estacion,latitud_estacion,longitud_estacion' +
  '&returnGeometry=false&f=json';
const OUT = join(dirname(fileURLToPath(import.meta.url)), 'data', 'station_demand.json');

/** How many recent weekday files to average, and how far back to search for them. */
const TARGET_DAYS = 15;
const MAX_LOOKBACK_DAYS = 45;

interface StationRef {
  nombre: string;
  nodo: number | null;
  lat: number;
  lon: number;
}

export interface StationDemand {
  codigo: string; // 5-digit numero_estacion (join key)
  nodo: number | null;
  nombre: string;
  lat: number;
  lon: number;
  entradas: number; // mean per weekday
  salidas: number; // mean per weekday
  total: number; // entradas + salidas, mean per weekday
  rank: number; // 1 = busiest
}

async function fetchStationRefs(): Promise<Map<string, StationRef>> {
  const res = await fetch(STATIONS_URL);
  if (!res.ok) throw new Error(`troncal stations HTTP ${res.status}`);
  const json = await res.json() as { features?: Array<{ attributes: any }> };
  const refs = new Map<string, StationRef>();
  for (const feat of json.features || []) {
    const a = feat.attributes;
    const code = String(a.numero_estacion ?? '').padStart(5, '0');
    const lat = Number(a.latitud_estacion);
    const lon = Number(a.longitud_estacion);
    if (!/^\d{5}$/.test(code) || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    refs.set(code, {
      nombre: String(a.nombre_estacion ?? '').trim(),
      nodo: Number.isFinite(Number(a.codigo_nodo_estacion)) ? Number(a.codigo_nodo_estacion) : null,
      lat,
      lon,
    });
  }
  // ArcGIS answers a failed query with HTTP 200 and an `error` body, which
  // parses to no features at all. Every station is dropped by the join below
  // without one, so stop here rather than download fifteen days for nothing.
  if (refs.size === 0) throw new Error('troncal stations returned no usable features');
  return refs;
}

function fileNameForDate(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `salidas${y}${m}${day}.zip`;
}

export async function syncStationDemand(): Promise<number> {
  const refs = await fetchStationRefs();
  console.log(`[sync:demand] ${refs.size} troncal stations for the join`);

  const agg = new Map<string, { e: number; s: number }>();
  let daysUsed = 0;
  const usedDates: string[] = [];
  // Skip today (the current day's file may be partial/absent); walk backwards.
  const cursor = new Date();
  cursor.setUTCDate(cursor.getUTCDate() - 1);

  for (let back = 0; back < MAX_LOOKBACK_DAYS && daysUsed < TARGET_DAYS; back++, cursor.setUTCDate(cursor.getUTCDate() - 1)) {
    if (!isOrdinaryWeekday(cursor)) continue; // weekdays only, festivos out
    const name = fileNameForDate(cursor);
    try {
      const res = await fetch(`${SALIDAS}/${name}`);
      // A missing day (not yet published) is routine; logged anyway, because a
      // host that refuses EVERY day read as "no files" with the cause unsaid.
      if (!res.ok) {
        console.warn(`[sync:demand] ${name} HTTP ${res.status} — skipped`);
        continue;
      }
      const buf = Buffer.from(await res.arrayBuffer());
      const csv = unzipSingleEntry(buf).toString('utf8');
      const rows = aggregateDay(csv, agg);
      // A day that parsed to ZERO rows must not count: `daysUsed` is the divisor
      // for every mean, so an upstream format change would silently deflate the
      // whole dataset instead of failing (spec §1 certainty).
      if (rows === 0) {
        console.warn(`[sync:demand] ${name} parsed 0 rows — skipped (CSV format changed?)`);
        continue;
      }
      daysUsed++;
      usedDates.push(name.slice(7, 15));
      console.log(`[sync:demand] ${name} ok, ${rows} rows (${daysUsed}/${TARGET_DAYS})`);
    } catch (err: any) {
      console.warn(`[sync:demand] ${name} skipped: ${err?.message || err}`);
    }
  }

  if (daysUsed === 0) throw new Error('No Salidas files could be downloaded');

  const stations: StationDemand[] = [];
  for (const [code, sum] of agg) {
    const ref = refs.get(code);
    if (!ref) continue; // non-troncal code (bike park / yard / temporary)
    stations.push({
      codigo: code,
      nodo: ref.nodo,
      nombre: ref.nombre,
      lat: ref.lat,
      lon: ref.lon,
      entradas: Math.round(sum.e / daysUsed),
      salidas: Math.round(sum.s / daysUsed),
      total: Math.round((sum.e + sum.s) / daysUsed),
      rank: 0, // assigned after the sort below
    });
  }
  // Never write an empty harvest (spec §1, §5.5.1): the file would carry a new
  // `window`, so the daily workflow would read it as fresh data and commit it,
  // and the Demanda layer would go blank in production with nothing failing.
  if (stations.length === 0) throw new Error('no Salidas station code matched a troncal station — refusing to write');
  stations.sort((a, b) => b.total - a.total);
  stations.forEach((s, i) => { s.rank = i + 1; });

  const payload = {
    generatedAt: new Date().toISOString(),
    source: 'validaciones.datosabiertos.transmilenio.gov.co/Salidas',
    days: daysUsed,
    window: usedDates.length ? { from: usedDates[usedDates.length - 1], to: usedDates[0] } : null,
    count: stations.length,
    stations,
  };
  await writeFile(OUT, JSON.stringify(payload), 'utf8');
  return stations.length;
}

// Run directly (not when imported). Sets `exitCode` instead of calling
// `process.exit()` — a hard exit races libuv handle teardown on Windows
// (assertion in async.c) while the undici pool is still closing.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  syncStationDemand()
    .then((n) => {
      console.log(`[sync:demand] Wrote ${n} stations with demand to ${OUT}`);
    })
    .catch((err) => {
      console.error('[sync:demand] Failed:', err?.message || err);
      process.exitCode = 1;
    });
}
