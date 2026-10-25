/**
 * Builds the zonal schedule file (`data/gtfs_zonal.json`) from TRANSMILENIO's
 * published GTFS (spec §5.5.10).
 *
 * Source: the static GTFS of the whole SITP, one zip every two weeks or so,
 * listed on TRANSMILENIO's ArcGIS portal under the tag `gtfs` and served from
 * Google Cloud Storage — no Colombian geofence. Licence CC BY 4.0 (TRANSMILENIO's
 * answer to petición B, 2026-ER-53567), so every surface that shows it credits it.
 *
 * The zip is ~120 MB and its `stop_times.txt` 576 MB / 9.5 M rows, far past the
 * 512 MB box (spec §5.1.3): it is read here, offline, and only the ~2 MB result
 * is committed — the demand/tullave pattern. The zip is streamed, one entry at
 * a time, never extracted.
 *
 * A bad harvest is never written: the run refuses when too few catalog códigos
 * matched, or when a time or a frequency falls outside what a bus can do.
 *
 *   npm run sync:gtfs                # newest build, downloaded to the OS temp dir
 *   npm run sync:gtfs -- --zip x.zip # a build already on disk
 */
import { createReadStream } from 'node:fs';
import { open, readFile, stat, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createWriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import zlib from 'node:zlib';
import {
  createGtfsZonalBuilder,
  gtfsMinutes,
  namedCodigos,
  type CatalogVariant,
  type GtfsRoute,
  type GtfsTrip,
  type SentidoHorario,
} from './services/gtfs_zonal.js';

const SEARCH_URL =
  'https://www.arcgis.com/sharing/rest/search?q=tags:gtfs%20AND%20orgid:9unqgkQ8KCOfnzoB&num=100&f=json&sortField=created&sortOrder=desc';
const BUILD_URL = /\/GTFS_(\d{8})\.zip$/;

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), 'data');
const OUT = join(DATA_DIR, 'gtfs_zonal.json');
const CATALOG = join(DATA_DIR, 'master_catalog.json');

/** GTFS agencies that are SITP zonal: Zonal-Urbano, -Complementario, -Especial. */
const ZONAL_AGENCIES = new Set(['3', '4', '5']);
/** Catalog services the file covers — the ones with no estación page or plano of their own. */
const isZonalCatalog = (v: { sistema?: string }) => v.sistema === 'TransMiZonal';

/** Below this share of the catalog's zonal códigos, the feed and the catalog no longer describe one network. */
const MIN_COVERAGE = 0.9;
/** The 2026-09-29 build runs 02:30–26:24; a time outside 02:00–27:59 is a misread feed. */
const EARLIEST = 2 * 60;
const LATEST = 28 * 60 - 1;

// ─── ZIP, streamed ──────────────────────────────────────

interface ZipEntry {
  method: number;
  compSize: number;
  localOffset: number;
}

async function readZipDirectory(file: string): Promise<Map<string, ZipEntry>> {
  const fd = await open(file, 'r');
  try {
    const { size } = await fd.stat();
    const tailLen = Math.min(size, 65_557);
    const tail = Buffer.alloc(tailLen);
    await fd.read(tail, 0, tailLen, size - tailLen);
    let eocd = -1;
    for (let i = tailLen - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === 0x06054b50) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) throw new Error('ZIP: end-of-central-directory not found');
    const cdSize = tail.readUInt32LE(eocd + 12);
    const cdOffset = tail.readUInt32LE(eocd + 16);
    const cd = Buffer.alloc(cdSize);
    await fd.read(cd, 0, cdSize, cdOffset);
    const entries = new Map<string, ZipEntry>();
    for (let p = 0; p + 46 <= cd.length && cd.readUInt32LE(p) === 0x02014b50; ) {
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      const compSize = cd.readUInt32LE(p + 20);
      // ZIP64 marks its sizes 0xFFFFFFFF; no GTFS build has needed it (the zip is ~120 MB).
      if (compSize === 0xffffffff) throw new Error('ZIP64 entries are not supported');
      entries.set(cd.toString('utf8', p + 46, p + 46 + nameLen), {
        method: cd.readUInt16LE(p + 10),
        compSize,
        localOffset: cd.readUInt32LE(p + 42),
      });
      p += 46 + nameLen + extraLen + commentLen;
    }
    return entries;
  } finally {
    await fd.close();
  }
}

async function entryStream(file: string, entries: Map<string, ZipEntry>, name: string): Promise<Readable> {
  const entry = entries.get(name);
  if (!entry) throw new Error(`GTFS: ${name} missing from the zip`);
  const fd = await open(file, 'r');
  const header = Buffer.alloc(30);
  await fd.read(header, 0, 30, entry.localOffset);
  await fd.close();
  if (header.readUInt32LE(0) !== 0x04034b50) throw new Error(`ZIP: bad local header for ${name}`);
  const start = entry.localOffset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
  const raw = createReadStream(file, { start, end: start + entry.compSize - 1 });
  return entry.method === 8 ? raw.pipe(zlib.createInflateRaw()) : raw;
}

