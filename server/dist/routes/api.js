import { Router } from 'express';
import { queries } from '../services/arcgis.js';
const router = Router();
/**
 * Simple in-memory cache with TTL.
 * Route/station data rarely changes — cache for 10 minutes.
 */
const cache = new Map();
const CACHE_TTL = 10 * 60 * 1000; // 10 minutes
async function getCachedOrFetch(key, fetcher) {
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
router.get('/troncal/routes', async (_req, res) => {
    try {
        const features = await getCachedOrFetch('troncal-routes', queries.troncalRoutes);
        res.json({ success: true, count: features.length, features });
    }
    catch (error) {
        console.error('Error fetching troncal routes:', error);
        res.status(500).json({ success: false, error: 'Failed to fetch troncal routes' });
    }
});
router.get('/troncal/stations', async (_req, res) => {
    try {
        const features = await getCachedOrFetch('troncal-stations', queries.troncalStations);
        res.json({ success: true, count: features.length, features });
    }
    catch (error) {
        console.error('Error fetching troncal stations:', error);
        res.status(500).json({ success: false, error: 'Failed to fetch troncal stations' });
    }
});
router.get('/troncal/wagons', async (_req, res) => {
    try {
        const features = await getCachedOrFetch('troncal-wagons', queries.troncalWagons);
        res.json({ success: true, count: features.length, features });
    }
    catch (error) {
        console.error('Error fetching troncal wagons:', error);
        res.status(500).json({ success: false, error: 'Failed to fetch troncal wagons' });
    }
});
router.get('/troncal/corridors', async (_req, res) => {
    try {
        const features = await getCachedOrFetch('troncal-corridors', queries.troncalCorridors);
        res.json({ success: true, count: features.length, features });
    }
    catch (error) {
        console.error('Error fetching troncal corridors:', error);
        res.status(500).json({ success: false, error: 'Failed to fetch troncal corridors' });
    }
});
// ─── Zonal Endpoints ──────────────────────────────────────
router.get('/zonal/routes', async (_req, res) => {
    try {
        const features = await getCachedOrFetch('zonal-routes', queries.zonalRoutes);
        res.json({ success: true, count: features.length, features });
    }
    catch (error) {
        console.error('Error fetching zonal routes:', error);
        res.status(500).json({ success: false, error: 'Failed to fetch zonal routes' });
    }
});
router.get('/zonal/stops', async (_req, res) => {
    try {
        const features = await getCachedOrFetch('zonal-stops', queries.zonalStops);
        res.json({ success: true, count: features.length, features });
    }
    catch (error) {
        console.error('Error fetching zonal stops:', error);
        res.status(500).json({ success: false, error: 'Failed to fetch zonal stops' });
    }
});
router.get('/zonal/stop-routes', async (_req, res) => {
    try {
        const features = await getCachedOrFetch('zonal-stop-routes', queries.zonalStopRoutes);
        res.json({ success: true, count: features.length, features });
    }
    catch (error) {
        console.error('Error fetching zonal stop routes:', error);
        res.status(500).json({ success: false, error: 'Failed to fetch zonal stop routes' });
    }
});
// ─── Health Check ─────────────────────────────────────────
router.get('/health', (_req, res) => {
    res.json({
        status: 'ok',
        cacheEntries: cache.size,
        uptime: process.uptime(),
    });
});
export default router;
