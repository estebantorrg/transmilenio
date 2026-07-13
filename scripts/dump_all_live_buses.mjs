#!/usr/bin/env node

/**
 * Standalone script to dump all live buses across ALL routes.
 *
 * Self-contained — does NOT require a master catalog. Discovers all routes
 * directly from the official TransMi route-search API, then fetches live
 * bus positions for each discovered route.
 *
 * Requirements: Node.js 18+ and a Colombian internet connection (the live
 * tracking API is geofenced to Colombian IPs).
 *
 * Features:
 * - Route discovery via buscador-rutas API (A–Z, 0–9 search seeds)
 * - Retry logic with exponential backoff for timeouts, 400, and 5xx errors
 * - Smart backoff for 429 (rate limit) responses with global cooldown
 * - Graceful handling of persistent 4xx errors (skips route, continues)
 * - Connection pooling to avoid socket exhaustion
 * - Deduplicates buses by vehicle ID across all route variants
 * - Parallel batch processing with configurable concurrency
 * - Second-pass retry for all routes that failed in the first pass
 * - Extracts labels, headings, positions, and other metadata from each bus
 * - Real-time progress logging
 * - Ensures EVERY route is attempted — no early bailout
 *
 * Usage:
 *   node scripts/dump_all_live_buses.mjs                 # Interactive prompt
 *   node scripts/dump_all_live_buses.mjs --troncal       # Skip prompt, troncales only
 *   node scripts/dump_all_live_buses.mjs --zonal         # Skip prompt, zonales only
 *   node scripts/dump_all_live_buses.mjs --both          # Skip prompt, all routes
 *   node scripts/dump_all_live_buses.mjs --catalog path  # Use catalog file instead of API discovery
 */

import https from 'https';
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import readline from 'readline';
import { fileURLToPath } from 'url';

// ─── CLI Argument Parsing ──────────────────────────────────

const args = process.argv.slice(2);
let filterMode = null; // null = prompt user; 'troncal', 'zonal', or 'both'
let searchMode = null; // null = prompt user; 'none', 'route', or 'movil'
let searchTerm = null; // the route code or móvil label to search for
let catalogPath = null;

for (let i = 0; i < args.length; i++) {
  const arg = args[i].toLowerCase();
  if (arg === '--troncal') filterMode = 'troncal';
  else if (arg === '--zonal') filterMode = 'zonal';
  else if (arg === '--both' || arg === '--all') filterMode = 'both';
  else if (arg === '--route' && args[i + 1]) { searchMode = 'route'; searchTerm = args[++i]; }
  else if (arg === '--movil' && args[i + 1]) { searchMode = 'movil'; searchTerm = args[++i]; }
  else if (arg === '--catalog' && args[i + 1]) { catalogPath = args[++i]; }
  else if (!arg.startsWith('-')) { catalogPath = args[i]; }
}

// ─── Interactive Prompt ────────────────────────────────────

function askUser(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => { rl.close(); resolve(answer.trim()); });
  });
}

async function promptFilterMode() {
  console.log('\n🚌 TransMilenio Live Bus Dump\n');
  console.log('  ¿Qué rutas quieres escanear?\n');
  console.log('  1 → Troncales (TransMilenio)');
  console.log('  2 → SITP Zonal + Alimentadores (TransMiZonal)');
  console.log('  3 → Todas\n');

  const answer = await askUser('  Escoge (1/2/3): ');

  switch (answer) {
    case '1': return 'troncal';
    case '2': return 'zonal';
    case '3': return 'both';
    default:
      console.log('  → Opción no reconocida, escaneando todas.\n');
      return 'both';
  }
}

async function promptSearchMode() {
  console.log('\n  ¿Quieres buscar una ruta o un móvil en específico?\n');
  console.log('  1 → Buscar por ruta (ej: H72, B46, C149)');
  console.log('  2 → Buscar por móvil (ej: U1402, SE023)');
  console.log('  3 → No, escanear todo\n');

  const answer = await askUser('  Escoge (1/2/3): ');

  switch (answer) {
    case '1': {
      const term = await askUser('  Código de ruta: ');
      if (term) return { mode: 'route', term: term.toUpperCase() };
      console.log('  → Vacío, escaneando todo.\n');
      return { mode: 'none', term: null };
    }
    case '2': {
      const term = await askUser('  Label del móvil: ');
      if (term) return { mode: 'movil', term: term.toUpperCase() };
      console.log('  → Vacío, escaneando todo.\n');
      return { mode: 'none', term: null };
    }
    case '3':
    default:
      return { mode: 'none', term: null };
  }
}

