import { Router, Request, Response } from 'express';
import { createReadStream } from 'fs';
import { queries } from '../services/arcgis.js';
import * as tmApi from '../services/tm_api.js';

const router = Router();

/**
 * Simple in-memory cache with TTL.
 * Route/station data rarely changes — cache for 10 minutes.
 */
const cache = new Map<string, { data: any; timestamp: number }>();
const CACHE_TTL = 10 * 60 * 1000; // 10 minutes

async function getCachedOrFetch(key: string, fetcher: () => Promise<any>): Promise<any> {
  const cached = cache.get(key);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    console.log(`[Cache] HIT: ${key}`);
    return cached.data;
  }

  console.log(`[Cache] MISS: ${key} — fetching from ArcGIS...`);
  const data = await fetcher();
  cache.set(key, { data, timestamp: Date.now() });
  return data;
}

// ─── Troncal Endpoints ────────────────────────────────────

router.get('/troncal/routes', async (_req: Request, res: Response) => {
  try {
    const features = await getCachedOrFetch('troncal-routes', queries.troncalRoutes);
    res.json({ success: true, count: features.length, features });
  } catch (error) {
    console.error('Error fetching troncal routes:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch troncal routes' });
  }
});

router.get('/troncal/stations', async (_req: Request, res: Response) => {
  try {
    const features = await getCachedOrFetch('troncal-stations', queries.troncalStations);
    res.json({ success: true, count: features.length, features });
  } catch (error) {
    console.error('Error fetching troncal stations:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch troncal stations' });
  }
});

router.get('/troncal/corridors', async (_req: Request, res: Response) => {
  try {
    const features = await getCachedOrFetch('troncal-corridors', queries.troncalCorridors);
    res.json({ success: true, count: features.length, features });
  } catch (error) {
    console.error('Error fetching troncal corridors:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch troncal corridors' });
  }
});

// ─── Master Catalog (from TransMi App API) ────────────────

router.get('/troncal/master-catalog', async (_req: Request, res: Response) => {
  try {
    const catalog = tmApi.getCatalogLight();
    const count = Object.keys(catalog.stations || {}).length;
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.json({
      success: true,
      data: catalog,
      count,
      stale: tmApi.isCatalogStale()
    });
  } catch (error) {
    console.error('Error fetching master catalog:', error);
    res.status(500).json({ success: false, error: 'Failed to load master catalog' });
  }
});

router.get('/troncal/route/:code', async (req: Request, res: Response) => {
  try {
    const { code } = req.params;
    const catalog = tmApi.getCatalog();
    const routeVariants = catalog.routes[code];
    if (routeVariants && routeVariants.length > 0) {
      res.setHeader('Cache-Control', 'public, max-age=600');
      res.json({ success: true, data: routeVariants });
    } else {
      res.status(404).json({ success: false, error: `Route ${code} not found in catalog` });
    }
  } catch (error) {
    console.error(`Error fetching route detail for ${req.params.code}:`, error);
    res.status(500).json({ success: false, error: 'Failed to load route detail' });
  }
});

router.get('/troncal/station/:code', async (req: Request, res: Response) => {
  const { code } = req.params;
  const station = tmApi.getStationByCode(code);
  if (station) {
    res.json({ success: true, data: station });
  } else {
    res.status(404).json({ success: false, error: 'Station not found in catalog' });
  }
});

// Sync trigger
router.post('/troncal/sync', async (_req: Request, res: Response) => {
  if (tmApi.isSyncInProgress()) {
    res.json({ success: true, message: 'Sync already in progress' });
    return;
  }
  // Run in background
  tmApi.syncMasterCatalog().catch((err) => console.error('[Sync Error]', err));
  res.json({ success: true, message: 'Sync started in background' });
});

// ─── Zonal Endpoints ──────────────────────────────────────

router.get('/zonal/routes', async (_req: Request, res: Response) => {
  try {
    const features = await getCachedOrFetch('zonal-routes', queries.zonalRoutes);
    res.json({ success: true, count: features.length, features });
  } catch (error) {
    console.error('Error fetching zonal routes:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch zonal routes' });
  }
});

router.get('/zonal/stops', async (_req: Request, res: Response) => {
  try {
    const features = await getCachedOrFetch('zonal-stops', queries.zonalStops);
    res.json({ success: true, count: features.length, features });
  } catch (error) {
    console.error('Error fetching zonal stops:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch zonal stops' });
  }
});

router.get('/zonal/stop-routes', async (_req: Request, res: Response) => {
  try {
    const features = await getCachedOrFetch('zonal-stop-routes', queries.zonalStopRoutes);
    res.json({ success: true, count: features.length, features });
  } catch (error) {
    console.error('Error fetching zonal stop routes:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch zonal stop routes' });
  }
});

// ─── Health Check ─────────────────────────────────────────

router.get('/health', (_req: Request, res: Response) => {
  res.json({
    status: 'ok',
    cacheEntries: cache.size,
    catalogStations: Object.keys(tmApi.getCatalog().stations || {}).length,
    catalogStale: tmApi.isCatalogStale(),
    syncInProgress: tmApi.isSyncInProgress(),
    uptime: process.uptime(),
  });
});

export default router;
