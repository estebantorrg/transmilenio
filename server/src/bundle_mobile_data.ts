/**
 * Bundles the committed catalog + static POI datasets into the mobile app as
 * offline assets (`client/mobile/src/generated/`).
 *
 * The Android app (`mobile/`) no longer talks to our web server at all — it hits
 * the official TransMi / government hosts directly via native HTTP (spec §5.2.1b)
 * and, for the two payloads with no single official endpoint (the master catalog
 * and the offline-aggregated POI/demand datasets), reads them from assets baked
 * into the APK. This script produces those assets from the same committed server
 * data the website serves, so the two clients never drift (spec §1.1 R2):
 *
 *   catalog.light.json           ← getCatalogLightGzip() (identical to /api/troncal/master-catalog)
 *   recarga_points.json          ← server/src/data/recarga_points.json          (spec §5.5.1 recharge POIs)
 *   personalizacion_points.json  ← server/src/data/personalizacion_points.json  (spec §5.5.1 personalization POIs)
 *   transmibici.json             ← server/src/data/transmibici.json             (spec §5.3 bike parking)
 *   station_demand.json          ← server/src/data/station_demand.json          (spec §5.8 Salidas demand)
 *   voice_index.json             ← catalog routes, geometry stripped            (spec §5.9 voice)
 *   voice_stops.json             ← stop → routes, for "¿qué me sirve aquí?"     (spec §5.9 voice)
 *   voice/<CODE>.json            ← per-route stops + trazado                    (spec §5.9 voice)
 *
 * Run `npm run bundle:mobile` (server) whenever the catalog/POI data is refreshed
 * — the whole output directory is gitignored and regenerated on every APK build
 * (`mobile` build:web), the same "sync offline, regenerate, redeploy" flow the
 * catalog itself uses (spec §4.3).
 */

