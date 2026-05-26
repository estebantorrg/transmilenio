/**
 * TransMilenio Mobile App API Client & Scraper
 *
 * Fetches station/wagon/route data directly from the official TransMi app API.
 * Builds a master catalog keyed by station code → wagon label → routes.
 */

import https from 'https';
import http from 'http';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import zlib from 'zlib';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CATALOG_FILE = path.resolve(__dirname, '../data/master_catalog.json');

// ─── API Configuration ──────────────────────────────────

const API_HOST = 'api.buscador-rutas.transmilenio.gov.co';
const API_BASE = '/loader.php';
const HEADERS = {
  'Accept-Encoding': 'gzip',
  'Connection': 'Keep-Alive',
  'Host': API_HOST,
  'User-Agent': 'okhttp/4.12.0',
  'uuid': 'fd1be953-d85e-4c63-8c23-234f143f445d',
  'version': '2.9.5',
};

const MIN_DELAY_MS = 800;
const MAX_DELAY_MS = 1500;
const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 3000;
const STALE_DAYS = 7;
const ROUTE_SEARCH_SEEDS = ['', ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'];

// ─── Types ──────────────────────────────────────────────

export interface CatalogRoute {
  id?: string;
  codigo: string;
  nombre: string;
  color: string;
  sistema?: string;
  tipoServicio?: string;
  horarios?: { data?: Array<{ convencion: string; hora_inicio: string; hora_fin: string }> };
}

export interface CatalogWagons {
  [wagonLabel: string]: CatalogRoute[];
}

export interface CatalogStation {
  id: string;
  codigo: string;
  nombre: string;
  direccion: string;
  coordenada: string;
  sistema?: string;
  tipoServicio?: string;
  wagons: CatalogWagons;
}

export interface CatalogRouteDetail {
  id: string;
  codigo: string;
  nombre: string;
  color: string;
  sistema: string;
  tipoServicio: string;
  horarios?: CatalogRoute['horarios'];
  stops: Array<{
    nombre: string;
    codigo: string;
    coordenada: string;
    posicion: number;
  }>;
  trazado?: number[][];
}

export interface MasterCatalog {
  stations: { [stationCode: string]: CatalogStation };
  routes: { [routeCode: string]: CatalogRouteDetail[] };
}

interface ApiRouteListItem {
  id: string;
  codigo: string;
  nombre: string;
  color: string;
  sistema: string;
  tipoServicio: string;
}

interface ApiRecorridoStop {
  id: string;
  codigo: string;
  nombre: string;
  direccion: string;
  coordenada: string;
  sistema: string;
  tipoServicio: string;
  vagon: string;
  parada: string;
  posicion: number;
}

// ─── HTTP Client ────────────────────────────────────────

function randomDelay(): Promise<void> {
  const ms = Math.floor(Math.random() * (MAX_DELAY_MS - MIN_DELAY_MS + 1)) + MIN_DELAY_MS;
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fetchApi(params: Record<string, string>): Promise<any> {
  const query = new URLSearchParams(params).toString();
  const apiPath = `${API_BASE}?${query}`;

  return new Promise((resolve, reject) => {
    const req = https.get(
      {
        hostname: API_HOST,
        path: apiPath,
        headers: HEADERS,
        timeout: 15000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const raw = Buffer.concat(chunks);
          const encoding = res.headers['content-encoding'];

          const parse = (buf: Buffer) => {
            const text = buf.toString('utf-8');
            try {
              return JSON.parse(text);
            } catch {
              console.error(`[TM API] JSON parse error. Status: ${res.statusCode}. Body: ${text.slice(0, 200)}`);
              return null;
            }
          };

          if (encoding === 'gzip') {
            zlib.gunzip(raw, (err, decompressed) => {
              if (err) {
                // Try parsing raw in case it's not actually gzipped
                resolve(parse(raw));
              } else {
                resolve(parse(decompressed));
              }
            });
          } else {
            resolve(parse(raw));
          }
        });
      }
    );

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timed out'));
    });
  });
}