// ─── Configuration ─────────────────────────────────────────

// Live bus tracking API
const LIVE_API_HOST = 'tmsa-transmiapp-shvpc.uc.r.appspot.com';
const LIVE_API_ORIGIN = `https://${LIVE_API_HOST}`;

const LIVE_HEADERS = {
  'Accept-Encoding': 'identity',
  'Appid': '9a2c3b48f0c24ae9bfba38e94f27c3ea',
  'Connection': 'Keep-Alive',
  'Host': LIVE_API_HOST,
  'User-Agent': 'okhttp/4.12.0',
  'uuid': 'fd1be953-d85e-4c63-8c23-234f143f445d',
  'version': '2.9.5',
};

// Route discovery API (buscador-rutas)
const DISCOVERY_API_HOST = 'api.buscador-rutas.transmilenio.gov.co';
const DISCOVERY_API_BASE = '/loader.php';
const DISCOVERY_HEADERS = {
  'Accept-Encoding': 'gzip',
  'Connection': 'Keep-Alive',
  'Host': DISCOVERY_API_HOST,
  'User-Agent': 'okhttp/4.12.0',
  'uuid': 'fd1be953-d85e-4c63-8c23-234f143f445d',
  'version': '2.9.5',
};
const ROUTE_SEARCH_SEEDS = ['', ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'];

// Tuning
const REQUEST_TIMEOUT_MS = 7_000;
const DISCOVERY_TIMEOUT_MS = 12_000;
const BATCH_SIZE = 20;
const MAX_RETRIES = 3;
const MAX_RETRIES_400 = 2;
const BASE_RETRY_DELAY_MS = 600;
const MAX_RETRY_DELAY_MS = 8_000;
const RATE_LIMIT_DELAY_MS = 4000;
const INTER_BATCH_DELAY_MS = 100;
const GLOBAL_429_COOLDOWN_MS = 6_000;
const RETRY_BATCH_SIZE = 10;
const RETRY_MAX_RETRIES = 2;

const __filename2 = fileURLToPath(import.meta.url);
const __dirname2 = path.dirname(__filename2);

// ─── HTTPS Agent with Connection Pooling ───────────────────

const httpsAgent = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 30000,
  maxSockets: 25,
  maxFreeSockets: 10,
  timeout: REQUEST_TIMEOUT_MS,
  freeSocketTimeout: 60000,
});

// ─── Global rate-limit tracking ────────────────────────────

let globalCooldownUntil = 0;

// ─── Utility Functions ──────────────────────────────────────

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isLiveBusLike(value) {
  if (!value || typeof value !== 'object') return false;
  const lat = Number(value.latitude ?? value.lat ?? value.latitud);
  const lng = Number(value.longitude ?? value.lng ?? value.lon);
  return Number.isFinite(lat) && Number.isFinite(lng);
}

function normalizeLiveBusesPayload(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];

  const candidates = [
    payload.data, payload.buses, payload.result,
    payload.results, payload.vehiculos, payload.vehicles,
  ];

  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate;
  }

  for (const candidate of candidates) {
    if (candidate && typeof candidate === 'object') {
      const nested = Object.values(candidate);
      const found = nested.filter(isLiveBusLike);
      if (found.length > 0) return found;
    }
  }

  const values = Object.values(payload);
  const buses = values.filter(isLiveBusLike);
  return buses.length > 0 ? buses : [];
}

function extractBusId(bus) {
  const id = (
    bus.label ?? bus.name ?? bus.codigo ??
    bus.vehiculo_id ?? bus.vehicle_id ?? bus.vehicleId ??
    bus.movil ?? bus.placa ?? bus.id ?? ''
  ).toString().trim();
  return id.length > 0 ? id : null;
}

function extractBusLabel(bus) {
  const label = (bus.label ?? bus.name ?? bus.movil ?? '').toString().trim();
  return label.length > 0 ? label : null;
}

function extractLatitude(bus) {
  const num = Number(bus.latitude ?? bus.lat ?? bus.latitud);
  return Number.isFinite(num) ? num : null;
}

