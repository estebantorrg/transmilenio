/**
 * Standalone master-catalog re-fetch.
 *
 * Regenerates server/src/data/master_catalog.json from the live TransMi API,
 * picking up newly added and modified routes. Run with: `npm run sync`.
 *
 * The sync writes atomically (temp file + rename), so a failed/partial run
 * leaves the existing catalog untouched.
 */
import { loadCatalogFromDisk, syncMasterCatalog } from './services/tm_api.js';

async function main(): Promise<void> {
  await loadCatalogFromDisk();
  await syncMasterCatalog();
  console.log('[sync] Done.');
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[sync] Failed:', err);
    process.exit(1);
  });