async function fetchWithRetry(params: Record<string, string>, label: string): Promise<any> {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const result = await fetchApi(params);
      if (result !== null) return result;
      throw new Error('Null response');
    } catch (err: any) {
      const isLast = attempt === MAX_RETRIES;
      const backoff = RETRY_BASE_DELAY_MS * attempt;
      console.warn(
        `[TM API] ${label} attempt ${attempt}/${MAX_RETRIES} failed: ${err.message}` +
          (isLast ? '' : ` — retrying in ${backoff}ms`)
      );
      if (isLast) throw err;
      await new Promise((r) => setTimeout(r, backoff));
    }
  }
}

// ─── API Endpoints ──────────────────────────────────────

async function searchRoutesByTerm(search: string): Promise<ApiRouteListItem[]> {
  const data = await fetchWithRetry(
    {
      lServicio: 'Rutas',
      lTipo: 'api',
      lFuncion: 'searchRutaByTipo',
      tipo_ruta: 'TIPORUTA',
      search,
    },
    `searchRoutes(${search || 'empty'})`
  );

  return data?.lista_rutas ?? [];
}

async function searchAllRoutes(): Promise<ApiRouteListItem[]> {
  const routesById = new Map<string, ApiRouteListItem>();

  for (const seed of ROUTE_SEARCH_SEEDS) {
    const routes = await searchRoutesByTerm(seed);
    routes.forEach((route) => routesById.set(route.id, route));
  }

  return Array.from(routesById.values());
}

export async function getRouteInfo(
  idRuta: string,
  nombre: string,
  codigo: string
): Promise<{ 
  recorrido: ApiRecorridoStop[]; 
  color: string; 
  horarios?: CatalogRoute['horarios']; 
  sistema?: string; 
  tipoServicio?: string;
  trazado?: number[][];
}> {
  const data = await fetchWithRetry(
    {
      lServicio: 'Rutas',
      lTipo: 'api',
      lFuncion: 'infoRuta',
      idRuta,
      nombre,
      codigo,
    },
    `infoRuta(${codigo})`
  );

  const stops: ApiRecorridoStop[] = data?.recorrido?.data ?? [];
  const color: string = data?.['0']?.color ?? '';
  
  let trazadoCoords: number[][] | undefined;
  const rawTrazado = data?.['0']?.trazado;
  if (rawTrazado && typeof rawTrazado === 'string') {
    try {
      const parsed = JSON.parse(rawTrazado);
      if (parsed.type === 'LineString' && Array.isArray(parsed.coordinates)) {
        trazadoCoords = parsed.coordinates;
      } else if (parsed.type === 'MultiLineString' && Array.isArray(parsed.coordinates)) {
        // Flatten MultiLineString into a single LineString for the map highlight
        trazadoCoords = parsed.coordinates.flat();
      }
    } catch (e) {
      console.warn(`[TM API] Failed to parse trazado JSON for ${codigo}`);
    }
  }

  return {
    recorrido: stops,
    color,
    horarios: data?.['0']?.horarios,
    sistema: data?.['0']?.sistema,
    tipoServicio: data?.['0']?.tipoServicio,
    trazado: trazadoCoords,
  };
}

// ─── In-Memory Catalog ──────────────────────────────────

let masterCatalog: MasterCatalog = { stations: {}, routes: {} };
let masterCatalogLight: any = null;
let catalogLoadedAt: number = 0;

export function getCatalogFilePath(): string {
  return CATALOG_FILE;
}

async function writeCatalogAtomically(catalog: MasterCatalog): Promise<void> {
  await fs.mkdir(path.dirname(CATALOG_FILE), { recursive: true });
  const tempFile = `${CATALOG_FILE}.${process.pid}.${Date.now()}.tmp`;

  try {
    await fs.writeFile(tempFile, JSON.stringify(catalog), 'utf-8');
    await fs.rename(tempFile, CATALOG_FILE);
  } catch (error) {
    await fs.rm(tempFile, { force: true }).catch(() => {});
    throw error;
  }
}