async function* lines(stream: Readable): AsyncGenerator<string> {
  for await (const line of createInterface({ input: stream, crlfDelay: Infinity })) yield line;
}

/** One CSV line; quoted fields may hold commas (stop names do). */
function splitCsv(line: string): string[] {
  if (!line.includes('"')) return line.split(',');
  const out: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      out.push(field);
      field = '';
    } else field += c;
  }
  out.push(field);
  return out;
}

async function readTable(file: string, entries: Map<string, ZipEntry>, name: string): Promise<Array<Record<string, string>>> {
  const rows: Array<Record<string, string>> = [];
  let header: string[] | null = null;
  for await (const line of lines(await entryStream(file, entries, name))) {
    if (!line) continue;
    const cells = splitCsv(line);
    if (!header) header = cells.map((h) => h.replace(/^﻿/, '').trim());
    else rows.push(Object.fromEntries(header.map((h, i) => [h, cells[i] ?? ''])));
  }
  return rows;
}

// ─── The feed ───────────────────────────────────────────

async function newestBuild(): Promise<{ url: string; date: string }> {
  const res = await fetch(SEARCH_URL);
  if (!res.ok) throw new Error(`GTFS index HTTP ${res.status}`);
  const { results = [] } = (await res.json()) as { results?: Array<{ url?: string }> };
  const builds = results
    .map((r) => ({ url: String(r.url ?? ''), date: BUILD_URL.exec(String(r.url ?? ''))?.[1] ?? '' }))
    .filter((b) => b.date)
    .sort((a, b) => b.date.localeCompare(a.date));
  if (!builds.length) throw new Error('GTFS index lists no GTFS_YYYYMMDD.zip');
  return builds[0];
}

async function download(url: string, to: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`GTFS download HTTP ${res.status}`);
  await pipeline(Readable.fromWeb(res.body as any), createWriteStream(to));
}