function extractLongitude(bus) {
  const num = Number(bus.longitude ?? bus.lng ?? bus.lon);
  return Number.isFinite(num) ? num : null;
}

function toFiniteOrNull(val) {
  const num = Number(val);
  return Number.isFinite(num) ? num : null;
}

function buildLiveNameCandidates(nombre) {
  const candidates = [];
  const text = (typeof nombre === 'string' ? nombre : String(nombre)).trim().slice(0, 160);
  if (!text) return [''];

  const parts = text.split(/\s+[-–—]\s+/).map((p) => p.trim()).filter(Boolean);
  if (parts.length > 1) {
    for (const p of parts.reverse()) {
      if (p && !candidates.some((c) => c.toLowerCase() === p.toLowerCase())) {
        candidates.push(p);
      }
    }
  }
  if (!candidates.some((c) => c.toLowerCase() === text.toLowerCase())) {
    candidates.push(text);
  }

  return candidates.slice(0, 12);
}

// ─── Route Discovery (no catalog needed) ────────────────────

function gunzipAsync(buf) {
  return new Promise((resolve, reject) => {
    zlib.gunzip(buf, (err, result) => err ? reject(err) : resolve(result));
  });
}

async function fetchDiscoveryApi(params) {
  const query = new URLSearchParams(params).toString();
  const apiPath = `${DISCOVERY_API_BASE}?${query}`;

  return new Promise((resolve, reject) => {
    const req = https.get(
      {
        hostname: DISCOVERY_API_HOST,
        path: apiPath,
        headers: DISCOVERY_HEADERS,
        timeout: DISCOVERY_TIMEOUT_MS,
        agent: httpsAgent,
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', async () => {
          const raw = Buffer.concat(chunks);
          const encoding = res.headers['content-encoding'];

          const parse = (buf) => {
            const text = buf.toString('utf-8');
            try { return JSON.parse(text); }
            catch { return null; }
          };

          if (encoding === 'gzip') {
            try {
              const decompressed = await gunzipAsync(raw);
              resolve(parse(decompressed));
            } catch {
              resolve(parse(raw));
            }
          } else {
            resolve(parse(raw));
          }
        });
      }
    );

    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Discovery timeout')); });
  });
}

async function fetchDiscoveryWithRetry(params, label) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const result = await fetchDiscoveryApi(params);
      if (result !== null) return result;
      throw new Error('Null response');
    } catch (err) {
      if (attempt === 3) throw err;
      const backoff = 2000 * attempt;
      console.warn(`  ⚠ ${label} attempt ${attempt}/3 failed: ${err.message} — retrying in ${backoff}ms`);
      await sleep(backoff);
    }
  }
}

async function searchRoutesByTerm(search) {
  const data = await fetchDiscoveryWithRetry(
    {
      lServicio: 'Rutas',
      lTipo: 'api',
      lFuncion: 'searchRutaByTipo',
      tipo_ruta: 'TIPORUTA',
      search,
    },
    `search("${search || '∅'}")`
  );

  return data?.lista_rutas ?? [];
}

function isZonalRoute(route) {
  const ts = (route.tipoServicio || '').trim();
  const ss = (route.sistema || '').trim();
  return ts === 'TransMiZonal' || ss === 'TransMiZonal' || ts === 'PADRON';
}

function isTroncalRoute(route) {
  const ts = (route.tipoServicio || '').trim();
  const ss = (route.sistema || '').trim();
  return ts === 'TRONCAL' || ts === 'TransMilenio' || ss === 'TransMilenio';
}

function classifyRouteType(route) {
  if (isZonalRoute(route)) return 'zonal';
  if (isTroncalRoute(route)) return 'troncal';
  return 'troncal'; // default
}