export async function loadCatalogFromDisk(): Promise<void> {
  try {
    const [raw, stats] = await Promise.all([
      fs.readFile(CATALOG_FILE, 'utf-8'),
      fs.stat(CATALOG_FILE),
    ]);
    const parsed = JSON.parse(raw);
    
    // Support both the legacy flat format and the current wrapped format
    if (parsed.stations && typeof parsed.stations === 'object') {
      masterCatalog = parsed;
    } else {
      console.log('[TM API] Legacy flat catalog detected. Migrating to wrapped format...');
      masterCatalog = { stations: parsed, routes: {} };
    }

    catalogLoadedAt = stats.mtimeMs;
    masterCatalogLight = null; // Clear light catalog cache!

    const stationCount = Object.keys(masterCatalog.stations || {}).length;
    const totalRoutes = Object.values(masterCatalog.stations || {}).reduce((sum, s) => {
      return sum + Object.values(s.wagons).reduce((ws, routes) => ws + routes.length, 0);
    }, 0);
    console.log(
      `[TM API] Loaded master catalog: ${stationCount} stations, ${totalRoutes} route-wagon mappings, ${Object.keys(masterCatalog.routes || {}).length} routes`
    );
  } catch (err: any) {
    console.log(`[TM API] No master catalog on disk (${err.message}). Run sync to generate.`);
  }
}

export function getCatalog(): MasterCatalog {
  return masterCatalog;
}

export function getCatalogLight(): any {
  if (masterCatalogLight) return masterCatalogLight;

  console.log('[TM API] Generating lightweight master catalog...');
  const cleanStations: Record<string, any> = {};
  for (const [code, station] of Object.entries(masterCatalog.stations || {})) {
    const isTroncal = /^TM\d+$/i.test(station.codigo);
    const cleanWagons: Record<string, any[]> = {};
    for (const [wagon, routes] of Object.entries(station.wagons || {})) {
      cleanWagons[wagon] = routes.map((r: any) => {
        if (isTroncal) {
          return {
            id: r.id,
            codigo: r.codigo,
            nombre: r.nombre,
            color: r.color,
            sistema: r.sistema,
            tipoServicio: r.tipoServicio,
            horarios: r.horarios,
          };
        } else {
          return {
            codigo: r.codigo,
            color: r.color,
          };
        }
      });
    }

    if (isTroncal) {
      cleanStations[code] = {
        id: station.id,
        codigo: station.codigo,
        nombre: station.nombre,
        direccion: station.direccion,
        coordenada: station.coordenada,
        sistema: station.sistema,
        tipoServicio: station.tipoServicio,
        wagons: cleanWagons,
      };
    } else {
      cleanStations[code] = {
        codigo: station.codigo,
        nombre: station.nombre,
        coordenada: station.coordenada,
        wagons: cleanWagons,
      };
    }
  }

  const cleanRoutes: Record<string, any[]> = {};
  for (const [code, variants] of Object.entries(masterCatalog.routes || {})) {
    cleanRoutes[code] = variants.map((route: any) => {
      const origin = route.stops?.[0]?.nombre || '';
      const destination = route.stops?.[route.stops.length - 1]?.nombre || '';
      return {
        id: route.id,
        codigo: route.codigo,
        nombre: route.nombre,
        color: route.color,
        sistema: route.sistema,
        tipoServicio: route.tipoServicio,
        horarios: route.horarios,
        origin,
        destination,
      };
    });
  }

  masterCatalogLight = {
    stations: cleanStations,
    routes: cleanRoutes,
  };

  return masterCatalogLight;
}

export function getStationByCode(code: string): CatalogStation | null {
  return (masterCatalog.stations && masterCatalog.stations[code]) ?? null;
}

export function isCatalogStale(): boolean {
  if (!masterCatalog.stations || Object.keys(masterCatalog.stations).length === 0) return true;
  if (catalogLoadedAt === 0) return true;
  return Date.now() - catalogLoadedAt > STALE_DAYS * 24 * 60 * 60 * 1000;
}

