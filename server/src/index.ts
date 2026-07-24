import express, { type ErrorRequestHandler } from 'express';
import cors from 'cors';
import compression from 'compression';
import apiRoutes, { prewarmArcgisLayers } from './routes/api.js';
import { loadCatalogFromDisk, isCatalogStale, syncMasterCatalog, startLiveWarmup } from './services/tm_api.js';

const app = express();
const PORT = process.env.PORT || 3002;
const JSON_BODY_LIMIT = '64kb';

const jsonErrorHandler: ErrorRequestHandler = (error, _req, res, next) => {
  if (error?.type === 'entity.too.large') {
    res.status(413).json({ success: false, error: 'Request body too large' });
    return;
  }

  if (error instanceof SyntaxError && 'body' in error) {
    res.status(400).json({ success: false, error: 'Invalid JSON body' });
    return;
  }

  next(error);
};

// Behind Render's proxy — trust X-Forwarded-* so req.ip is the real client IP
// (used by /api/geoip for approximate location).
app.set('trust proxy', true);

const configuredOrigins = process.env.CLIENT_ORIGINS
  ?.split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);
const allowedOrigins = configuredOrigins?.length
  ? configuredOrigins
  : [/^http:\/\/localhost:\d+$/, /^http:\/\/127\.0\.0\.1:\d+$/];

// Gzip all responses (critical for the ~68 MB catalog JSON)
app.use(compression());

// Enable CORS for local Vite dev/preview servers.
app.use(cors({
  origin: allowedOrigins,
  methods: ['GET', 'POST'],
}));

app.use(express.json({ limit: JSON_BODY_LIMIT }));
app.use(jsonErrorHandler);

// Mount API routes
app.use('/api', apiRoutes);

// Serve the statically built frontend
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const clientDist = path.resolve(__dirname, '../../client/dist');
app.use(express.static(clientDist, {
  setHeaders(res, filePath) {
    // Vite fingerprints everything under /assets/ — cache hard & forever.
    if (filePath.includes(`${path.sep}assets${path.sep}`)) {
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    } else if (filePath.endsWith('index.html')) {
      // Always revalidate the shell so new asset hashes are picked up on deploy.
      res.setHeader('Cache-Control', 'no-cache');
    } else {
      // Unhashed public assets (models, draco, icons) — cache a day.
      res.setHeader('Cache-Control', 'public, max-age=86400');
    }
  },
}));

// Crawler-facing root files (robots.txt, sitemap.xml, Search Console token).
// They must be reachable at the site root, but they are not client build output,
// so they live in one dedicated folder (`seo/`) and are served straight from it
// instead of being duplicated into client/public (spec §5.5.4).
const seoDir = path.resolve(__dirname, '../../seo');
app.use(express.static(seoDir, {
  index: false,
  setHeaders(res) {
    res.setHeader('Cache-Control', 'public, max-age=3600');
  },
}));

// Root API test path
app.get('/api', (_req, res) => {
  res.json({
    name: 'Transmilenio API Proxy',
    version: '2.0.0',
    endpoints: [
      'GET /api/troncal/routes',
      'GET /api/troncal/stations',
      'GET /api/troncal/corridors',
      'GET /api/troncal/master-catalog',
      'GET /api/troncal/station/:code',
      'POST /api/troncal/sync',
      'GET /api/zonal/routes',
      'GET /api/zonal/stops',
      'GET /api/zonal/stop-routes',
      'POST /api/card/read',
      'GET /api/health',
    ],
  });
});

// Unknown API routes must return structured JSON, not the SPA shell.
app.use('/api', (_req, res) => {
  res.status(404).json({ status: 'error', message: 'API endpoint not found' });
});

// For any other route, serve the React app (Client-side routing fallback)
app.get('*', (req, res) => {
  res.sendFile(path.resolve(clientDist, 'index.html'));
});

async function start(): Promise<void> {
  // Load cached catalog from disk
  await loadCatalogFromDisk();

  app.listen(PORT, () => {
    console.log(`\n🚌 Transmilenio API Proxy running on http://localhost:${PORT}\n`);

    // Keep the Colombian egress (serverless Function) and its sockets hot so the
    // first live poll of a tracking session isn't a cold start (spec §5.2.2b).
    startLiveWarmup();

    // Cache the two default-on ArcGIS layers before the first visitor asks for
    // them, so a cold instance doesn't serve them out of a five-query burst
    // (spec §4.2 — the map must never open with a layer silently missing).
    prewarmArcgisLayers();

    // Auto-sync if catalog is stale or missing — OFF by default. A full sync
    // holds the old + new + merged catalogs at once (~700 MB peak) and OOM-kills
    // a 512 MB web instance; it also overwrites the curated Git-LFS catalog with
    // a partial fetch. Production ships the committed catalog and serves it
    // read-only (spec §4.3); refresh it offline via `npm run sync` (its own
    // process) and redeploy. Opt in with TM_ENABLE_AUTO_SYNC=1 only on a box
    // with the headroom (≥1 GB).
    if (isCatalogStale()) {
      if (process.env.TM_ENABLE_AUTO_SYNC === '1') {
        console.log('[TM API] Catalog is stale or missing. Starting background sync...');
        syncMasterCatalog().catch((err) => console.error('[Auto-Sync Error]', err));
      } else {
        console.warn('[TM API] Catalog is stale or missing, but auto-sync is disabled ' +
          '(set TM_ENABLE_AUTO_SYNC=1 to enable). Serving the on-disk catalog; ' +
          'run `npm run sync` offline and redeploy to refresh.');
      }
    }
  });
}

start().catch((error) => {
  console.error('[Startup Error]', error);
  process.exit(1);
});