async function discoverAllRoutes() {
  console.log(`🔍 Discovering routes from TransMi API (${ROUTE_SEARCH_SEEDS.length} search seeds)...\n`);

  const routesById = new Map();
  let seedsDone = 0;

  for (const seed of ROUTE_SEARCH_SEEDS) {
    try {
      const routes = await searchRoutesByTerm(seed);
      let newCount = 0;
      for (const route of routes) {
        if (!routesById.has(route.id)) {
          routesById.set(route.id, route);
          newCount++;
        }
      }
      seedsDone++;
      const label = seed || '∅';
      if (newCount > 0) {
        console.log(`  [${seedsDone}/${ROUTE_SEARCH_SEEDS.length}] seed="${label}" → ${routes.length} results, ${newCount} new (total: ${routesById.size})`);
      }
    } catch (err) {
      console.warn(`  [${seedsDone + 1}/${ROUTE_SEARCH_SEEDS.length}] seed="${seed || '∅'}" → ❌ ${err.message}`);
      seedsDone++;
    }

    // Small delay between discovery requests
    await sleep(300 + Math.random() * 400);
  }

  // Convert to our route format
  const routes = [];
  const seen = new Set();

  for (const apiRoute of routesById.values()) {
    const routeCode = String(apiRoute.codigo).trim();
    const routeName = String(apiRoute.nombre || routeCode).trim();
    const routeType = classifyRouteType(apiRoute);

    // Apply filter
    if (filterMode !== 'both' && routeType !== filterMode) continue;

    const key = `${routeCode}|${routeName}`;
    if (seen.has(key)) continue;
    seen.add(key);

    routes.push({ code: routeCode, name: routeName, type: routeType });
  }

  routes.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'troncal' ? -1 : 1;
    return a.code.localeCompare(b.code);
  });

  return routes;
}

// ─── Catalog-based Route Loading (optional fallback) ────────

function loadCatalogRoutes(catPath) {
  const raw = fs.readFileSync(catPath, 'utf-8');
  const catalog = JSON.parse(raw);

  const seen = new Set();
  const routes = [];

  if (catalog.routes && typeof catalog.routes === 'object') {
    for (const [code, variants] of Object.entries(catalog.routes)) {
      if (!Array.isArray(variants)) continue;
      for (const variant of variants) {
        if (!variant || typeof variant !== 'object') continue;

        const routeCode = String(code).trim();
        const routeName = String(variant.nombre || routeCode).trim();
        const routeType = classifyRouteType(variant);

        if (filterMode !== 'both' && routeType !== filterMode) continue;

        const key = `${routeCode}|${routeName}`;
        if (seen.has(key)) continue;
        seen.add(key);

        routes.push({ code: routeCode, name: routeName, type: routeType });
      }
    }
  }

  // Fallback: stations.wagons
  if (catalog.stations && routes.length === 0 && typeof catalog.stations === 'object') {
    for (const station of Object.values(catalog.stations)) {
      if (!station || typeof station !== 'object') continue;
      for (const wagon of Object.values(station.wagons || {})) {
        if (!Array.isArray(wagon)) continue;
        for (const route of wagon) {
          if (!route || typeof route !== 'object') continue;
          const routeCode = String(route.codigo).trim();
          const routeName = String(route.nombre || route.codigo).trim();
          const routeType = classifyRouteType(route);

          if (filterMode !== 'both' && routeType !== filterMode) continue;

          const key = `${routeCode}|${routeName}`;
          if (seen.has(key)) continue;
          seen.add(key);

          routes.push({ code: routeCode, name: routeName, type: routeType });
        }
      }
    }
  }

  routes.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'troncal' ? -1 : 1;
    return a.code.localeCompare(b.code);
  });

  return routes;
}

// ─── HTTP Request (Live Bus API) ────────────────────────────