// ─── Master Sync ────────────────────────────────────────

let syncInProgress = false;

export async function syncMasterCatalog(): Promise<void> {
  if (syncInProgress) {
    console.log('[TM API] Sync already in progress, skipping.');
    return;
  }

  syncInProgress = true;
  console.log('[TM API] ═══ Starting Master Catalog Sync ═══');

  try {
    // 1. Get all routes
    const allRoutes = await searchAllRoutes();
    const catalogRoutes = allRoutes.filter(
      (r) =>
        r.sistema === 'TransMilenio' ||
        r.sistema === 'TransMiZonal' ||
        r.tipoServicio === 'TRONCAL' ||
        r.tipoServicio === 'TransMilenio' ||
        r.tipoServicio === 'TransMiZonal' ||
        r.tipoServicio === 'PADRON'
    );

    console.log(
      `[TM API] Found ${allRoutes.length} total routes, ${catalogRoutes.length} app routes to index.`
    );

    const newCatalog: MasterCatalog = { stations: {}, routes: {} };
    let processed = 0;
    let errors = 0;

    // 2. Fetch each route detail
    for (const route of catalogRoutes) {
      processed++;
      const progress = `${processed}/${catalogRoutes.length}`;

      try {
        const { recorrido, color, horarios, sistema, tipoServicio, trazado } = await getRouteInfo(route.id, route.nombre, route.codigo);
        const routeColor = color || route.color || '#64748B';

        if (!recorrido || recorrido.length === 0) {
          console.log(`[TM API] [${progress}] ${route.codigo} — no stops`);
          errors++;
        } else {
          let stopsAdded = 0;

          for (const stop of recorrido) {
            const stationCode = stop.codigo;
            if (!stationCode || stationCode.length === 0) continue;

            // Wagon label from the API
            const wagonLabel = stop.vagon || '0';

            // Initialize station if needed
            if (!newCatalog.stations[stationCode]) {
              newCatalog.stations[stationCode] = {
                id: stop.id,
                codigo: stationCode,
                nombre: stop.nombre,
                direccion: stop.direccion,
                coordenada: stop.coordenada,
                sistema: stop.sistema,
                tipoServicio: stop.tipoServicio,
                wagons: {},
              };
            }

            // Initialize wagon array if needed
            if (!newCatalog.stations[stationCode].wagons[wagonLabel]) {
              newCatalog.stations[stationCode].wagons[wagonLabel] = [];
            }
            
            // Add route if not already present (prevent duplicates)
            const exists = newCatalog.stations[stationCode].wagons[wagonLabel].some(
              (r) => (r.id && r.id === route.id) || (!r.id && r.codigo === route.codigo && r.nombre === route.nombre)
            );
            if (!exists) {
              newCatalog.stations[stationCode].wagons[wagonLabel].push({
                id: route.id,
                codigo: route.codigo,
                nombre: route.nombre,
                color: routeColor,
                sistema: sistema || route.sistema,
                tipoServicio: tipoServicio || route.tipoServicio,
                horarios,
              });
              stopsAdded++;
            }
          }

          // 2.2 Add to global route collection
          if (!newCatalog.routes[route.codigo]) {
            newCatalog.routes[route.codigo] = [];
          }
          
          newCatalog.routes[route.codigo].push({
            id: route.id,
            codigo: route.codigo,
            nombre: route.nombre,
            color: routeColor,
            sistema: sistema || route.sistema,
            tipoServicio: tipoServicio || route.tipoServicio,
            horarios,
            stops: recorrido.map(s => ({
              nombre: s.nombre,
              codigo: s.codigo,
              coordenada: s.coordenada,
              posicion: s.posicion
            })),
            trazado
          });

          console.log(
            `[TM API] [${progress}] ${route.codigo} (${route.nombre}) — ${recorrido.length} stops, ${stopsAdded} new mappings`
          );
        }
      } catch (err: any) {
        errors++;
        console.error(`[TM API] [${progress}] FAILED ${route.codigo}: ${err.message}`);
      }

      // Rate limit
      await randomDelay();
    }

    // 3. Save to disk, then publish in memory once the file is complete.
    await writeCatalogAtomically(newCatalog);
    masterCatalog = newCatalog;
    masterCatalogLight = null; // Clear light catalog cache!
    catalogLoadedAt = Date.now();

    const stationCount = Object.keys(masterCatalog.stations).length;
    const totalRoutes = Object.values(masterCatalog.stations).reduce((sum, s) => {
      return sum + Object.values(s.wagons).reduce((ws, routes) => ws + routes.length, 0);
    }, 0);

    console.log(
      `[TM API] ═══ Sync Complete! ${stationCount} stations, ${totalRoutes} mappings, ${errors} errors ═══`
    );
  } finally {
    syncInProgress = false;
  }
}

