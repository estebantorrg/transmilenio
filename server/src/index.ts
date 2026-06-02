import express from 'express';
import cors from 'cors';
import compression from 'compression';
import apiRoutes from './routes/api.js';
import { loadCatalogFromDisk, isCatalogStale, syncMasterCatalog } from './services/tm_api.js';

const app = express();
const PORT = process.env.PORT || 3002;

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

app.use(express.json());

// Mount API routes
app.use('/api', apiRoutes);

// Serve the statically built frontend
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const clientDist = path.resolve(__dirname, '../../client/dist');
app.use(express.static(clientDist));

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

    // Auto-sync if catalog is stale or missing
    if (isCatalogStale()) {
      console.log('[TM API] Catalog is stale or missing. Starting background sync...');
      syncMasterCatalog().catch((err) => console.error('[Auto-Sync Error]', err));
    }
  });
}

start().catch((error) => {
  console.error('[Startup Error]', error);
  process.exit(1);
});