async function makeRequest(url, headers, body, timeoutMs = REQUEST_TIMEOUT_MS) {
  const now = Date.now();
  if (now < globalCooldownUntil) {
    await sleep(globalCooldownUntil - now);
  }

  return new Promise((resolve) => {
    let req = null;
    let timeoutHandle = null;
    let completed = false;

    const cleanup = () => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (req) { try { req.destroy(); } catch { /* noop */ } }
    };

    const respond = (result) => {
      if (completed) return;
      completed = true;
      cleanup();
      resolve(result);
    };

    try {
      const parsedUrl = new URL(url);
      req = https.request(
        {
          hostname: parsedUrl.hostname,
          port: parsedUrl.port || 443,
          path: `${parsedUrl.pathname}${parsedUrl.search}`,
          method: 'POST',
          headers,
          agent: httpsAgent,
        },
        (res) => {
          const chunks = [];
          res.on('data', (chunk) => chunks.push(chunk));
          res.on('end', () => {
            const buffer = Buffer.concat(chunks);
            const text = buffer.toString('utf-8');

            if (res.statusCode === 200) {
              try {
                const payload = JSON.parse(text);
                respond({ success: true, data: payload, statusCode: 200, error: null, retryable: false });
              } catch (e) {
                respond({ success: false, data: null, statusCode: 200, error: `JSON parse error: ${text.slice(0, 80)}`, retryable: true });
              }
            } else if (res.statusCode === 429) {
              globalCooldownUntil = Math.max(globalCooldownUntil, Date.now() + GLOBAL_429_COOLDOWN_MS);
              respond({ success: false, data: null, statusCode: 429, error: 'Rate limited', retryable: true });
            } else if (res.statusCode >= 500) {
              respond({ success: false, data: null, statusCode: res.statusCode, error: `HTTP ${res.statusCode}`, retryable: true });
            } else if (res.statusCode === 400) {
              respond({ success: false, data: null, statusCode: 400, error: `HTTP 400: ${text.slice(0, 120)}`, retryable: true });
            } else if (res.statusCode >= 401 && res.statusCode < 500) {
              respond({ success: false, data: null, statusCode: res.statusCode, error: `HTTP ${res.statusCode}`, retryable: false });
            } else {
              respond({ success: false, data: null, statusCode: res.statusCode, error: `HTTP ${res.statusCode}`, retryable: res.statusCode >= 500 });
            }
          });
          res.on('error', (err) => {
            respond({ success: false, data: null, statusCode: null, error: `Response stream: ${err.message}`, retryable: true });
          });
        }
      );

      req.on('error', (err) => {
        const isRetryable =
          err.code === 'ECONNREFUSED' || err.code === 'ECONNRESET' ||
          err.code === 'ETIMEDOUT' || err.code === 'ENOTFOUND' ||
          err.code === 'EPIPE' || err.code === 'EHOSTUNREACH' ||
          err.code === 'EAI_AGAIN' || err.code === 'ECONNABORTED' ||
          err.code === 'ERR_SOCKET_CONNECTION_TIMEOUT' ||
          err.message.includes('socket hang up');
        respond({ success: false, data: null, statusCode: null, error: `Network: ${err.code || err.message}`, retryable: isRetryable });
      });

      timeoutHandle = setTimeout(() => {
        respond({ success: false, data: null, statusCode: null, error: 'Request timeout', retryable: true });
      }, timeoutMs);

      if (body) req.write(body);
      req.end();
    } catch (err) {
      respond({ success: false, data: null, statusCode: null, error: `Fatal: ${err.message}`, retryable: false });
    }
  });
}

// ─── Route Fetching ─────────────────────────────────────────

async function fetchLiveBusesForRoute(routeCode, routeName, routeType, maxRetries = MAX_RETRIES) {
  const isZonal = routeType === 'zonal';

  const nameCandidates = isZonal
    ? ['']
    : buildLiveNameCandidates(routeName);

  let lastError = null;

  for (const candidateName of nameCandidates) {
    const effectiveRetries = Math.min(maxRetries, MAX_RETRIES);

    for (let attempt = 1; attempt <= effectiveRetries; attempt++) {
      const targetPath = isZonal
        ? `/location/ruta?ruta=${encodeURIComponent(routeCode)}`
        : '/buses';

      const url = `${LIVE_API_ORIGIN}${targetPath}`;
      const body = isZonal
        ? ''
        : JSON.stringify({ ruta: routeCode, Nombre: candidateName });

      const headers = { ...LIVE_HEADERS };
      if (body) {
        headers['Content-Type'] = 'application/json; charset=UTF-8';
        headers['Content-Length'] = Buffer.byteLength(body);
      }

      const result = await makeRequest(url, headers, body);

      if (result.success) {
        const buses = normalizeLiveBusesPayload(result.data);
        if (buses.length > 0) return buses;
        break;
      }

      lastError = result.error;

      if (!result.retryable) break;
      if (result.statusCode === 400 && attempt >= MAX_RETRIES_400) break;

      const isLast = attempt === effectiveRetries;
      if (isLast) break;

      let delayMs;
      if (result.statusCode === 429) {
        delayMs = RATE_LIMIT_DELAY_MS + Math.random() * 1000;
      } else if (result.statusCode === 400) {
        delayMs = 400 + Math.random() * 300;
      } else {
        delayMs = Math.min(BASE_RETRY_DELAY_MS * Math.pow(2, attempt - 1), MAX_RETRY_DELAY_MS) + Math.random() * 300;
      }

      await sleep(delayMs);
    }
  }

  if (lastError) {
    throw new Error(`${routeCode} (${routeType}): ${lastError}`);
  }

  return [];
}