export function isSyncInProgress(): boolean {
  return syncInProgress;
}

const LIVE_API_HOST = 'tmsa-transmiapp-shvpc.uc.r.appspot.com';
const LIVE_API_ORIGIN = `https://${LIVE_API_HOST}`;
const LIVE_API_DIRECT_ORIGIN = `http://${LIVE_API_HOST}`;
export const LIVE_TRACKING_VERSION = 'http-direct-v2';
const LIVE_REQUEST_TIMEOUT_MS = 9_000;
const LIVE_DIRECT_ATTEMPTS = 2;
const EXTERNAL_PROXY_TIMEOUT_MS = 12_000;
const CO_PROXY_READY_TIMEOUT_MS = 18_000;
const MAX_CO_PROXY_ATTEMPTS = 8;
const DEFAULT_COLOMBIAN_CLIENT_IP = '181.50.0.1';
const DEFAULT_GAS_PROXY_URL = 'https://script.google.com/macros/s/AKfycbz6GPL2AKiOLcGzDPx5YR_LLGnDxU21p50PAzCpo_plRLfJHx1pWHYZMSjIa92JWsaH8w/exec';

interface LiveRequestContext {
  routeCode: string;
  destinationName: string;
  routeType: 'troncal' | 'zonal';
  isZonal: boolean;
  targetPath: string;
  postData: string;
  candidateName: string;
}

function isLiveBusLike(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;

  const bus = value as { latitude?: unknown; longitude?: unknown; lat?: unknown; lng?: unknown; lon?: unknown };
  return Number.isFinite(Number(bus.latitude ?? bus.lat)) &&
    Number.isFinite(Number(bus.longitude ?? bus.lng ?? bus.lon));
}

function normalizeLiveBusesPayload(payload: any): any[] {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];

  const candidates = [
    payload.data,
    payload.buses,
    payload.result,
    payload.results,
    payload.vehiculos,
    payload.vehicles,
  ];

  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate;
  }

  for (const candidate of candidates) {
    if (candidate && typeof candidate === 'object') {
      const nestedValues = Object.values(candidate);
      const nestedBuses = nestedValues.filter(isLiveBusLike);
      if (nestedBuses.length > 0) return nestedBuses;
    }
  }

  const values = Object.values(payload);
  const buses = values.filter(isLiveBusLike);
  return buses.length > 0 ? buses : [];
}

function createLiveRequestContext(
  ruta: string,
  nombre: string,
  routeType: 'troncal' | 'zonal' = 'troncal',
  candidateName = nombre
): LiveRequestContext {
  const routeCode = String(ruta || '').trim();
  const destinationName = String(candidateName || nombre || '').trim();
  const isZonal = routeType === 'zonal';

  return {
    routeCode,
    destinationName,
    routeType,
    isZonal,
    targetPath: isZonal
      ? `/location/ruta?ruta=${encodeURIComponent(routeCode)}`
      : '/buses',
    postData: isZonal ? '' : JSON.stringify({ ruta: routeCode, Nombre: destinationName }),
    candidateName: destinationName,
  };
}

