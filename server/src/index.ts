import express, { type ErrorRequestHandler } from 'express';
import cors from 'cors';
import compression from 'compression';
import apiRoutes, { prewarmArcgisLayers } from './routes/api.js';
import { getCatalog, loadCatalogFromDisk, isCatalogStale, syncMasterCatalog, startLiveWarmup } from './services/tm_api.js';
import { retiredHostRedirect } from './retired_host.js';
import { isKnownPage } from './known_page.js';
import { movedPagePath, readPrerenderedPages } from './page_redirect.js';
import { startNovedadesPoller } from './services/novedades.js';

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

/**
 * Terminal error handler (spec §4.1 — "clients never receive stack traces").
 * Without one, anything a route throws outside its own try/catch falls through
 * to Express's default handler, which writes the stack into the response body
 * unless NODE_ENV happens to be `production`. Log server-side, answer with the
 * structured shape the API contract promises.
 */
const apiErrorHandler: ErrorRequestHandler = (error, req, res, _next) => {
  // The URL is an argument, not part of the format string: a `%o` in it would
  // otherwise swallow the error into the middle of the line.
  console.error('[Unhandled] %s %s:', req.method, req.originalUrl, error);
  if (res.headersSent) {
    res.end();
    return;
  }
  res.status(500).json({ success: false, error: 'Internal server error' });
};

// `req.ip` is what the per-client budgets count against (spec §3.4), so it has
// to be the real client and not whatever a caller typed into X-Forwarded-For.
// Trusting every hop (`true`) reads the LEFTMOST entry, which is the one the
// caller controls. Trusting only our own front — the host's private network and
// Cloudflare's edge, which is what onrender.com sits behind — reads the first
// address from the right that neither of them owns: the client, however many
// hops stand in between. The ranges are Cloudflare's published list
// (cloudflare.com/ips); one missing from it would count that edge as a client.
const CLOUDFLARE_RANGES = [
  '173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22',
  '141.101.64.0/18', '108.162.192.0/18', '190.93.240.0/20', '188.114.96.0/20',
  '197.234.240.0/22', '198.41.128.0/17', '162.158.0.0/15', '104.16.0.0/13',
  '104.24.0.0/14', '172.64.0.0/13', '131.0.72.0/22',
  '2400:cb00::/32', '2606:4700::/32', '2803:f800::/32', '2405:b500::/32',
  '2405:8100::/32', '2a06:98c0::/29', '2c0f:f248::/32',
];
app.set('trust proxy', ['loopback', 'linklocal', 'uniquelocal', ...CLOUDFLARE_RANGES]);

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

// The site moved to mitrasto.app; a page asked for on the old host follows it.
// Ahead of the static mounts, which would otherwise answer "/" with the shell.
app.use((req, res, next) => {
  const target = retiredHostRedirect(req.method, req.hostname, req.originalUrl);
  if (target) res.redirect(301, target);
  else next();
});

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

// Root API test path. Keep this list in step with routes/api.ts AND with the
// contract in spec §5.5.1 — it had silently drifted eleven endpoints behind.
app.get('/api', (_req, res) => {
  res.json({
    name: 'Transmilenio API Proxy',
    version: '2.0.0',
    endpoints: [
      'GET /api/health',
      'GET /api/troncal/stations',
      'GET /api/troncal/corridors',
      'GET /api/troncal/master-catalog',
      'GET /api/troncal/route/:code',
      'GET /api/zonal/stops',
      'GET /api/zonal/stop-routes',
      'GET /api/cable/stations',
      'GET /api/cable/trazado',
      'GET /api/recarga-points',
      'GET /api/personalizacion-points',
      'GET /api/station-demand',
      'GET /api/transmibici',
      'POST /api/buses',
      'POST /api/stop-arrivals',
      'POST /api/card/read',
      'GET /api/geoip',
      'GET /api/novedades',
      'GET /api/geocode',
      'GET /api/walking-route',
    ],
  });
});

// Unknown API routes must return structured JSON, not the SPA shell.
app.use('/api', (_req, res) => {
  res.status(404).json({ status: 'error', message: 'API endpoint not found' });
});

// For any other route, serve the app shell (client-side routing fallback) —
// but only for a page. A path with an extension is a file, and a file the
// static mounts above did not find does not exist: answering it with the shell
// and a 200 handed HTML to a tab asking for the previous deploy's
// `/assets/*.js`, and the service worker cached that HTML under the script's
// URL (`cacheFirst` keeps any `ok` response).
const prerenderedPages = readPrerenderedPages(clientDist);

app.get('*', (req, res) => {
  if (path.extname(req.path)) {
    res.sendStatus(404);
    return;
  }
  // A renamed, mistyped or uppercase address of a page that exists elsewhere.
  const moved = movedPagePath(req.path, prerenderedPages);
  if (moved) {
    const query = req.originalUrl.indexOf('?');
    res.redirect(301, moved + (query >= 0 ? req.originalUrl.slice(query) : ''));
    return;
  }
  // An address that names no page gets the shell with the 404 it is (the app
  // draws the "no existe" page), not a 200 that tells a crawler it found one.
  res.status(isKnownPage(req.path, getCatalog()) ? 200 : 404).sendFile(path.resolve(clientDist, 'index.html'));
});

// Last in the stack, so it catches anything any route above threw (Express walks
// the stack FORWARD from where the error was raised).
app.use(apiErrorHandler);

async function start(): Promise<void> {
  // Load cached catalog from disk
  await loadCatalogFromDisk();

  app.listen(PORT, () => {
    console.log(`\n🚌 Transmilenio API Proxy running on http://localhost:${PORT}\n`);

    // Keep a configured Colombia relay and its sockets hot so the first live
    // poll of a tracking session isn't a cold start (spec §5.2.2b).
    startLiveWarmup();

    // TransMilenio's #TMAhora posts on X, read every three minutes (§5.5.9).
    startNovedadesPoller();

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