// ─── Bus Record Builder ─────────────────────────────────────

/**
 * Classifies a bus using the live API's nombre_sistema field.
 * 'troncal' = TransMilenio, 'zonal' = TransMiZonal, fallback to route type.
 */
function classifyBusSystem(bus, route) {
  const ns = (typeof bus.nombre_sistema === 'string' ? bus.nombre_sistema : '').trim().toLowerCase();
  if (ns.includes('transmilenio') && !ns.includes('zonal')) return 'troncal';
  if (ns.includes('transmizonal') || ns.includes('zonal')) return 'zonal';
  return route.type === 'zonal' ? 'zonal' : 'troncal';
}

function buildBusRecord(bus, route) {
  const busId = extractBusId(bus);
  if (!busId) return null;

  const lat = extractLatitude(bus);
  const lng = extractLongitude(bus);
  if (lat === null || lng === null) return null;

  const label = extractBusLabel(bus);
  const busSystem = classifyBusSystem(bus, route);

  return {
    id: busId,
    label: label || busId,
    busSystem,
    latitude: parseFloat(lat.toFixed(6)),
    longitude: parseFloat(lng.toFixed(6)),
    routeCode: route.code,
    routeName: route.name,
    routeType: route.type,
    ruta_extraida: typeof bus.ruta_extraida === 'string' ? bus.ruta_extraida : undefined,
    destino_limpio: typeof bus.destino_limpio === 'string' ? bus.destino_limpio : undefined,
    lasttime: typeof bus.lasttime === 'string' ? bus.lasttime : undefined,
    angulo: toFiniteOrNull(bus.angulo ?? bus.angle ?? bus.heading),
    posicion: toFiniteOrNull(bus.posicion),
    nombre_sistema: typeof bus.nombre_sistema === 'string' ? bus.nombre_sistema : undefined,
  };
}

// ─── Main Fetch Loop ────────────────────────────────────────