function addUniqueLiveName(candidates: string[], value: unknown): void {
  const text = String(value || '').trim();
  if (!text) return;

  const parts = text.split(/\s+[-–—]\s+/).map((part) => part.trim()).filter(Boolean);
  for (const part of parts.length > 1 ? [...parts].reverse() : parts) {
    const clean = part.trim();
    if (clean && !candidates.some((candidate) => candidate.toLowerCase() === clean.toLowerCase())) {
      candidates.push(clean);
    }
  }

  if (!candidates.some((candidate) => candidate.toLowerCase() === text.toLowerCase())) {
    candidates.push(text);
  }
}

function buildLiveNameCandidates(nombre: string, nombreCandidates: string[] = []): string[] {
  const candidates: string[] = [];
  for (const candidate of nombreCandidates) addUniqueLiveName(candidates, candidate);
  addUniqueLiveName(candidates, nombre);
  return candidates.length > 0 ? candidates : [String(nombre || '').trim()];
}

function getConfiguredExternalProxyUrls(): string[] {
  const urls = [
    process.env.TRANSMILENIO_LIVE_PROXY_URL,
    process.env.TRANSMILENIO_GAS_PROXY_URL,
    DEFAULT_GAS_PROXY_URL,
  ];

  return Array.from(new Set(urls
    .map((url) => String(url || '').trim())
    .filter(Boolean)
    .filter((url) => {
      try {
        return new URL(url).hostname !== LIVE_API_HOST;
      } catch {
        console.warn(`[TM API] Ignoring invalid live proxy URL: ${url}`);
        return false;
      }
    })));
}

function getColombianClientIp(): string {
  return String(process.env.TRANSMILENIO_COLOMBIA_CLIENT_IP || DEFAULT_COLOMBIAN_CLIENT_IP).trim();
}

function addColombianForwardingHeaders(headers: Record<string, string | number>): void {
  const clientIp = getColombianClientIp();
  headers['X-Forwarded-For'] = clientIp;
  headers['X-Real-IP'] = clientIp;
  headers['Forwarded'] = `for=${clientIp}`;
}

function decodeBody(raw: Buffer, encoding: string | string[] | undefined): Promise<Buffer> {
  const contentEncoding = Array.isArray(encoding) ? encoding.join(',') : encoding || '';
  if (!contentEncoding.toLowerCase().includes('gzip')) return Promise.resolve(raw);

  return new Promise((resolve, reject) => {
    zlib.gunzip(raw, (err, decompressed) => {
      if (err) reject(err);
      else resolve(decompressed);
    });
  });
}

async function parseLiveResponse(raw: Buffer, encoding: string | string[] | undefined, source: string): Promise<any[]> {
  const body = await decodeBody(raw, encoding).catch(() => raw);
  const text = body.toString('utf-8');

  let payload: any;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(`${source}: Live Buses JSON parse error (${text.slice(0, 120)})`);
  }

  if (payload?.success === false) {
    throw new Error(`${source}: ${payload.error || 'Proxy returned success=false'}`);
  }

  const problemStatus = Number(payload?.status);
  if (Number.isFinite(problemStatus) && problemStatus >= 400) {
    throw new Error(`${source}: Status: ${problemStatus} ${payload.title || payload.detail || ''}`.trim());
  }

  return normalizeLiveBusesPayload(payload);
}

function requestLiveJson(
  url: URL,
  headers: Record<string, string | number>,
  postData: string,
  timeoutMs: number,
  agent?: https.Agent
): Promise<any[]> {
  const requestLib = url.protocol === 'http:' ? http : https;
  const source = `${url.protocol}//${url.hostname}${url.pathname}`;

  return new Promise((resolve, reject) => {
    const req = requestLib.request({
      hostname: url.hostname,
      port: url.port || (url.protocol === 'http:' ? 80 : 443),
      path: `${url.pathname}${url.search}`,
      method: 'POST',
      headers,
      agent,
      timeout: timeoutMs,
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', async () => {
        const raw = Buffer.concat(chunks);

        if (res.statusCode !== 200) {
          reject(new Error(`${source}: Status: ${res.statusCode}`));
          return;
        }

        try {
          resolve(await parseLiveResponse(raw, res.headers['content-encoding'], source));
        } catch (error) {
          reject(error);
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`${source}: Request timed out`));
    });

    if (postData) req.write(postData);
    req.end();
  });
}

