/**
 * Writes the `troncal` section of `data/planner_calibration.json` (spec §5.6.5)
 * from TRANSMILENIO's published schedule: per stretch between consecutive
 * served stops, a base speed, and one hourly multiplier per day type — see
 * `services/troncal_speeds.ts` for why the schedule and not a constant.
 *
 * Source: the daily `GTFS.zip` at gtfs.transmilenio.gov.co (~190 MB, streamed,
 * never extracted), troncal (agency 1) and dual (agency 6) trips. The zonal part
 * of the file comes from `scripts/calibration/build.mjs`, which keeps this
 * section when it rewrites the file; this script touches nothing else.
 *
 *   npm run sync:troncal-speeds                # downloads GTFS.zip to the OS temp dir
 *   npm run sync:troncal-speeds -- --zip x.zip # a build already on disk
 */
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { download, entryStream, lines, readTable, readZipDirectory } from './sync_gtfs.js';
import {
  createTroncalSpeedBuilder,
  dayTypesOf,
  stopCodeResolver,
  type DayType,
  type RegistryStation,
  type ScheduledCall,
} from './services/troncal_speeds.js';
import { isZonalService } from './services/route_type.js';

const SOURCE = 'https://gtfs.transmilenio.gov.co/GTFS.zip';
const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), 'data');
const OUT = join(DATA_DIR, 'planner_calibration.json');
/** Troncal and Dual; TransMiCable (7) runs by frequency, with no stop times to read. */
const TRONCAL_AGENCIES = new Set(['1', '6']);
/** Below this share of the catalog's troncal stretches, the feed and the catalog no longer describe one network. */
const MIN_COVERAGE = 0.6;

const seconds = (clock: string): number => {
  const [h, m, s] = clock.split(':').map(Number);
  return h * 3600 + m * 60 + (s || 0);
};

async function main(): Promise<void> {
  const given = process.argv.indexOf('--zip');
  const file = given > 0 ? process.argv[given + 1] : join(tmpdir(), 'GTFS_tmsa_daily.zip');
  if (given < 0) {
    console.log(`[troncal] downloading ${SOURCE}`);
    await download(SOURCE, file);
  }

  const registry = (JSON.parse(await readFile(join(DATA_DIR, 'troncal_stations.json'), 'utf8')) as { stations: Record<string, RegistryStation> }).stations;
  const catalog = JSON.parse(await readFile(join(DATA_DIR, 'master_catalog.json'), 'utf8')) as {
    routes: Record<string, Array<{ sistema?: string; tipoServicio?: string; stops?: Array<{ codigo: string; posicion?: number }> }>>;
  };

  const entries = await readZipDirectory(file);
  const feed = (await readTable(file, entries, 'feed_info.txt'))[0] ?? {};
  const routeIds = new Set((await readTable(file, entries, 'routes.txt')).filter((r) => TRONCAL_AGENCIES.has(r.agency_id)).map((r) => r.route_id));
  const services = new Map((await readTable(file, entries, 'calendar.txt')).map((c) => [c.service_id, dayTypesOf(c)]));
  const tripDays = new Map<string, DayType[]>();
  for (const t of await readTable(file, entries, 'trips.txt')) {
    if (routeIds.has(t.route_id)) tripDays.set(t.trip_id, services.get(t.service_id) ?? []);
  }
  const stops = await readTable(file, entries, 'stops.txt');
  const catalogCodes = new Set(Object.values(catalog.routes).flat().flatMap((v) => (v.stops ?? []).map((s) => s.codigo)));
  const codeOf = stopCodeResolver(stops, registry, catalogCodes);
  const where = new Map(stops.map((s) => [s.stop_id, [Number(s.stop_lat), Number(s.stop_lon)] as const]));
  console.log(`[troncal] ${routeIds.size} troncal/dual routes, ${tripDays.size} trips, ${codeOf.size} stops with a catalog código`);

  // stop_times is not grouped by trip: hold the troncal trips' calls, then build.
  const calls = new Map<string, ScheduledCall[]>();
  let header: string[] | null = null;
  let col = { trip: 0, dep: 0, stop: 0, seq: 0, dist: -1 };
  let n = 0;
  for await (const line of lines(await entryStream(file, entries, 'stop_times.txt'))) {
    if (!header) {
      header = line.replace(/^﻿/, '').split(',');
      col = {
        trip: header.indexOf('trip_id'),
        dep: header.indexOf('departure_time'),
        stop: header.indexOf('stop_id'),
        seq: header.indexOf('stop_sequence'),
        dist: header.indexOf('shape_dist_traveled'),
      };
      continue;
    }
    if (++n % 2_000_000 === 0) console.log(`[troncal] stop_times ${n.toLocaleString()}…`);
    const c = line.split(',');
    if (!tripDays.has(c[col.trip])) continue;
    const stopId = c[col.stop];
    const [lat, lon] = where.get(stopId) ?? [NaN, NaN];
    const list = calls.get(c[col.trip]) ?? calls.set(c[col.trip], []).get(c[col.trip])!;
    list.push({
      seq: Number(c[col.seq]),
      code: codeOf.get(stopId) ?? '',
      seconds: seconds(c[col.dep]),
      dist: col.dist >= 0 && c[col.dist] !== '' ? Number(c[col.dist]) : NaN,
      lat,
      lon,
    });
  }

  const builder = createTroncalSpeedBuilder();
  for (const [trip, list] of calls) builder.addTrip(list, tripDays.get(trip)!);
  const { pairs, factor } = builder.build();

  // How much of what the planner rides is now on the schedule.
  let edges = 0;
  let measured = 0;
  for (const variant of Object.values(catalog.routes).flat()) {
    if (isZonalService(variant.sistema, variant.tipoServicio)) continue;
    const ordered = [...(variant.stops ?? [])].sort((a, b) => (a.posicion ?? 0) - (b.posicion ?? 0));
    for (let i = 0; i + 1 < ordered.length; i++) {
      edges++;
      if (pairs[ordered[i].codigo]?.[ordered[i + 1].codigo] !== undefined) measured++;
    }
  }
  const pairCount = Object.values(pairs).reduce((sum, to) => sum + Object.keys(to).length, 0);
  const coverage = measured / Math.max(1, edges);
  console.log(`[troncal] ${pairCount} stretches · catalog troncal edges on the schedule: ${measured}/${edges} (${(100 * coverage).toFixed(1)} %)`);
  console.log('[troncal] factor H:', factor.H.join(' '));
  if (coverage < MIN_COVERAGE) throw new Error(`refusing: only ${(100 * coverage).toFixed(1)} % of catalog troncal edges matched`);

  const calibration = JSON.parse(await readFile(OUT, 'utf8'));
  calibration.troncal = {
    source: `GTFS de TRANSMILENIO S.A. (${SOURCE}), versión ${feed.feed_version ?? '?'}, vigencia ${feed.feed_start_date ?? '?'}–${feed.feed_end_date ?? '?'}: tiempos programados entre paradas de las rutas troncales y duales.`,
    pairs,
    factor,
  };
  await writeFile(OUT, JSON.stringify(calibration) + '\n');
  console.log(`[troncal] wrote ${OUT}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error('[troncal] Failed:', err);
    process.exit(1);
  });
}