import zlib from 'node:zlib';
import { copyFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { loadCatalogFromDisk, getCatalogLightGzip, type CatalogRouteDetail } from './services/tm_api.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, 'data');
const OUT_DIR = path.resolve(__dirname, '..', '..', 'client', 'mobile', 'src', 'generated');
// Shards are NOT put in a Vite `public/` dir: the mobile client's publicDir is
// pointed at the *website's* `client/public` (vite.config.ts), so anything left
// there would also ship in the website bundle. They are emitted here and copied
// to `mobile/www/voice/` after the build instead (mobile/scripts/build-web.mjs),
// which keeps them APK-only and inside the one already-gitignored directory.
const VOICE_GEO_DIR = path.join(OUT_DIR, 'voice');

// The static datasets are copied verbatim — the mobile app wraps each in the
// same `{ success, ... }` envelope its API endpoints return.
const STATIC_DATASETS = [
  'recarga_points.json',
  'personalizacion_points.json',
  'transmibici.json',
  'station_demand.json',
];

// ─── Voice assets (spec §5.9) ─────────────────────────────
// The voice answer must be spoken ~1.5 s after the rider stops talking, and the
// full light catalog is 13.6 MB — too slow to parse on a cold launch. So the
// catalog is split in two at bundle time:
//
//   voice_index.json   ~367 KB, always loaded: everything needed to RESOLVE an
//                      utterance to a route code and to answer "does it even run
//                      right now" (names, endpoints, horarios) — no geometry.
//   voice/<CODE>.json  ~4 KB each, fetched only for the ONE route that matched:
//                      stops + trazado, i.e. the geometry the ETA projection
//                      needs (client/src/services/routeEta.ts).
//
// Route codes are all `[A-Za-z0-9_-]+` in the catalog, so a code is used verbatim
// as the shard filename; `assertShardName` keeps that assumption honest rather
// than letting a future code silently write outside the directory.

/** Coordinates rounded to ~1.1 m. Halves the shard bytes; far below the 160 m
 *  on-route tolerance and the trace's own simplification error. */
function round5(value: number): number {
  return Math.round(value * 1e5) / 1e5;
}

/** "lat,lng" → [lng, lat] (the order every trace and projection uses). */
function parseCoordenada(coordenada: string | undefined): [number, number] | null {
  if (!coordenada || !coordenada.includes(',')) return null;
  const [latText, lngText] = coordenada.split(',');
  const lat = Number(latText);
  const lng = Number(lngText);
  return Number.isFinite(lat) && Number.isFinite(lng) ? [round5(lng), round5(lat)] : null;
}

/** Round a LineString/MultiLineString in place-preserving nesting — `traceToPaths`
 *  on the client distinguishes the two by shape, so it must survive the trip. */
function roundTrace(trace: CatalogRouteDetail['trazado']): CatalogRouteDetail['trazado'] | undefined {
  if (!Array.isArray(trace) || trace.length === 0) return undefined;
  const isFlat = Array.isArray(trace[0]) && typeof (trace[0] as unknown[])[0] === 'number';
  if (isFlat) {
    return (trace as number[][]).map(([lng, lat]) => [round5(lng), round5(lat)]);
  }
  return (trace as number[][][]).map((path) => path.map(([lng, lat]) => [round5(lng), round5(lat)]));
}

/** Mirrors `routeIsZonal` in services/stop_arrivals.ts — the two must agree, or
 *  the app and the website would apply different cruising speeds to the same
 *  route (spec §1.1 R2). */
function voiceRouteType(variant: CatalogRouteDetail): 't' | 'z' {
  const service = `${variant.sistema || ''} ${variant.tipoServicio || ''}`.toUpperCase();
  const zonal = service.includes('ZONAL') || service.includes('TRANSMIZONAL') || service.includes('ALIMENTADOR');
  return zonal ? 'z' : 't';
}

/** Destination-first live-query names (spec §5.2.4). Baked in because the voice
 *  path never builds the full route list — that would mean parsing the 13.6 MB
 *  catalog it is designed to avoid. Same order as `getLiveNameCandidates`. */
function liveNameCandidates(variant: CatalogRouteDetail): string[] {
  const out: string[] = [];
  const push = (value: unknown) => {
    const text = String(value || '').trim();
    if (text && !out.some((c) => c.toLowerCase() === text.toLowerCase())) out.push(text);
  };
  const stops = variant.stops || [];
  push(variant.destination);
  push(variant.nombre);
  push(variant.origin);
  if (stops.length) push(stops[stops.length - 1].nombre);
  if (stops.length) push(stops[0].nombre);
  return out;
}

function assertShardName(code: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(code)) {
    throw new Error(`Route code "${code}" is not filename-safe — voice shard naming needs a mapping table.`);
  }
  return code;
}

/**
 * Split the loaded catalog into the voice index + per-route geometry shards.
 * Routes with no usable trace still get an index entry: "el F19 no presta
 * servicio los domingos" is answerable without a single coordinate, and dropping
 * the route would turn that into "no conozco esa ruta" (spec §1 certainty).
 */
