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
const LIGHT_TRACE_MAX_POINTS = 160;

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
  origin?: string;
  destination?: string;
  stops?: Array<{
    nombre: string;
    codigo: string;
    coordenada: string;
    posicion: number;
    direccion?: string;
  }>;
  trazado?: RouteTrace;
}

export interface MasterCatalog {
  stations: { [stationCode: string]: CatalogStation };
  routes: { [routeCode: string]: CatalogRouteDetail[] };
  /** Epoch ms of the last successful sync. Drives content-based staleness so
   *  the catalog keeps refreshing in production, where each deploy is a fresh
   *  checkout and the file mtime would otherwise always look "new". */
  syncedAt?: number;
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

type RouteTrace = number[][] | number[][][];

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
    // Spec §5.1.3: random 800–1500ms delay between every upstream call.
    await randomDelay();
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
  trazado?: RouteTrace;
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
  
  let trazadoCoords: RouteTrace | undefined;
  const rawTrazado = data?.['0']?.trazado;
  if (rawTrazado && typeof rawTrazado === 'string') {
    try {
      const parsed = JSON.parse(rawTrazado);
      if (parsed.type === 'LineString' && Array.isArray(parsed.coordinates)) {
        trazadoCoords = parsed.coordinates;
      } else if (parsed.type === 'MultiLineString' && Array.isArray(parsed.coordinates)) {
        trazadoCoords = parsed.coordinates;
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

export function getCatalogLoadedAt(): number {
  return catalogLoadedAt;
}

async function writeCatalogAtomically(catalog: MasterCatalog): Promise<void> {
  await fs.mkdir(path.dirname(CATALOG_FILE), { recursive: true });
  const tempFile = `${CATALOG_FILE}.${process.pid}.${Date.now()}.tmp`;

  try {
    await fs.writeFile(tempFile, JSON.stringify(catalog), 'utf-8');
    await fs.rename(tempFile, CATALOG_FILE);
  } catch (error) {
    try {
      await fs.rm(tempFile, { force: true });
    } catch (cleanupError) {
      console.warn('[TM API] Failed to remove temp catalog file:', cleanupError);
    }
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

    // Prefer the catalog's own sync timestamp; fall back to file mtime for
    // legacy catalogs written before syncedAt existed.
    catalogLoadedAt = typeof parsed.syncedAt === 'number' ? parsed.syncedAt : stats.mtimeMs;
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

function isCoordinatePair(value: unknown): value is number[] {
  return Array.isArray(value) &&
    value.length >= 2 &&
    Number.isFinite(Number(value[0])) &&
    Number.isFinite(Number(value[1]));
}

function traceToPaths(trace: RouteTrace | undefined): number[][][] {
  if (!Array.isArray(trace) || trace.length === 0) return [];

  const first = trace[0];
  if (isCoordinatePair(first)) {
    return [trace as number[][]];
  }

  if (Array.isArray(first) && isCoordinatePair(first[0])) {
    return (trace as number[][][]).filter((path) => Array.isArray(path) && path.length > 1);
  }

  return [];
}

function sampleLine(line: number[][], maxPoints: number): number[][] {
  if (line.length <= maxPoints) return line;

  const sampled: number[][] = [];
  for (let i = 0; i < maxPoints; i++) {
    sampled.push(line[Math.round((i * (line.length - 1)) / (maxPoints - 1))]);
  }
  return sampled;
}

/** Perpendicular distance from point `p` to the infinite line through `a`→`b`. */
function perpendicularDistance(p: number[], a: number[], b: number[]): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const mag = Math.hypot(dx, dy);
  if (mag === 0) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  return Math.abs(dy * p[0] - dx * p[1] + b[0] * a[1] - b[1] * a[0]) / mag;
}

/**
 * Ramer–Douglas–Peucker line simplification. Unlike uniform decimation it
 * keeps the geometrically significant vertices (turns), so the simplified
 * line still follows the streets of the original trace.
 */
function douglasPeucker(points: number[][], epsilon: number): number[][] {
  if (points.length <= 2) return points;

  let maxDist = 0;
  let index = 0;
  const first = points[0];
  const last = points[points.length - 1];
  for (let i = 1; i < points.length - 1; i++) {
    const dist = perpendicularDistance(points[i], first, last);
    if (dist > maxDist) {
      maxDist = dist;
      index = i;
    }
  }

  if (maxDist > epsilon) {
    const left = douglasPeucker(points.slice(0, index + 1), epsilon);
    const right = douglasPeucker(points.slice(index), epsilon);
    return left.slice(0, -1).concat(right);
  }
  return [first, last];
}

// ~0.00005° ≈ 5.5 m at Bogotá's latitude — tight enough to keep every turn.
const TRACE_SIMPLIFY_EPSILON = 0.00005;

/**
 * Simplifies a single line to at most `maxPoints` while preserving its shape.
 * Douglas–Peucker drops only near-collinear points; if a winding line still
 * exceeds the cap we loosen the tolerance rather than blindly decimating.
 */
function simplifyLine(line: number[][], maxPoints: number): number[][] {
  if (line.length <= maxPoints) return line;

  let epsilon = TRACE_SIMPLIFY_EPSILON;
  let result = douglasPeucker(line, epsilon);
  for (let guard = 0; result.length > maxPoints && guard < 24; guard++) {
    epsilon *= 1.6;
    result = douglasPeucker(line, epsilon);
  }
  // Extremely winding lines can still exceed the cap — even-sample the
  // already shape-preserving DP output as a last resort.
  return result.length > maxPoints ? sampleLine(result, maxPoints) : result;
}

function simplifyTraceForLight(trace: RouteTrace | undefined): RouteTrace | undefined {
  const paths = traceToPaths(trace);
  if (paths.length === 0) return undefined;

  if (paths.length === 1) {
    const path = simplifyLine(paths[0], LIGHT_TRACE_MAX_POINTS);
    return path.length > 1 ? path : undefined;
  }

  const maxPerPath = Math.max(2, Math.floor(LIGHT_TRACE_MAX_POINTS / paths.length));
  const simplified = paths
    .map((path) => simplifyLine(path, maxPerPath))
    .filter((path) => path.length > 1);

  return simplified.length > 0 ? simplified : undefined;
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
          // Keep id + nombre even for non-TM-coded stops: some troncal
          // platforms carry zonal-style codes (e.g. 664A00), and a route's
          // two directions share a codigo but differ by id/nombre. Dropping
          // them collapses both directions into one in the station resolver.
          return {
            id: r.id,
            codigo: r.codigo,
            nombre: r.nombre,
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
        stops: route.stops || [],
        trazado: simplifyTraceForLight(route.trazado),
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

// ─── Catalog Merge ──────────────────────────────────────

function cleanRouteName(name: string | null | undefined): string {
  if (!name) return '';
  return name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/\bCICLOVIA\b/g, '')
    .replace(/[^A-Z0-9]/g, '')
    .trim();
}

function isDuplicateRoute(a: { codigo: string; nombre: string }, b: { codigo: string; nombre: string }): boolean {
  if (a.codigo.toUpperCase().trim() !== b.codigo.toUpperCase().trim()) return false;
  return cleanRouteName(a.nombre) === cleanRouteName(b.nombre);
}

/**
 * Non-destructively merges a freshly fetched catalog over the previous one.
 *
 * The TransMi API is a live snapshot: some services are only listed on certain
 * days (e.g. Ciclovía routes appear on Sundays), and a partial fetch can miss
 * routes. A blind full replace would delete those. So `fresh` is authoritative
 * for everything it returns (updates win by id), and anything present only in
 * `previous` — routes, variants, station-wagon mappings — is retained.
 */
export function mergeCatalogs(previous: MasterCatalog, fresh: MasterCatalog): MasterCatalog {
  const merged: MasterCatalog = {
    stations: { ...fresh.stations },
    routes: { ...fresh.routes },
  };

  // Routes: union by code; within a code, union variants by normalized name (fresh wins).
  for (const [code, oldVariants] of Object.entries(previous.routes || {})) {
    const freshVariants = merged.routes[code];
    if (!freshVariants) {
      merged.routes[code] = oldVariants;
      continue;
    }
    const freshKeys = new Set(freshVariants.map((v) => cleanRouteName(v.nombre)));
    const retained = oldVariants.filter((v) => !freshKeys.has(cleanRouteName(v.nombre)));
    if (retained.length > 0) merged.routes[code] = [...freshVariants, ...retained];
  }

  // Stations: union by code; union wagons; within a wagon, union route refs by normalized code+name.
  for (const [stationCode, oldStation] of Object.entries(previous.stations || {})) {
    const freshStation = merged.stations[stationCode];
    if (!freshStation) {
      merged.stations[stationCode] = oldStation;
      continue;
    }
    const mergedWagons: CatalogStation['wagons'] = { ...freshStation.wagons };
    for (const [wagon, oldRoutes] of Object.entries(oldStation.wagons || {})) {
      const freshRoutes = mergedWagons[wagon];
      if (!freshRoutes) {
        mergedWagons[wagon] = oldRoutes;
        continue;
      }
      const freshKeys = new Set(freshRoutes.map((r) => `${r.codigo.toUpperCase().trim()}|${cleanRouteName(r.nombre)}`));
      const retained = oldRoutes.filter((r) => !freshKeys.has(`${r.codigo.toUpperCase().trim()}|${cleanRouteName(r.nombre)}`));
      if (retained.length > 0) mergedWagons[wagon] = [...freshRoutes, ...retained];
    }
    merged.stations[stationCode] = { ...freshStation, wagons: mergedWagons };
  }

  return merged;
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
              (r) => isDuplicateRoute(r, route)
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
          
          const routeExists = newCatalog.routes[route.codigo].some(
            (r) => cleanRouteName(r.nombre) === cleanRouteName(route.nombre)
          );
          if (!routeExists) {
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
          }

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

    // 3. Merge over the previous catalog so day-dependent services (Ciclovía
    //    routes are only listed on Sundays) and anything a partial fetch missed
    //    survive, then save atomically and publish once the file is complete.
    const merged = mergeCatalogs(masterCatalog, newCatalog);
    merged.syncedAt = Date.now();
    await writeCatalogAtomically(merged);
    masterCatalog = merged;
    masterCatalogLight = null; // Clear light catalog cache!
    catalogLoadedAt = merged.syncedAt;

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
export const LIVE_TRACKING_VERSION = 'colombia-relay-v1';
const LIVE_REQUEST_TIMEOUT_MS = 9_000;
const COLOMBIA_RELAY_TIMEOUT_MS = 12_000;
const CO_PROXY_READY_TIMEOUT_MS = 18_000;
// Free CO proxies run 4.5–14s; be patient and race several so the fastest wins.
const LIVE_PROXY_TIMEOUT_MS = Number(process.env.LIVE_PROXY_TIMEOUT_MS || 14_000);
const CO_PROXY_RACE_WIDTH = Number(process.env.CO_PROXY_RACE_WIDTH || 5);
// If a whole wave of free proxies dies (connection reset / timeout — common),
// fall through to the next-best, non-overlapping wave instead of failing the
// strategy. Bounded so a dead pool can't run past the overall budget (§5.2.5).
const CO_PROXY_MAX_WAVES = Number(process.env.CO_PROXY_MAX_WAVES || 3);
const LIVE_ROUTE_CODE_MAX_LENGTH = 32;
const LIVE_DESTINATION_MAX_LENGTH = 160;
const LIVE_NAME_CANDIDATE_LIMIT = 12;

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

function normalizeLiveText(value: unknown, maxLength: number): string {
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  return String(value).replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function createLiveRequestContext(
  ruta: string,
  nombre: string,
  routeType: 'troncal' | 'zonal' = 'troncal',
  candidateName = nombre
): LiveRequestContext {
  const routeCode = normalizeLiveText(ruta, LIVE_ROUTE_CODE_MAX_LENGTH);
  const destinationName = normalizeLiveText(candidateName || nombre, LIVE_DESTINATION_MAX_LENGTH);
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
  const text = normalizeLiveText(value, LIVE_DESTINATION_MAX_LENGTH);
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
  return (candidates.length > 0 ? candidates : [normalizeLiveText(nombre, LIVE_DESTINATION_MAX_LENGTH)])
    .slice(0, LIVE_NAME_CANDIDATE_LIMIT);
}

function getConfiguredColombiaRelayUrl(): string {
  return String(process.env.TRANSMILENIO_COLOMBIA_RELAY_URL || '').trim();
}

function getColombiaRelaySecret(): string {
  return String(process.env.TRANSMILENIO_COLOMBIA_RELAY_SECRET || '').trim();
}

function allowPublicColombianProxyFallback(): boolean {
  return process.env.TRANSMILENIO_ALLOW_PUBLIC_CO_PROXY === '1';
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
  agent?: https.Agent,
  signal?: AbortSignal
): Promise<any[]> {
  const requestLib = url.protocol === 'http:' ? http : https;
  const source = `${url.protocol}//${url.hostname}${url.pathname}`;

  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error(`${source}: aborted`));
      return;
    }

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
        cleanup();
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

    // Let a parallel race cancel the losers as soon as a winner resolves.
    const onAbort = () => {
      req.destroy(new Error(`${source}: aborted`));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    const cleanup = () => signal?.removeEventListener('abort', onAbort);

    req.on('error', (err) => {
      cleanup();
      reject(err);
    });
    req.on('timeout', () => {
      cleanup();
      req.destroy();
      reject(new Error(`${source}: Request timed out`));
    });

    if (postData) req.write(postData);
    req.end();
  });
}

function buildColombiaRelayRequestUrl(baseUrl: string): URL {
  const url = new URL(baseUrl);
  const trimmedPath = url.pathname.replace(/\/$/, '');
  if (!trimmedPath.endsWith('/buses')) {
    url.pathname = `${trimmedPath}/buses`.replace(/\/{2,}/g, '/');
  }
  return url;
}

function buildColombiaRelayBody(context: LiveRequestContext): string {
  return JSON.stringify({
    action: context.isZonal ? 'zonal' : 'troncal',
    ruta: context.routeCode,
    nombre: context.destinationName,
    Nombre: context.destinationName,
    type: context.routeType,
  });
}

async function fetchLiveBusesViaColombiaRelay(context: LiveRequestContext, signal?: AbortSignal): Promise<any[]> {
  const relayUrl = getConfiguredColombiaRelayUrl();
  if (!relayUrl) {
    throw new Error(
      'No Colombia relay configured. Set TRANSMILENIO_COLOMBIA_RELAY_URL to a relay running from a Colombian network.'
    );
  }

  const url = buildColombiaRelayRequestUrl(relayUrl);
  const postData = buildColombiaRelayBody(context);
  const headers: Record<string, string | number> = {
    'Accept-Encoding': 'identity',
    'Content-Type': 'application/json; charset=UTF-8',
    'Content-Length': Buffer.byteLength(postData),
  };
  const secret = getColombiaRelaySecret();
  if (secret) headers.Authorization = `Bearer ${secret}`;

  console.log(`[TM API] fetchLiveBuses: type=${context.routeType} ruta=${context.routeCode} nombre=${context.destinationName} via=CO relay ${url.origin}`);
  return requestLiveJson(url, headers, postData, COLOMBIA_RELAY_TIMEOUT_MS, undefined, signal);
}

function buildProxyHeaders(context: LiveRequestContext): Record<string, string | number> {
  const headers: Record<string, string | number> = {
    'Accept-Encoding': 'identity',
    'Appid': '9a2c3b48f0c24ae9bfba38e94f27c3ea',
    'Connection': 'Keep-Alive',
    'Host': LIVE_API_HOST,
    'User-Agent': 'okhttp/4.12.0',
    'uuid': 'fd1be953-d85e-4c63-8c23-234f143f445d',
    'version': '2.9.5',
    'Content-Length': Buffer.byteLength(context.postData),
  };
  if (context.postData) headers['Content-Type'] = 'application/json; charset=UTF-8';
  return headers;
}

/** Resolves with the first promise to fulfil; rejects only if every one rejects. */
function firstFulfilled<T>(promises: Promise<T>[]): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let pending = promises.length;
    if (pending === 0) {
      reject(new Error('no candidates'));
      return;
    }
    const errors: string[] = [];
    for (const p of promises) {
      p.then(resolve, (error) => {
        errors.push(String(error?.message || error));
        if (--pending === 0) reject(new Error(errors.join(' | ')));
      });
    }
  });
}

/**
 * Races one wave of proxies in parallel and resolves with the fastest valid
 * response. The winner is rewarded (latency recorded), genuine losers are
 * penalised, and the still-pending ones are aborted the moment a winner
 * resolves. Rejects only if every proxy in the wave fails.
 */
async function raceProxyWave(
  proxies: import('./proxy_manager.js').ProxyItem[],
  url: URL,
  headers: Record<string, string | number>,
  postData: string,
  SimpleProxyAgent: typeof import('./proxy_manager.js').SimpleProxyAgent,
  ProxyManager: typeof import('./proxy_manager.js').ProxyManager,
  signal?: AbortSignal
): Promise<any[]> {
  const controller = new AbortController();
  // Link parent signal so the overall timeout can cancel the proxy race.
  const onParentAbort = () => controller.abort();
  signal?.addEventListener('abort', onParentAbort, { once: true });

  const attempts = proxies.map(async (proxy) => {
    const started = Date.now();
    try {
      const buses = await requestLiveJson(
        url,
        headers,
        postData,
        LIVE_PROXY_TIMEOUT_MS,
        new SimpleProxyAgent(proxy.ip, proxy.port),
        controller.signal
      );
      ProxyManager.reportSuccess(proxy.ip, proxy.port, Date.now() - started);
      return buses;
    } catch (error) {
      // Aborted losers are not genuine failures; don't penalise them.
      if (!controller.signal.aborted) ProxyManager.reportFailure(proxy.ip, proxy.port);
      throw error;
    }
  });

  try {
    return await firstFulfilled(attempts);
  } finally {
    controller.abort(); // cancel the slower in-flight proxies
    signal?.removeEventListener('abort', onParentAbort);
  }
}

/**
 * Races the best proxies in parallel for one request, in successive
 * non-overlapping waves. Free CO proxies are slow and unreliable, so firing
 * several at once and taking the fastest valid response dramatically beats
 * trying them one by one; when an entire wave dies (every proxy reset/timed
 * out — routine with free proxies) we fall through to the next-best wave rather
 * than failing the whole strategy, bounded by CO_PROXY_MAX_WAVES and the
 * overall budget (§5.2.5).
 */
async function fetchLiveBusesViaColombianProxy(context: LiveRequestContext, signal?: AbortSignal): Promise<any[]> {
  const { ProxyManager, SimpleProxyAgent } = await import('./proxy_manager.js');
  const ready = await ProxyManager.waitForReady(CO_PROXY_READY_TIMEOUT_MS);
  if (ready === 0) throw new Error('No Colombian proxy available');

  const url = new URL(`${LIVE_API_ORIGIN}${context.targetPath}`);
  const headers = buildProxyHeaders(context);

  const tried = new Set<string>();
  let lastError: Error | null = null;

  for (let wave = 1; wave <= CO_PROXY_MAX_WAVES; wave++) {
    if (signal?.aborted) break;

    const proxies = ProxyManager.getProxies(CO_PROXY_RACE_WIDTH, tried);
    if (proxies.length === 0) break;
    for (const proxy of proxies) tried.add(`${proxy.ip}:${proxy.port}`);

    console.log(`[TM API] fetchLiveBuses: type=${context.routeType} ruta=${context.routeCode} nombre=${context.destinationName} via=CO proxy RACEx${proxies.length} wave ${wave}/${CO_PROXY_MAX_WAVES}`);

    try {
      // A valid empty result (proxy worked, this name has no buses) resolves the
      // wave too — we don't burn further waves on a working proxy.
      return await raceProxyWave(proxies, url, headers, context.postData, SimpleProxyAgent, ProxyManager, signal);
    } catch (error: any) {
      lastError = error;
    }
  }

  throw new Error(`All CO proxies failed across ${tried.size} tried${lastError ? `: ${lastError.message}` : ''}`);
}

/**
 * Direct call to the live API host. This is the primary path: when the backend
 * itself runs with a Colombian egress IP (local/CO-hosted), it works with no
 * relay or proxy. From a non-Colombian host the geofence answers 401/451, which
 * fails fast and falls through to the relay below.
 */
async function fetchLiveBusesDirect(context: LiveRequestContext, signal?: AbortSignal): Promise<any[]> {
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

  console.log(`[TM API] fetchLiveBuses: type=${context.routeType} ruta=${context.routeCode} nombre=${context.destinationName} via=DIRECT`);
  return requestLiveJson(url, headers, postData, LIVE_REQUEST_TIMEOUT_MS, undefined, signal);
}

/** A non-Colombian egress is rejected by the geofence — no candidate will fare
 *  better, so abort the remaining attempts for this strategy. */
function isGeofenceRejection(error: any): boolean {
  return /Status: (401|451)/.test(String(error?.message || ''));
}

/** Overall budget for the entire live-bus cascade (all strategies + candidates).
 *  Must be under the client's 15 s timeout so the server answers before the
 *  browser gives up, leaving room for the stale-cache fallback. */
const LIVE_OVERALL_TIMEOUT_MS = 14_500;

/**
 * Runs one transport strategy across every name candidate **in parallel**,
 * returning the first non-empty payload (or a valid empty one) or `null` if
 * all candidates failed.
 *
 * The old sequential loop burned the full per-request timeout for *each*
 * candidate when the upstream was dead, easily exceeding 60 s total and
 * triggering the client-side abort.  Parallelising means wall-clock time
 * equals one request, not N×one request.
 */
async function runLiveStrategy(
  label: string,
  fetcher: (context: LiveRequestContext, signal?: AbortSignal) => Promise<any[]>,
  contexts: LiveRequestContext[],
  errors: string[],
  shouldAbort?: (error: any) => boolean,
  signal?: AbortSignal
): Promise<any[] | null> {
  if (contexts.length === 0) return null;

  // Fast-path: single candidate (zonal or single-name troncal).
  if (contexts.length === 1) {
    try {
      return await fetcher(contexts[0], signal);
    } catch (error: any) {
      errors.push(`[${label} ${contexts[0].candidateName}] ${error.message}`);
      return null;
    }
  }

  // Multi-candidate: fire all in parallel, take the first non-empty hit.
  const controller = new AbortController();
  const onParentAbort = () => controller.abort();
  signal?.addEventListener('abort', onParentAbort, { once: true });

  type Outcome = { buses: any[]; candidate: string } | { error: any; candidate: string };

  const settled = await Promise.allSettled(
    contexts.map(async (ctx): Promise<Outcome> => {
      try {
        const buses = await fetcher(ctx, controller.signal);
        return { buses, candidate: ctx.candidateName };
      } catch (error: any) {
        return { error, candidate: ctx.candidateName };
      }
    })
  );

  signal?.removeEventListener('abort', onParentAbort);

  // Evaluate results: prefer the first non-empty bus list; remember any valid
  // empty result as fallback; collect errors from genuine failures.
  let emptyResult: any[] | null = null;
  let geofenced = false;
  for (const result of settled) {
    if (result.status !== 'fulfilled') continue;
    const outcome = result.value;
    if ('buses' in outcome) {
      if (outcome.buses.length > 0) {
        console.log(`[TM API] ${label} candidate "${outcome.candidate}" succeeded with ${outcome.buses.length} buses`);
        controller.abort(); // cancel stragglers
        return outcome.buses;
      }
      emptyResult = outcome.buses;
    } else {
      errors.push(`[${label} ${outcome.candidate}] ${outcome.error?.message ?? outcome.error}`);
      if (shouldAbort?.(outcome.error)) geofenced = true;
    }
  }

  controller.abort();
  // A geofenced rejection means no candidate on this transport will ever work.
  if (geofenced && emptyResult === null) return null;
  return emptyResult;
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

  // Overall budget: abort everything if the cascade exceeds the wall-clock cap.
  const overallController = new AbortController();
  const overallTimer = setTimeout(() => overallController.abort(), LIVE_OVERALL_TIMEOUT_MS);

  try {
    // 1. Direct (works when the backend egress is Colombian).
    const direct = await runLiveStrategy('direct', fetchLiveBusesDirect, contexts, errors, isGeofenceRejection, overallController.signal);
    if (direct) return direct;

    // 2. Colombia relay (for non-Colombian hosts with a relay configured).
    const relay = await runLiveStrategy('co-relay', fetchLiveBusesViaColombiaRelay, contexts, errors, undefined, overallController.signal);
    if (relay) return relay;

    // 3. Public Colombian proxy (opt-in best-effort fallback).
    if (allowPublicColombianProxyFallback()) {
      const proxy = await runLiveStrategy('public-co-proxy', fetchLiveBusesViaColombianProxy, contexts, errors, undefined, overallController.signal);
      if (proxy) return proxy;
    }

    throw new Error(`Live tracking unavailable: ${errors.join(' | ')}`);
  } finally {
    clearTimeout(overallTimer);
  }
}