function buildExternalProxyRequestUrl(baseUrl: string, context: LiveRequestContext): URL {
  const url = new URL(baseUrl);
  const isGoogleAppsScript = url.hostname === 'script.google.com' && url.pathname.endsWith('/exec');
  if (isGoogleAppsScript) return url;

  const trimmedPath = url.pathname.replace(/\/$/, '');
  const alreadyTargetsLiveApi = trimmedPath.endsWith('/buses') || trimmedPath.includes('/location/ruta');
  if (!alreadyTargetsLiveApi) {
    url.pathname = `${trimmedPath}${context.isZonal ? '/location/ruta' : '/buses'}`.replace(/\/{2,}/g, '/');
  }

  if (context.isZonal) {
    url.searchParams.set('ruta', context.routeCode);
  }

  return url;
}

function buildExternalProxyBody(baseUrl: string, context: LiveRequestContext): string {
  const url = new URL(baseUrl);
  const isGoogleAppsScript = url.hostname === 'script.google.com' && url.pathname.endsWith('/exec');

  if (isGoogleAppsScript) {
    return JSON.stringify({
      action: context.isZonal ? 'zonal' : 'troncal',
      ruta: context.routeCode,
      nombre: context.destinationName,
      Nombre: context.destinationName,
      type: context.routeType,
    });
  }

  return context.isZonal ? '' : context.postData;
}

async function fetchLiveBusesViaExternalProxy(context: LiveRequestContext): Promise<any[]> {
  const proxyUrls = getConfiguredExternalProxyUrls();
  let lastError: Error | null = null;

  for (const baseUrl of proxyUrls) {
    try {
      const url = buildExternalProxyRequestUrl(baseUrl, context);
      const postData = buildExternalProxyBody(baseUrl, context);
      const headers: Record<string, string | number> = {
        'Accept-Encoding': 'identity',
        'Appid': '9a2c3b48f0c24ae9bfba38e94f27c3ea',
        'User-Agent': 'okhttp/4.12.0',
        'uuid': 'fd1be953-d85e-4c63-8c23-234f143f445d',
        'version': '2.9.5',
        'Content-Length': Buffer.byteLength(postData),
      };
      addColombianForwardingHeaders(headers);

      if (postData) {
        headers['Content-Type'] = 'application/json; charset=UTF-8';
      }

      console.log(`[TM API] Trying configured live proxy ${url.href}`);
      return await requestLiveJson(url, headers, postData, EXTERNAL_PROXY_TIMEOUT_MS);
    } catch (error: any) {
      lastError = error;
      console.warn(`[TM API] Configured live proxy failed: ${error.message}`);
    }
  }

  throw lastError ?? new Error('No configured live proxy URL');
}

async function fetchLiveBusesFromTransmiApp(context: LiveRequestContext): Promise<any[]> {
  const url = new URL(`${LIVE_API_DIRECT_ORIGIN}${context.targetPath}`);
  const postData = context.postData;
  const headers: Record<string, string | number> = {
    'Accept-Encoding': 'identity',
    'Appid': '9a2c3b48f0c24ae9bfba38e94f27c3ea',
    'Connection': 'Keep-Alive',
    'Host': LIVE_API_HOST,
    'User-Agent': 'okhttp/4.12.0',
    'uuid': 'fd1be953-d85e-4c63-8c23-234f143f445d',
    'version': '2.9.5',
    'Content-Length': Buffer.byteLength(postData),
  };
  addColombianForwardingHeaders(headers);

  if (postData) {
    headers['Content-Type'] = 'application/json; charset=UTF-8';
  }

  console.log(`[TM API] fetchLiveBuses: type=${context.routeType} ruta=${context.routeCode} nombre=${context.destinationName} via=direct+xff`);

  return requestLiveJson(url, headers, postData, LIVE_REQUEST_TIMEOUT_MS);
}