function isoDate(yyyymmdd: string): string {
  return `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;
}

// ─── Gates ──────────────────────────────────────────────

/** Every reason the harvest must not be written; empty when it may. */
export function gateProblems(rutas: Record<string, SentidoHorario[]>, zonalCodigos: string[]): string[] {
  const problems: string[] = [];
  const covered = zonalCodigos.filter((c) => rutas[c]).length;
  if (covered < zonalCodigos.length * MIN_COVERAGE) {
    problems.push(`only ${covered} of ${zonalCodigos.length} catalog zonal códigos matched (need ${Math.round(MIN_COVERAGE * 100)}%)`);
  }
  for (const [codigo, sentidos] of Object.entries(rutas)) {
    for (const [dia, d] of sentidos.flatMap((s) => Object.entries(s.dias))) {
      if (!d) continue;
      const times = [d.primera, d.ultima, ...d.pasos.flatMap((p) => p ?? [])];
      if (times.some((t) => !(t >= EARLIEST && t <= LATEST))) problems.push(`${codigo} ${dia}: a time outside 02:00–27:59`);
      const gapOk = ([n, low, high]: [number, number | null, number | null]) =>
        n >= 1 && (low === null ? high === null : high !== null && low >= 1 && low <= high && high <= LATEST - EARLIEST);
      if (d.cada.some((c) => c && !gapOk(c))) problems.push(`${codigo} ${dia}: a frequency that is not a gap between buses`);
    }
  }
  return problems;
}

async function main(): Promise<void> {
  const zipArg = process.argv.indexOf('--zip');
  let file: string;
  let date: string;
  let source: string;
  if (zipArg > 0) {
    file = process.argv[zipArg + 1];
    date = BUILD_URL.exec('/' + file.replace(/\\/g, '/').split('/').pop())?.[1] ?? '';
    source = file;
  } else {
    const build = await newestBuild();
    ({ url: source, date } = build);
    file = join(tmpdir(), `GTFS_${date}.zip`);
    const have = await stat(file).catch(() => null);
    if (!have) {
      console.log(`[gtfs] downloading ${source}`);
      await download(source, file);
    }
  }
  console.log(`[gtfs] build ${date || '(undated)'} — ${file}`);

  const catalog = JSON.parse(await readFile(CATALOG, 'utf8')) as {
    routes: Record<string, Array<{ codigo: string; nombre?: string; sistema?: string; stops?: Array<{ codigo: string }> }>>;
  };
  const variants: CatalogVariant[] = Object.values(catalog.routes)
    .flat()
    .filter(isZonalCatalog)
    .map((v) => ({ codigo: v.codigo, nombre: v.nombre ?? '', stops: (v.stops ?? []).map((s) => s.codigo) }))
    .filter((v) => v.stops.length > 1);
  const zonalCodigos = [...new Set(variants.map((v) => v.codigo))];
  const zonalSet = new Set(zonalCodigos.map((c) => c.toUpperCase()));
  // The feed files some alimentadores (11-2, 11-10, C104, K337) as Zonal-Urbano.
  // The catalog says alimentador, and left in they lend short pieces of their
  // trips to the zonal código on the same street: A129 counted 11-2's and
  // 11-10's buses as its own and ran every 2–6 minutes.
  const otherService = new Set(
    Object.values(catalog.routes).flat().filter((v) => !isZonalCatalog(v)).map((v) => v.codigo.toUpperCase())
  );
  const isAlimentador = (r: Record<string, string>) => {
    const named = [...namedCodigos(r as unknown as GtfsRoute)];
    return named.some((c) => otherService.has(c)) && !named.some((c) => zonalSet.has(c));
  };

  const entries = await readZipDirectory(file);
  const routes = (await readTable(file, entries, 'routes.txt')).filter((r) => ZONAL_AGENCIES.has(r.agency_id) && !isAlimentador(r));
  const zonalRouteIds = new Set(routes.map((r) => r.route_id));
  const trips = (await readTable(file, entries, 'trips.txt')).filter((t) => zonalRouteIds.has(t.route_id)) as unknown as GtfsTrip[];
  const stopCodes = new Map<string, string>();
  for (const stop of await readTable(file, entries, 'stops.txt')) {
    // `080A01_TM` is the catalog's `080A01`: the cenefa code with the feed's suffix.
    const code = stop.stop_code.replace(/_TM$/i, '').trim();
    if (code) stopCodes.set(stop.stop_id, code);
  }
  console.log(`[gtfs] ${routes.length} zonal routes, ${trips.length} trips, ${stopCodes.size} coded stops`);

  const builder = createGtfsZonalBuilder(trips, (id) => stopCodes.get(id));
  let header: string[] | null = null;
  let col = { trip: 0, dep: 0, stop: 0, seq: 0 };
  let n = 0;
  for await (const line of lines(await entryStream(file, entries, 'stop_times.txt'))) {
    if (!header) {
      header = line.replace(/^﻿/, '').split(',');
      col = {
        trip: header.indexOf('trip_id'),
        dep: header.indexOf('departure_time'),
        stop: header.indexOf('stop_id'),
        seq: header.indexOf('stop_sequence'),
      };
      continue;
    }
    const c = line.split(',');
    builder.add(c[col.trip], c[col.stop], Number(c[col.seq]), gtfsMinutes(c[col.dep]));
    if (++n % 2_000_000 === 0) console.log(`[gtfs] stop_times ${n.toLocaleString()}…`);
  }

  const { rutas, report } = builder.build(routes as unknown as GtfsRoute[], variants);
  const missing = zonalCodigos.filter((c) => !rutas[c]).sort();
  const unmatched = Object.entries(report.unmatchedRoutes).sort((a, b) => b[1] - a[1]);
  console.log(
    `[gtfs] stop visits placed ${report.stopsPlaced}/${report.stops} (${((100 * report.stopsPlaced) / report.stops).toFixed(1)}%) ` +
      `over ${report.trips} trips / ${report.patterns} patterns, códigos ${Object.keys(rutas).length}/${zonalCodigos.length}`
  );
  console.log(`[gtfs] catalog códigos without a GTFS match (${missing.length}): ${missing.join(' ')}`);
  console.log(`[gtfs] GTFS routes with unplaced trips (${unmatched.length}): ${unmatched.slice(0, 40).map(([r, k]) => `${r}×${k}`).join(' ')}`);

  const problems = gateProblems(rutas, zonalCodigos);
  if (problems.length) {
    console.error(`[gtfs] NOT written — ${problems.length} problem(s):\n  ${problems.slice(0, 30).join('\n  ')}`);
    process.exit(1);
  }

  const out = {
    _meta: {
      what: 'Scheduled service of every SITP zonal código, per direction (destino, as the catalog names it) and day type: first and last departure, departures and the usual gap per period, and the first and last pass at each paradero. Times are minutes after midnight (past 1440 = after midnight).',
      // The same string from a download and from `--zip`, so a rerun on the same build changes nothing.
      source: date ? `https://storage.googleapis.com/gtfs-estaticos/GTFS_${date}.zip` : source,
      feed: date ? isoDate(date) : null,
      credit: `Horarios programados: GTFS de TRANSMILENIO S.A., CC BY 4.0${date ? `, versión ${isoDate(date)}` : ''}.`,
      dias: { LV: 'lunes a viernes', S: 'sábados', DF: 'domingos y festivos' },
      periodos: [[0, 360], [360, 540], [540, 960], [960, 1140], [1140, 1320], [1320, 1800]],
      matched: `${Object.keys(rutas).length} of ${zonalCodigos.length} catalog zonal códigos; ${report.stopsPlaced} of ${report.stops} zonal stop visits`,
      missing,
    },
    rutas,
  };
  await writeFile(OUT, JSON.stringify(out) + '\n');
  console.log(`[gtfs] wrote ${OUT}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error('[gtfs] Failed:', err);
    process.exit(1);
  });
}
