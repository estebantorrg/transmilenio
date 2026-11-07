/**
 * Builds `data/gtfs_rt_index.json`, what the GTFS-Realtime tier (spec §5.2.8,
 * `services/gtfs_rt.ts`) needs from the static feed to read a vehicle: each GTFS
 * route's short name, long name and agency, and each stop's code.
 *
 * Source: the `GTFS.zip` TRANSMILENIO rebuilds daily beside the realtime files
 * (`gtfs.transmilenio.gov.co`) — the build whose ids the realtime feed carries:
 * on 2026-11-06 every vehicle's route and stop id was in it. ~190 MB, streamed
 * one entry at a time with the zonal sync's reader; only ~0.2 MB is committed.
 * Re-run when the network changes (new routes read as "no buses" from this tier
 * and fall through to the others until then).
 *
 *   npm run sync:gtfs-rt                # downloads GTFS.zip to the OS temp dir
 *   npm run sync:gtfs-rt -- --zip x.zip # a build already on disk
 */
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { download, readTable, readZipDirectory } from './sync_gtfs.js';

const SOURCE = 'https://gtfs.transmilenio.gov.co/GTFS.zip';
const OUT = join(dirname(fileURLToPath(import.meta.url)), 'data', 'gtfs_rt_index.json');
/** The 2026-11-06 build has 1,076 routes and 8,161 coded stops; far fewer is a broken build. */
const MIN_ROUTES = 500;
const MIN_STOPS = 4000;

async function main(): Promise<void> {
  const given = process.argv.indexOf('--zip');
  const file = given > 0 ? process.argv[given + 1] : join(tmpdir(), 'GTFS_tmsa_daily.zip');
  if (given < 0) {
    console.log(`[gtfs-rt] downloading ${SOURCE}`);
    await download(SOURCE, file);
  }
  const entries = await readZipDirectory(file);
  const feed = (await readTable(file, entries, 'feed_info.txt'))[0] ?? {};

  const routes: Record<string, [string, string, string]> = {};
  for (const r of await readTable(file, entries, 'routes.txt')) {
    routes[r.route_id] = [r.route_short_name.trim(), r.route_long_name.replace(/\s+/g, ' ').trim(), r.agency_id.trim()];
  }
  const stops: Record<string, string> = {};
  for (const s of await readTable(file, entries, 'stops.txt')) {
    // Zonal stops carry the paradero's cenefa as the catalog writes it, plus a `_TM` suffix.
    const code = s.stop_code.trim().replace(/_TM$/, '');
    if (code) stops[s.stop_id] = code;
  }

  const routeCount = Object.keys(routes).length;
  const stopCount = Object.keys(stops).length;
  if (routeCount < MIN_ROUTES || stopCount < MIN_STOPS) {
    throw new Error(`refusing a thin build: ${routeCount} routes, ${stopCount} coded stops`);
  }
  const out = {
    _meta: {
      what: 'GTFS route id → [short name, long name, agency id]; stop id → stop code (the zonal cenefa), for reading the GTFS-Realtime feed.',
      source: SOURCE,
      feed: { version: feed.feed_version ?? null, start: feed.feed_start_date ?? null, end: feed.feed_end_date ?? null },
      credit: 'Datos en vivo: GTFS-Realtime de TRANSMILENIO S.A.',
    },
    routes,
    stops,
  };
  await writeFile(OUT, JSON.stringify(out) + '\n');
  console.log(`[gtfs-rt] wrote ${OUT}: ${routeCount} routes, ${stopCount} stops`);
}

main().catch((err) => {
  console.error('[gtfs-rt] Failed:', err);
  process.exit(1);
});