async function fetchLiveBusesViaColombianProxy(context: LiveRequestContext): Promise<any[]> {
  const { ProxyManager, SimpleProxyAgent } = await import('./proxy_manager.js');
  const readyCount = await ProxyManager.waitForReady(CO_PROXY_READY_TIMEOUT_MS);
  if (readyCount === 0) {
    throw new Error('No Colombian proxy available');
  }

  const attempts = Math.min(Math.max(readyCount, 1), MAX_CO_PROXY_ATTEMPTS);
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    const proxy = ProxyManager.getWorkingProxy();
    if (!proxy) break;

    try {
      const url = new URL(`${LIVE_API_ORIGIN}${context.targetPath}`);
      const postData = context.postData;
      const headers: Record<string, string | number> = {
        'Accept-Encoding': 'identity',
        'Appid': '9a2c3b48f0c24ae9bfba38e94f27c3ea',
        'Connection': 'Keep-Alive',
        'Host': LIVE_API_HOST,
        'User-Agent': 'okhttp/4.12.0',
        'uuid': 'fd1be953-d85e-4c63-8c23-234f143f445d',
        'version': '2.9.5',
        'Content-Length': Buffer.byteLength(postData),
      };
      if (postData) {
        headers['Content-Type'] = 'application/json; charset=UTF-8';
      }

      console.log(`[TM API] fetchLiveBuses: type=${context.routeType} ruta=${context.routeCode} nombre=${context.destinationName} via=CO proxy ${proxy.ip}:${proxy.port}`);
      return await requestLiveJson(url, headers, postData, LIVE_REQUEST_TIMEOUT_MS, new SimpleProxyAgent(proxy.ip, proxy.port));
    } catch (error: any) {
      lastError = error;
      ProxyManager.reportFailure(proxy.ip, proxy.port);
      console.warn(`[TM API] CO proxy attempt ${attempt}/${attempts} failed: ${error.message}`);
    }
  }

  throw lastError ?? new Error('No Colombian proxy responded');
}

export async function fetchLiveBuses(
  ruta: string,
  nombre: string,
  routeType: 'troncal' | 'zonal' = 'troncal',
  nombreCandidates: string[] = []
): Promise<any[]> {
  const contexts = routeType === 'zonal'
    ? [createLiveRequestContext(ruta, nombre, routeType)]
    : buildLiveNameCandidates(nombre, nombreCandidates)
        .map((candidate) => createLiveRequestContext(ruta, nombre, routeType, candidate));
  const primaryContext = contexts[0];
  const errors: string[] = [];

  if (!primaryContext?.routeCode) {
    throw new Error('ruta is required');
  }

  for (const context of contexts) {
    for (let attempt = 1; attempt <= LIVE_DIRECT_ATTEMPTS; attempt++) {
      try {
        const buses = await fetchLiveBusesFromTransmiApp(context);
        console.log(`[TM API] Live candidate "${context.candidateName}" succeeded with ${buses.length} buses`);
        return buses;
      } catch (error: any) {
        errors.push(`[direct ${context.candidateName} #${attempt}] ${error.message}`);
      }
    }
  }

  if (getConfiguredExternalProxyUrls().length > 0) {
    for (const context of contexts) {
      try {
        const buses = await fetchLiveBusesViaExternalProxy(context);
        console.log(`[TM API] Live proxy candidate "${context.candidateName}" succeeded with ${buses.length} buses`);
        return buses;
      } catch (error: any) {
        errors.push(`[external ${context.candidateName}] ${error.message}`);
      }
    }
  }

  for (const context of contexts) {
    try {
      const buses = await fetchLiveBusesViaColombianProxy(context);
      console.log(`[TM API] CO proxy candidate "${context.candidateName}" succeeded with ${buses.length} buses`);
      return buses;
    } catch (error: any) {
      errors.push(`[co-proxy ${context.candidateName}] ${error.message}`);
    }
  }

  throw new Error(`Live tracking unavailable: ${errors.join(' | ')}`);
}