async function writeVoiceAssets(routes: Record<string, CatalogRouteDetail[]>): Promise<void> {
  await rm(VOICE_GEO_DIR, { recursive: true, force: true });
  await mkdir(VOICE_GEO_DIR, { recursive: true });

  const index: Record<string, unknown> = {};
  // The inverse index: which routes serve each stop. Built from the same pass, so
  // it cannot disagree with the shards (spec §1.1 R2).
  const stops = new Map<string, { nombre: string; lng: number; lat: number; routes: Set<string> }>();
  let shards = 0;
  let shardBytes = 0;

  for (const [code, variants] of Object.entries(routes)) {
    if (!Array.isArray(variants) || variants.length === 0) continue;

    const indexDirs: Record<string, unknown> = {};
    const geoDirs: Record<string, unknown> = {};

    variants.forEach((variant, position) => {
      const dir = String(position);
      indexDirs[dir] = {
        origin: variant.origin || '',
        destination: variant.destination || variant.nombre || '',
        horarios: variant.horarios,
        live: liveNameCandidates(variant),
      };

      const dirStops = (variant.stops || [])
        .map((stop) => {
          const coord = parseCoordenada(stop.coordenada);
          if (!coord) return null;
          const key = String(stop.codigo || '').trim();
          if (key) {
            const entry = stops.get(key) ?? {
              nombre: String(stop.nombre || key),
              lng: round5(coord[0]),
              lat: round5(coord[1]),
              routes: new Set<string>(),
            };
            entry.routes.add(code);
            stops.set(key, entry);
          }
          return [stop.codigo, stop.nombre, coord[0], coord[1], stop.posicion];
        })
        .filter((stop): stop is (string | number)[] => stop !== null);
      const trazado = roundTrace(variant.trazado);
      if (dirStops.length > 0 && trazado) {
        geoDirs[dir] = { stops: dirStops, trazado };
      }
    });

    const first = variants[0];
    index[code] = {
      nombre: first.nombre || code,
      tipo: voiceRouteType(first),
      color: first.color || '',
      dirs: indexDirs,
    };

    if (Object.keys(geoDirs).length === 0) continue;
    const body = JSON.stringify({ codigo: code, dirs: geoDirs });
    await writeFile(path.join(VOICE_GEO_DIR, `${assertShardName(code)}.json`), body);
    shards++;
    shardBytes += body.length;
  }

  // Stop → routes, sorted by code so the file is stable across rebuilds (a
  // gitignored artifact still gets diffed by hand when something looks wrong).
  // Compact tuples, not objects: the field names would be ~40% of the payload.
  const stopRows = Array.from(stops.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([code, entry]) => [
      code,
      entry.nombre,
      entry.lng,
      entry.lat,
      Array.from(entry.routes).sort().join(','),
    ]);
  const stopsJson = JSON.stringify({ stops: stopRows });
  await writeFile(path.join(OUT_DIR, 'voice_stops.json'), stopsJson);
  console.log(
    `[bundle] voice_stops.json — ${stopRows.length} stops, ${(stopsJson.length / 1024).toFixed(0)} KB`
  );

  const indexJson = JSON.stringify({ routes: index });
  await writeFile(path.join(OUT_DIR, 'voice_index.json'), indexJson);
  console.log(
    `[bundle] voice_index.json — ${Object.keys(index).length} routes, ${(indexJson.length / 1024).toFixed(0)} KB`
  );
  console.log(
    `[bundle] voice/*.json — ${shards} shards, ${(shardBytes / 1048576).toFixed(1)} MB ` +
      `(avg ${(shardBytes / Math.max(1, shards) / 1024).toFixed(1)} KB)`
  );
}

async function main(): Promise<void> {
  await mkdir(OUT_DIR, { recursive: true });

  // Catalog: reuse the exact light-catalog build the API serves, then unzip it
  // back to the JSON body the app expects (MasterCatalogResponse). This keeps the
  // trace simplification / field pruning identical to production (spec §5.1.4).
  await loadCatalogFromDisk();
  const { gzip, count } = await getCatalogLightGzip();
  if (count === 0) {
    throw new Error('Master catalog is empty — run `npm run sync` (server) and pull Git LFS first.');
  }
  const catalogJson = zlib.gunzipSync(gzip).toString('utf-8');
  await writeFile(path.join(OUT_DIR, 'catalog.light.json'), catalogJson);
  console.log(`[bundle] catalog.light.json — ${count} stations, ${(catalogJson.length / 1048576).toFixed(1)} MB`);

  // Voice assets are derived from the LIGHT catalog, not the raw one: the app
  // ships the simplified traces, so the ETA it computes must be projected onto
  // exactly the geometry it has.
  const lightCatalog = JSON.parse(catalogJson) as { data?: { routes?: Record<string, CatalogRouteDetail[]> } };
  await writeVoiceAssets(lightCatalog.data?.routes || {});

  for (const name of STATIC_DATASETS) {
    await copyFile(path.join(DATA_DIR, name), path.join(OUT_DIR, name));
    console.log(`[bundle] ${name}`);
  }

  console.log(`[bundle] Done → ${OUT_DIR}`);
}

main().catch((error) => {
  console.error('[bundle] Failed:', error);
  process.exitCode = 1;
});
