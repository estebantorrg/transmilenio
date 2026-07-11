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
 *   catalog.light.json   ← getCatalogLightGzip() (identical to /api/troncal/master-catalog)
 *   recarga_points.json  ← server/src/data/recarga_points.json  (spec §5.5.1 recharge POIs)
 *   transmibici.json     ← server/src/data/transmibici.json     (spec §5.3 bike parking)
 *   station_demand.json  ← server/src/data/station_demand.json  (spec §5.8 Salidas demand)
 *
 * Run `npm run bundle:mobile` (server) whenever the catalog/POI data is refreshed,
 * then commit the regenerated assets — the same "sync offline, commit, redeploy"
 * flow the catalog itself uses (spec §4.3).
 */

import zlib from 'node:zlib';
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { loadCatalogFromDisk, getCatalogLightGzip } from './services/tm_api.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, 'data');
const OUT_DIR = path.resolve(__dirname, '..', '..', 'client', 'mobile', 'src', 'generated');

// The three static datasets are copied verbatim — the mobile app wraps each in
// the same `{ success, ... }` envelope its API endpoints return.
const STATIC_DATASETS = ['recarga_points.json', 'transmibici.json', 'station_demand.json'];

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
