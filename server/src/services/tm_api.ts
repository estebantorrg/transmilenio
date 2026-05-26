/**
 * TransMilenio Mobile App API Client & Scraper
 *
 * Fetches station/wagon/route data directly from the official TransMi app API.
 * Builds a master catalog keyed by station code → wagon label → routes.
 */

import https from 'https';
import http from 'http';
import tls from 'tls';
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

function isLiveBusLike(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;

  const bus = value as { latitude?: unknown; longitude?: unknown };
  return Number.isFinite(Number(bus.latitude)) && Number.isFinite(Number(bus.longitude));
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

export async function fetchLiveBuses(ruta: string, nombre: string, routeType: 'troncal' | 'zonal' = 'troncal'): Promise<any[]> {
  const routeCode = String(ruta || '').trim();
  const destinationName = String(nombre || '').trim();

  const isZonal = routeType === 'zonal';
  const postData = isZonal ? '' : JSON.stringify({ ruta: routeCode, Nombre: destinationName });

  const apiBaseUrl = process.env.TRANSMILENIO_API_URL || 'https://tmsa-transmiapp-shvpc.uc.r.appspot.com';
  const apiURL = new URL(apiBaseUrl);

  const headers: Record<string, string | number> = {
    'Accept-Encoding': 'gzip',
    'Appid': '9a2c3b48f0c24ae9bfba38e94f27c3ea',
    'Connection': 'Keep-Alive',
    'Host': apiURL.hostname,
    'User-Agent': 'okhttp/4.12.0',
    'uuid': 'fd1be953-d85e-4c63-8c23-234f143f445d',
    'version': '2.9.5',
  };

  if (!isZonal) {
    headers['Content-Type'] = 'application/json; charset=UTF-8';
    headers['Content-Length'] = Buffer.byteLength(postData);
  } else {
    headers['Content-Length'] = 0;
  }

  const options = {
    hostname: apiURL.hostname,
    port: apiURL.port || (apiURL.protocol === 'https:' ? 443 : 80),
    path: isZonal 
      ? `${apiURL.pathname === '/' ? '' : apiURL.pathname}/location/ruta?ruta=${encodeURIComponent(routeCode)}` 
      : `${apiURL.pathname === '/' ? '' : apiURL.pathname}/buses`,
    method: 'POST',
    headers,
    timeout: 25000,
  };

  console.log(`[TM API] fetchLiveBuses: type=${routeType} ruta=${routeCode} nombre=${destinationName} path=${options.path} via=${apiBaseUrl}`);

  const requestLib = apiURL.protocol === 'https:' ? https : http;

  return new Promise((resolve, reject) => {
    const req = requestLib.request(options, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`Status: ${res.statusCode}`));
        return;
      }

      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks);
        const encoding = res.headers['content-encoding'];

        const parse = (buf: Buffer): any[] => {
          const text = buf.toString('utf-8');
          try {
            return normalizeLiveBusesPayload(JSON.parse(text));
          } catch {
            throw new Error('Live Buses JSON parse error');
          }
        };

        if (encoding === 'gzip') {
          zlib.gunzip(raw, (err, decompressed) => {
            if (err) {
              try {
                resolve(parse(raw));
              } catch (parseErr) {
                reject(parseErr);
              }
            } else {
              try {
                resolve(parse(decompressed));
              } catch (parseErr) {
                reject(parseErr);
              }
            }
          });
        } else {
          try {
            resolve(parse(raw));
          } catch (parseErr) {
            reject(parseErr);
          }
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timed out'));
    });

    if (postData) {
      req.write(postData);
    }
    req.end();
  });
}