async function fetchAllLiveBuses(routes) {
  const results = {
    scannedAt: Date.now(),
    filter: filterMode,
    totalRoutes: routes.length,
    routesProcessed: 0,
    routesWithBuses: 0,
    routesFailed: 0,
    totalUniqueBuses: 0,
    buses: [],
    errors: {},
  };

  const busesById = new Map();
  const errorsByRoute = {};
  const failedRoutes = [];

  for (let i = 0; i < routes.length; i += BATCH_SIZE) {
    const batch = routes.slice(i, i + BATCH_SIZE);
    const promises = batch.map((route, batchIdx) =>
      (async () => {
        try {
          const buses = await fetchLiveBusesForRoute(route.code, route.name, route.type);
          return { route, buses, error: null, batchIdx };
        } catch (err) {
          return {
            route, buses: [],
            error: err instanceof Error ? err : new Error(String(err)),
            batchIdx,
          };
        }
      })()
    );

    const settled = await Promise.allSettled(promises);

    for (const result of settled) {
      let routeResult;
      if (result.status === 'fulfilled') {
        routeResult = result.value;
      } else {
        routeResult = {
          route: { code: 'UNKNOWN', name: 'UNKNOWN', type: 'unknown' },
          buses: [],
          error: result.reason instanceof Error ? result.reason : new Error(String(result.reason)),
          batchIdx: 0,
        };
      }

      const { route, buses, error, batchIdx } = routeResult;
      const progressIdx = i + batchIdx + 1;
      results.routesProcessed++;

      if (error) {
        results.routesFailed++;
        errorsByRoute[`${route.code}|${route.name}`] = error.message;
        failedRoutes.push(route);
        console.log(`[${progressIdx}/${routes.length}] ${route.code} (${route.type}) → ${route.name} — ❌ ${error.message}`);
        continue;
      }

      if (!Array.isArray(buses) || buses.length === 0) {
        console.log(`[${progressIdx}/${routes.length}] ${route.code} (${route.type}) → ${route.name} — ⚪ 0 buses`);
        continue;
      }

      results.routesWithBuses++;

      for (const bus of buses) {
        const record = buildBusRecord(bus, route);
        if (record && !busesById.has(record.id)) {
          busesById.set(record.id, record);
        }
      }

      console.log(`[${progressIdx}/${routes.length}] ${route.code} (${route.type}) → ${route.name} — ✅ ${buses.length} buses`);
    }

    if (i + BATCH_SIZE < routes.length) {
      await sleep(INTER_BATCH_DELAY_MS);
    }
  }

  // ─── Second-pass retry for all failed routes (parallel batches) ──
  if (failedRoutes.length > 0) {
    console.log(`\n🔄 Retrying ${failedRoutes.length} failed route(s) in parallel...\n`);
    await sleep(1000);

    for (let ri = 0; ri < failedRoutes.length; ri += RETRY_BATCH_SIZE) {
      const retryBatch = failedRoutes.slice(ri, ri + RETRY_BATCH_SIZE);

      const retryPromises = retryBatch.map((route, idx) =>
        (async () => {
          const key = `${route.code}|${route.name}`;
          const retryIdx = ri + idx + 1;
          try {
            const buses = await fetchLiveBusesForRoute(route.code, route.name, route.type, RETRY_MAX_RETRIES);

            if (Array.isArray(buses) && buses.length > 0) {
              delete errorsByRoute[key];
              results.routesFailed--;
              results.routesWithBuses++;

              for (const bus of buses) {
                const record = buildBusRecord(bus, route);
                if (record && !busesById.has(record.id)) {
                  busesById.set(record.id, record);
                }
              }
              console.log(`[retry ${retryIdx}/${failedRoutes.length}] ${route.code} (${route.type}) → ${route.name} — ✅ ${buses.length} buses (recovered)`);
            } else {
              delete errorsByRoute[key];
              results.routesFailed--;
              console.log(`[retry ${retryIdx}/${failedRoutes.length}] ${route.code} (${route.type}) → ${route.name} — ⚪ 0 buses (recovered)`);
            }
          } catch (retryErr) {
            errorsByRoute[key] = retryErr instanceof Error ? retryErr.message : String(retryErr);
            console.log(`[retry ${retryIdx}/${failedRoutes.length}] ${route.code} (${route.type}) → ${route.name} — ❌ ${errorsByRoute[key]}`);
          }
        })()
      );

      await Promise.allSettled(retryPromises);

      if (ri + RETRY_BATCH_SIZE < failedRoutes.length) {
        await sleep(100);
      }
    }
  }

  results.totalUniqueBuses = busesById.size;
  results.buses = Array.from(busesById.values()).sort((a, b) => a.id.localeCompare(b.id));
  results.errors = errorsByRoute;

  return results;
}

// ─── Main Entry Point ───────────────────────────────────────

