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
 * The host serves Colombia only: 403 to any other country (the daily GitHub
 * runner included, measured 2026-10-18), 404 for a day it has not published. So
 * a run abroad downloads through a free public proxy that exits in Colombia,
 * checked against this host before it is used (`colombianProxy`). Day files
 * never change once published, so with `SALIDAS_CACHE_DIR` set (the workflow
 * keeps it between runs) a day is downloaded once, not fifteen times.
 *
 *   npm run sync:demand
 */
import https from 'node:https';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { aggregateDay, firstWorking, isOrdinaryWeekday, unzipSingleEntry } from './services/salidas.js';
import { ProxyManager, SimpleProxyAgent } from './services/proxy_manager.js';
import { collectBody } from './services/upstream_body.js';

const SALIDAS_HOST = 'validaciones.datosabiertos.transmilenio.gov.co';
const CACHE_DIR = process.env.SALIDAS_CACHE_DIR || '';
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

/** One request to the Salidas host, through `agent` when there is one. */
function salidas(path: string, method: 'GET' | 'HEAD', agent?: https.Agent, timeoutMs = 30_000): Promise<{ status: number; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = https.request({ host: SALIDAS_HOST, path, method, agent, timeout: timeoutMs }, (res) => {
      collectBody(res, `Salidas ${path}`).then((body) => resolve({ status: res.statusCode ?? 0, body }), reject);
    });
    req.on('timeout', () => req.destroy(new Error(`${path} timed out`)));
    req.on('error', reject);
    req.end();
  });
}

let candidates: Array<{ ip: string; port: number }> | null = null;
const tried = new Set<string>();

/**
 * A free public proxy that the Salidas host answers as Colombian: its home page
 * is 200 from Colombia and 403 from anywhere else, so that is the whole test.
 * The pool lists are the live tier's (`ProxyManager.fetchCandidates`), but none
 * of them is probed against the live host here.
 */
async function colombianProxy(): Promise<https.Agent | undefined> {
  candidates ??= await ProxyManager.fetchCandidates();
  const fresh = candidates.filter((p) => !tried.has(`${p.ip}:${p.port}`));
  const found = await firstWorking(fresh, async (p) => {
    tried.add(`${p.ip}:${p.port}`);
    return (await salidas('/', 'HEAD', new SimpleProxyAgent(p.ip, p.port), 9_000)).status === 200;
  });
  if (found) console.log(`[sync:demand] downloading through Colombian proxy ${found.ip}:${found.port}`);
  return found ? new SimpleProxyAgent(found.ip, found.port) : undefined;
}

let proxy: https.Agent | undefined;

// A proxy that passed the probe still dies on the download about half the time
// (three in a row on 2026-10-18), so a file gets this many before it is skipped.
const DOWNLOAD_ATTEMPTS = 8;

/** One day's zip, or null when the host has not published that day. */
async function downloadDay(name: string): Promise<Buffer | null> {
  for (let attempt = 0; attempt < DOWNLOAD_ATTEMPTS; attempt++) {
    const res = await salidas(`/Salidas/${name}`, 'GET', proxy).catch((err) => {
      if (!proxy) throw err;
      console.warn(`[sync:demand] ${name}: proxy failed (${err?.message || err}), trying another`);
      return null;
    });
    if (res?.status === 200) return res.body;
    if (res?.status === 404) return null;
    if (res && res.status !== 403) throw new Error(`HTTP ${res.status}`);
    // 403: this egress is not Colombian; null: the proxy died. Either way, a new one.
    if (res) console.warn(`[sync:demand] ${name}: HTTP 403 ${proxy ? 'through the proxy' : 'from here (geofence)'} — finding a Colombian proxy`);
    proxy = await colombianProxy();
    if (!proxy) throw new Error('no free Colombian proxy answered');
  }
  throw new Error(`gave up after ${DOWNLOAD_ATTEMPTS} attempts`);
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
      const cached = CACHE_DIR ? await readFile(join(CACHE_DIR, name)).catch(() => null) : null;
      const buf = cached ?? await downloadDay(name);
      if (!buf) {
        console.warn(`[sync:demand] ${name} not published (404) — skipped`);
        continue;
      }
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
      // Kept only once it parsed, so a broken download is never served from the cache.
      if (CACHE_DIR && !cached) {
        await mkdir(CACHE_DIR, { recursive: true });
        await writeFile(join(CACHE_DIR, name), buf);
      }
      console.log(`[sync:demand] ${name} ok, ${rows} rows (${daysUsed}/${TARGET_DAYS})${cached ? ' (cached)' : ''}`);
    } catch (err: any) {
      console.warn(`[sync:demand] ${name} skipped: ${err?.message || err}`);
    }
  }
  // Days that fell out of the window are never read again (a run that read
  // nothing proves nothing about the window, so it leaves the cache alone).
  if (CACHE_DIR && usedDates.length > 0) {
    for (const file of await readdir(CACHE_DIR).catch(() => [] as string[])) {
      if (!usedDates.includes(file.slice(7, 15))) await rm(join(CACHE_DIR, file), { force: true });
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
