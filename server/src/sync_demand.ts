/**
 * Builds the station-demand catalog (`data/station_demand.json`) from TRANSMILENIO's
 * open "Salidas" dataset — daily per-station entry/exit (validation) counts.
 *
 * Source: public Google Cloud Storage bucket `gs://validaciones_tmsa` (spec §5.8,
 * "Validaciones/Salidas"). Each `Salidas/salidasYYYYMMDD.zip` holds one CSV of
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
 * Run from anywhere (the bucket is public, no Colombian egress needed):
 *   npm run sync:demand
 */
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import zlib from 'node:zlib';

const BUCKET = 'https://storage.googleapis.com/validaciones_tmsa';
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

/** Extracts the single CSV entry from a PKZIP buffer (handles the data-descriptor
 *  form these files use — the local header sizes are zero, so read the central
 *  directory). No external dependency. */
function unzipSingleEntry(buf: Buffer): Buffer {
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('ZIP: end-of-central-directory not found');
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (buf.readUInt32LE(cdOffset) !== 0x02014b50) throw new Error('ZIP: central directory header not found');
  const method = buf.readUInt16LE(cdOffset + 10);
  const compSize = buf.readUInt32LE(cdOffset + 20);
  const localOff = buf.readUInt32LE(cdOffset + 42);
  if (buf.readUInt32LE(localOff) !== 0x04034b50) throw new Error('ZIP: local file header not found');
  const nameLen = buf.readUInt16LE(localOff + 26);
  const extraLen = buf.readUInt16LE(localOff + 28);
  const dataStart = localOff + 30 + nameLen + extraLen;
  const comp = buf.subarray(dataStart, dataStart + compSize);
  return method === 8 ? zlib.inflateRawSync(comp) : Buffer.from(comp);
}

/** Aggregates one day's CSV into `agg` (code → summed entradas/salidas).
 *  The `Estacion` code is the only 5-digit `(NNNNN)` token per row (Línea and
 *  Acceso codes are 2-digit); `Entradas_E`/`Salidas_S` are the last two integer
 *  columns — robust even for the ~0.5% of rows with commas inside access names. */
function aggregateDay(csv: string, agg: Map<string, { e: number; s: number }>): void {
  const lines = csv.split(/\r?\n/);
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const codeMatch = line.match(/\((\d{5})\)/);
    if (!codeMatch) continue;
    const cols = line.split(',');
    const entradas = Number(cols[cols.length - 2]);
    const salidas = Number(cols[cols.length - 1]);
    if (!Number.isFinite(entradas) || !Number.isFinite(salidas)) continue;
    const prev = agg.get(codeMatch[1]) || { e: 0, s: 0 };
    prev.e += entradas;
    prev.s += salidas;
    agg.set(codeMatch[1], prev);
  }
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
    const dow = cursor.getUTCDay();
    if (dow === 0 || dow === 6) continue; // weekdays only
    const name = fileNameForDate(cursor);
    try {
      const res = await fetch(`${BUCKET}/Salidas/${name}`);
      if (!res.ok) continue; // missing day (holiday/not yet published) — skip
      const buf = Buffer.from(await res.arrayBuffer());
      const csv = unzipSingleEntry(buf).toString('utf8');
      aggregateDay(csv, agg);
      daysUsed++;
      usedDates.push(name.slice(7, 15));
      console.log(`[sync:demand] ${name} ok (${daysUsed}/${TARGET_DAYS})`);
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
  stations.sort((a, b) => b.total - a.total);
  stations.forEach((s, i) => { s.rank = i + 1; });

  const payload = {
    generatedAt: new Date().toISOString(),
    source: 'validaciones_tmsa/Salidas',
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