async function main() {
  // Interactive prompts if no CLI flags
  if (filterMode === null) {
    filterMode = await promptFilterMode();
  }
  if (searchMode === null) {
    const result = await promptSearchMode();
    searchMode = result.mode;
    searchTerm = result.term;
  }

  const modeLabels = { troncal: 'Troncales', zonal: 'SITP Zonal + Alimentadores (TransMiZonal)', both: 'Todas (Troncales + SITP + Alimentadores)' };
  const modeLabel = modeLabels[filterMode] || filterMode;
  console.log(`\n🚌 TransMilenio Live Bus Dump — ${modeLabel}`);
  if (searchMode === 'route') console.log(`   🔎 Buscando ruta: ${searchTerm}`);
  if (searchMode === 'movil') console.log(`   🔎 Buscando móvil: ${searchTerm}`);
  console.log('');

  let routes;

  if (catalogPath) {
    const resolvedPath = path.resolve(catalogPath);
    console.log(`📍 Loading routes from catalog: ${resolvedPath}\n`);
    try {
      routes = loadCatalogRoutes(resolvedPath);
    } catch (err) {
      console.error(`❌ Failed to load catalog: ${err.message}`);
      process.exit(1);
    }
  } else {
    try {
      routes = await discoverAllRoutes();
    } catch (err) {
      console.error(`❌ Route discovery failed: ${err.message}`);
      process.exit(1);
    }
  }

  // Filter to specific route code if searching by route
  if (searchMode === 'route' && searchTerm) {
    const term = searchTerm.toUpperCase();
    routes = routes.filter(r => r.code.toUpperCase() === term);
    if (routes.length === 0) {
      console.error(`❌ Ruta "${searchTerm}" no encontrada en las ${filterMode === 'both' ? 'rutas' : filterMode + 's'} descubiertas`);
      process.exit(1);
    }
  }

  const troncalCount = routes.filter(r => r.type === 'troncal').length;
  const zonalCount = routes.filter(r => r.type === 'zonal').length;
  console.log(`\n✅ Found ${routes.length} route variants (${troncalCount} troncales, ${zonalCount} zonales/alimentadores)\n`);

  if (routes.length === 0) {
    console.error('❌ No routes found');
    process.exit(1);
  }

  console.log('📡 Fetching live buses...\n');
  const result = await fetchAllLiveBuses(routes);

  // ─── Post-fetch filtering ──────────────────────────────────

  // Filter out non-troncal buses leaking into troncal results (and vice versa)
  if (filterMode === 'troncal') {
    result.buses = result.buses.filter(b => b.busSystem === 'troncal');
  } else if (filterMode === 'zonal') {
    result.buses = result.buses.filter(b => b.busSystem === 'zonal');
  }

  // Filter to specific móvil label if searching by móvil
  if (searchMode === 'movil' && searchTerm) {
    const term = searchTerm.toUpperCase();
    result.buses = result.buses.filter(b => {
      const label = (b.label || '').toUpperCase();
      const id = (b.id || '').toUpperCase();
      return label === term || id === term || label.includes(term) || id.includes(term);
    });
  }

  result.totalUniqueBuses = result.buses.length;

  const outputPath = path.resolve(process.cwd(), 'live_buses_dump.json');
  fs.writeFileSync(outputPath, JSON.stringify(result, null, 2), 'utf-8');

  const busesWithLabels = result.buses.filter(b => b.label && b.label !== b.id).length;
  const troncalBuses = result.buses.filter(b => b.busSystem === 'troncal').length;
  const zonalBuses = result.buses.filter(b => b.busSystem === 'zonal').length;

  console.log(`\n${'═'.repeat(60)}`);
  console.log('✅ COMPLETE');
  console.log(`${'═'.repeat(60)}`);
  console.log('📊 Summary:');
  console.log(`   Mode:             ${modeLabel}`);
  if (searchMode === 'route') console.log(`   Search route:     ${searchTerm}`);
  if (searchMode === 'movil') console.log(`   Search móvil:     ${searchTerm}`);
  console.log(`   Source:           ${catalogPath ? 'catalog file' : 'API discovery'}`);
  console.log(`   Scanned at:       ${new Date(result.scannedAt).toISOString()}`);
  console.log(`   Total routes:     ${result.totalRoutes}`);
  console.log(`   Processed:        ${result.routesProcessed}`);
  console.log(`   With buses:       ${result.routesWithBuses}`);
  console.log(`   Failed:           ${result.routesFailed}`);
  console.log(`   Unique moviles:   ${result.totalUniqueBuses}`);
  console.log(`     ├ Troncales:    ${troncalBuses}`);
  console.log(`     └ TransMiZonal: ${zonalBuses}`);
  console.log(`   With labels:      ${busesWithLabels}`);
  console.log(`   Output:           ${outputPath}`);

  if (searchMode === 'movil' && searchTerm && result.buses.length > 0) {
    console.log(`\n🔎 Móvil "${searchTerm}" encontrado en:`);
    for (const bus of result.buses) {
      console.log(`   ${bus.label} → ruta ${bus.routeCode} (${bus.routeName}) @ ${bus.latitude}, ${bus.longitude}`);
    }
  }

  if (result.routesFailed > 0) {
    const errorKeys = Object.keys(result.errors);
    console.log(`\n⚠️  ${result.routesFailed} route(s) still failed after retry:`);
    for (const key of errorKeys.slice(0, 10)) {
      console.log(`   - ${key}: ${result.errors[key]}`);
    }
    if (errorKeys.length > 10) {
      console.log(`   ... and ${errorKeys.length - 10} more`);
    }
  }

  console.log(`${'═'.repeat(60)}\n`);

  httpsAgent.destroy();
}

main().catch((err) => {
  console.error('❌ Fatal error:', err.message);
  httpsAgent.destroy();
  process.exit(1);
});
