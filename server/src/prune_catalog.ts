/**
 * One-shot catalog repair.
 *
 * Prunes phantom station-wagon mappings from server/src/data/master_catalog.json
 * — mappings for routes upstream has rerouted away from a station, which the
 * merge step used to retain forever (see `pruneUnservedStationRoutes`). Writes
 * atomically. Run with: `npm run prune`. Future syncs prune automatically.
 */
import { pruneCatalogFileInPlace } from './services/tm_api.js';

async function main(): Promise<void> {
  const pruned = await pruneCatalogFileInPlace();
  console.log(`[prune] Done. Removed ${pruned} stale station-wagon mappings.`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[prune] Failed:', err);
    process.exit(1);
  });
