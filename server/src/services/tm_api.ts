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
import { promisify } from 'util';
import { relayForward, isColombiaRelayConfigured } from './co_relay.js';
import { collectBody, decodeBody } from './upstream_body.js';
import { plateWagon, printedVagonLabels } from './plano_vagones.js';
import { buildWagonPlan, stationCorridor } from './station_plan.js';
import { isTroncalStationCode, troncalStationEntry, unregisteredServedStations } from './station_registry.js';
import {
  correctRecorrido,
  isRetiredRoute,
  isRetiredVariant,
  reportUnusedCorrections,
} from './recorrido_corrections.js';

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
/**
 * How long a route may go unlisted before the catalog lets it go.
 *
 * Long enough that day-dependent services survive: Ciclovía routes are listed
 * on Sundays and festivos, so three weeks covers three of each plus a missed
 * sync. Short enough that a retired route does not outlive the network by a
 * season.
 */
const ROUTE_RETENTION_DAYS = Number(process.env.TM_ROUTE_RETENTION_DAYS || 21);
/**
 * Expiry only runs after a sync that plainly saw the whole network. A partial
 * fetch is the exact thing retention exists to survive, and it must never be
 * read as "these routes are gone" — so a run that indexed fewer than this
 * fraction of the códigos the catalog already had drops nothing at all.
 */
const HEALTHY_SYNC_COVERAGE = 0.9;
/** Two stops may share a chainage if they are the two kerbs of one street; this
 *  far apart they are a stale recorrido instead (`warnTiedChainage`). */
const TIED_CHAINAGE_TOLERANCE_M = 400;
const ROUTE_SEARCH_SEEDS = ['', ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'];
/**
 * Vertices kept per route variant in the browser catalog.
 *
 * The trace is not just something to draw any more — the planner projects each
 * route's stops onto it and rides it (§5.6.3), so how coarse it arrives decides
 * both what the map shows and how many legs get real driven distances. Measured
 * over the committed catalog: at 160 the planner could use 91.3% of ride legs
 * and drew them with vertices a median 145 m apart; at 320 that is 93.1% and
 * 78 m, for +0.28 MB gzipped on a payload the service worker caches. Past 320
 * the curve flattens — the full traces buy another 0.0% of legs for +4.4 MB.
 */
const LIGHT_TRACE_MAX_POINTS = 320;

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
  /**
   * Epoch ms of the last sync that saw this variant in the upstream listing.
   *
   * Retention keeps everything a fetch missed (§5.1.3), which is right for a
   * listing that drifts and wrong forever after: a route TransMi actually
   * retires has no way out of the catalog, and the id-keyed rename purge only
   * catches the case where the same id comes back under a new código. This is
   * the clock that lets a genuinely delisted route expire. Absent on entries
   * that predate it — those are stamped on the next sync and get the full
   * window from there, so nothing is dropped for having no stamp.
   */
  seenAt?: number;
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
        const parse = (buf: Buffer) => {
          const text = buf.toString('utf-8');
          try {
            return JSON.parse(text);
          } catch {
            console.error(`[TM API] JSON parse error. Status: ${res.statusCode}. Body: ${text.slice(0, 200)}`);
            return null;
          }
        };

        collectBody(res, 'catalog loader').then(
          (raw) =>
            // A gzip failure means the body was not actually gzipped — parse it raw.
            decodeBody(raw, res.headers['content-encoding'])
              .then((body) => resolve(parse(body)))
              .catch(() => resolve(parse(raw))),
          reject
        );
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
// Serialized, gzip-compressed `/troncal/master-catalog` body, built once per
// catalog version and streamed straight to clients. The old code cached the
// light catalog as a live OBJECT (~50 MB, held forever alongside the full
// ~220 MB catalog) and Express re-`JSON.stringify`d + re-gzipped it on every
// cache miss — those transient allocations, multiplied across concurrent
// requests, were the main OOM trigger on the 512 MB host. Now the light object
// and its ~15 MB JSON string live only for the duration of one build and are
// GC'd, leaving just this compact (~5 MB) buffer resident. Null = needs rebuild.
let lightCatalogGzip: Buffer | null = null;
let lightCatalogStationCount = 0;
// De-dupes concurrent first-hit builds so a burst of requests compresses once.
let lightCatalogBuilding: Promise<Buffer> | null = null;
let catalogLoadedAt: number = 0;

const gzipAsync = promisify(zlib.gzip);

/** Drop the cached gzip body so the next request rebuilds it from the new catalog. */
function invalidateLightCatalog(): void {
  lightCatalogGzip = null;
  lightCatalogStationCount = 0;
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
    invalidateLightCatalog();

    const stationCount = Object.keys(masterCatalog.stations || {}).length;
    const totalRoutes = Object.values(masterCatalog.stations || {}).reduce((sum, s) => {
      return sum + Object.values(s.wagons).reduce((ws, routes) => ws + routes.length, 0);
    }, 0);
    console.log(
      `[TM API] Loaded master catalog: ${stationCount} stations, ${totalRoutes} route-wagon mappings, ${Object.keys(masterCatalog.routes || {}).length} routes`
    );
    warnUnregisteredStations();
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

function buildCatalogLight(): { stations: Record<string, any>; routes: Record<string, any[]> } {
  console.log('[TM API] Generating lightweight master catalog...');
  // Variant id → the full-resolution variant, for the platform plan below. Built
  // from the FULL catalog on purpose: the plan reads stop coordinates, and the
  // light catalog's simplified traces are not what a stop sits on (§5.1.4).
  const variantById = new Map<string, any>();
  for (const variants of Object.values(masterCatalog.routes || {})) {
    for (const variant of variants as any[]) if (variant?.id) variantById.set(String(variant.id), variant);
  }

  const cleanStations: Record<string, any> = {};
  for (const [code, station] of Object.entries(masterCatalog.stations || {})) {
    // Answered from the official register, not from the code's shape — a station
    // that opens before TransMi assigns it a TM code is still a station
    // (`station_registry.ts`, §5.5.6).
    const isTroncal = isTroncalStationCode(station.codigo || code);
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
      // The printed vagón number, resolved once here so the app popup and the
      // prerendered estación page name the same platform the same way — the
      // catalog's own `A`/`B` keys appear on no sign in any station (§5.5.4).
      const letteredWagons = Object.entries(cleanWagons).filter(
        ([wagon, routes]) => wagon !== '0' && routes.length > 0
      ).length;
      const vagonLabels = printedVagonLabels(station.codigo, Object.keys(cleanWagons), letteredWagons);
      // Which services board which side of each vagón, and which way that side
      // faces. Resolved here so the estación page and the app's station popup
      // read one answer instead of deriving it twice (spec §5.5.4).
      const wagonPlan = buildWagonPlan(station.codigo, station.coordenada, cleanWagons, variantById);
      // The troncal this station sits on, and its letter. Shipped rather than
      // derived for the same reason as the plan above: it is an answered fact
      // (§5.5.6), and it is what names and colours the estación page.
      const corridor = stationCorridor(station.codigo);
      const registryNode = troncalStationEntry(station.codigo || code)?.nodo || '';

      cleanStations[code] = {
        id: station.id,
        codigo: station.codigo,
        nombre: station.nombre,
        direccion: station.direccion,
        coordenada: station.coordenada,
        sistema: station.sistema,
        tipoServicio: station.tipoServicio,
        // Shipped so the browser, the app and the prerenderer stop re-deriving
        // "estación or paradero?" from the code shape (§5.1.4, §5.5.6). Only the
        // server can answer it: the register is a server-side dataset.
        estacion: true,
        // The register's node id for this stop, when the two are paired. The
        // catalog and ArcGIS number stations in different id spaces, and the map
        // bridges them by name and distance — which fails outright where the two
        // sources spell a station differently ("Los Laureles" in the register,
        // "Laureles" in the catalog), leaving the pin with an empty popup. The
        // pairing is already computed offline, so it travels instead of being
        // guessed at twice.
        ...(registryNode ? { nodo: registryNode } : {}),
        ...(corridor ? { corridor } : {}),
        ...(vagonLabels ? { vagonLabels } : {}),
        ...(wagonPlan ? { wagonPlan } : {}),
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

  return {
    stations: cleanStations,
    routes: cleanRoutes,
  };
}

export interface LightCatalogArtifact {
  gzip: Buffer;
  count: number;
  etag: string;
}

/**
 * Returns the gzip-compressed `/troncal/master-catalog` HTTP body, building it
 * once per catalog version. Compression runs on the libuv threadpool (async
 * `zlib.gzip`) so the event loop never blocks (spec §1.1 R2), and concurrent
 * first-hits share a single build via {@link lightCatalogBuilding}. The
 * intermediate light object + its JSON string are released the moment the gzip
 * buffer is produced, so steady-state RSS holds only the full catalog + this
 * ~5 MB buffer — never a second full copy.
 */
export async function getCatalogLightGzip(): Promise<LightCatalogArtifact> {
  const etag = `W/"catalog-${catalogLoadedAt}"`;
  if (lightCatalogGzip) {
    return { gzip: lightCatalogGzip, count: lightCatalogStationCount, etag };
  }
  if (!lightCatalogBuilding) {
    lightCatalogBuilding = (async () => {
      const light = buildCatalogLight();
      lightCatalogStationCount = Object.keys(light.stations).length;
      const body = JSON.stringify({
        success: true,
        data: light,
        count: lightCatalogStationCount,
        stale: isCatalogStale(),
      });
      const gz = await gzipAsync(body);
      lightCatalogGzip = gz;
      return gz;
    })().finally(() => { lightCatalogBuilding = null; });
  }
  const gzip = await lightCatalogBuilding;
  return { gzip, count: lightCatalogStationCount, etag };
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

function hasTrace(trace: RouteTrace | undefined): trace is RouteTrace {
  return Array.isArray(trace) && trace.length > 0;
}

/**
 * Non-destructively merges a freshly fetched catalog over the previous one.
 *
 * The TransMi API is a live snapshot: the listing drifts between runs and a
 * partial fetch can miss routes, so a blind full replace would delete real
 * services. `fresh` is authoritative for everything it returns (updates win by
 * id), and anything present only in `previous` — routes, variants,
 * station-wagon mappings — is retained. The single field-level exception is
 * `trazado`, which falls back to the previous trace when fresh has none.
 */
export function mergeCatalogs(previous: MasterCatalog, fresh: MasterCatalog): MasterCatalog {
  // Merge `previous` INTO `fresh` in place and return `fresh`. The caller passes
  // a disposable fresh catalog, so mutating it avoids allocating a third full
  // ~220 MB structure during sync — cutting the peak that OOM-kills a small host
  // (spec §1.1 R2). Only entries the fresh sync missed are grafted on; fresh
  // always wins on conflict, so the published data is identical to before.

  // Upstream route id → the código(s) fresh files it under. A route that is
  // *renamed* — A61/F61 becoming A61/Z61 — keeps its id and changes código, so
  // without this the old código is retained forever by the rule below and the
  // catalog grows a ghost service running the retired code. Retention exists for
  // a listing that drifts (a route missing from one run is not a route that
  // ended); an id answering to a different código now is positive evidence that
  // this entry is the *same* route under its old name, which is the one case
  // where absence means gone (§5.1.3).
  const freshCodesById = new Map<string, Set<string>>();
  for (const [code, variants] of Object.entries(fresh.routes || {})) {
    for (const variant of variants) {
      const id = String(variant?.id ?? '').trim();
      if (!id) continue;
      const codes = freshCodesById.get(id) ?? new Set<string>();
      codes.add(code.toUpperCase().trim());
      freshCodesById.set(id, codes);
    }
  }
  const isRenamedAway = (variant: { id?: string }, code: string): boolean => {
    const codes = freshCodesById.get(String(variant?.id ?? '').trim());
    return Boolean(codes && !codes.has(code.toUpperCase().trim()));
  };
  let renamedAway = 0;

  // The purge above reads id → código, so it is blind to the mirror case:
  // upstream re-issuing a route under a NEW id while keeping the código. Nothing
  // in the fresh listing then mentions the old id at all, absence is all there
  // is, and absence is exactly what retention refuses to act on. That variant is
  // therefore retired by hand, with its evidence, in
  // `recorrido_corrections.json` (`retiredVariants`).
  const isRetiredTwin = (variant: { id?: string }, code: string): boolean =>
    isRetiredVariant(code, variant?.id);
  let retiredTwins = 0;

  // Routes: union by code; within a code, union variants by normalized name (fresh wins).
  let tracesCarried = 0;
  for (const [code, oldVariants] of Object.entries(previous.routes || {})) {
    const freshVariants = fresh.routes[code];
    if (!freshVariants) {
      const alive = oldVariants.filter((v) => !isRetiredTwin(v, code));
      retiredTwins += oldVariants.length - alive.length;
      const survivors = alive.filter((v) => !isRenamedAway(v, code));
      renamedAway += alive.length - survivors.length;
      if (survivors.length > 0) fresh.routes[code] = survivors;
      continue;
    }

    // `trazado` is the one field where fresh does NOT win on absence. Upstream
    // `infoRuta` intermittently answers with no trazado at all for a route it
    // previously traced (66 variants lost a good trace that way on 2026-08-17,
    // verified against the live endpoint), and a variant-level overwrite takes
    // the trace down with it. A missing trace is never evidence a route has no
    // geometry (spec §1 Certainty), and the planner charges ride distance along
    // it (§5.1.4, §5.6.3), so it falls back to the previous trace instead.
    const oldByName = new Map(oldVariants.map((v) => [cleanRouteName(v.nombre), v]));
    for (const variant of freshVariants) {
      if (hasTrace(variant.trazado)) continue;
      const previousTrace = oldByName.get(cleanRouteName(variant.nombre))?.trazado;
      if (!hasTrace(previousTrace)) continue;
      variant.trazado = previousTrace;
      tracesCarried++;
    }

    const freshKeys = new Set(freshVariants.map((v) => cleanRouteName(v.nombre)));
    const retained = oldVariants.filter((v) => !freshKeys.has(cleanRouteName(v.nombre)));
    const alive = retained.filter((v) => !isRetiredTwin(v, code));
    retiredTwins += retained.length - alive.length;
    const survivors = alive.filter((v) => !isRenamedAway(v, code));
    renamedAway += alive.length - survivors.length;
    if (survivors.length > 0) freshVariants.push(...survivors);
  }

  // Never re-attach a mapping for a route that has been renamed away or whose
  // variant is an answered twin: its recorrido now rides under the new código or
  // the new id, so keeping the old one tags the platform with a service that no
  // longer exists. Applied on every path a previous mapping can travel back in
  // by — including the two wholesale copies below, which is precisely where a
  // *closed* station's tags live: nothing fresh calls there, so fresh has no
  // station and no wagon to merge into.
  const keepMapping = (r: CatalogRoute): boolean =>
    !isRenamedAway(r, r.codigo || '') && !isRetiredTwin(r, r.codigo || '');
  const keptWagons = (wagons: CatalogWagons): CatalogWagons => {
    const out: CatalogWagons = {};
    for (const [wagon, routes] of Object.entries(wagons || {})) {
      const kept = routes.filter(keepMapping);
      if (kept.length > 0) out[wagon] = kept;
    }
    return out;
  };

  // Stations: union by code; union wagons; within a wagon, union route refs by normalized code+name.
  for (const [stationCode, oldStation] of Object.entries(previous.stations || {})) {
    const freshStation = fresh.stations[stationCode];
    if (!freshStation) {
      oldStation.wagons = keptWagons(oldStation.wagons || {});
      fresh.stations[stationCode] = oldStation;
      continue;
    }
    const freshWagons = freshStation.wagons || (freshStation.wagons = {});
    for (const [wagon, oldRoutes] of Object.entries(oldStation.wagons || {})) {
      const freshRoutes = freshWagons[wagon];
      if (!freshRoutes) {
        const kept = oldRoutes.filter(keepMapping);
        if (kept.length > 0) freshWagons[wagon] = kept;
        continue;
      }
      const freshKeys = new Set(freshRoutes.map((r) => `${r.codigo.toUpperCase().trim()}|${cleanRouteName(r.nombre)}`));
      const retained = oldRoutes
        .filter((r) => !freshKeys.has(`${r.codigo.toUpperCase().trim()}|${cleanRouteName(r.nombre)}`))
        .filter(keepMapping);
      if (retained.length > 0) freshRoutes.push(...retained);
    }
  }

  if (tracesCarried > 0) {
    console.log(`[TM API] Kept ${tracesCarried} previous trazado(s) upstream returned no geometry for.`);
  }
  if (renamedAway > 0) {
    console.log(`[TM API] Dropped ${renamedAway} previous entr(ies) whose route id now answers to a different código.`);
  }
  if (retiredTwins > 0) {
    console.log(
      `[TM API] Dropped ${retiredTwins} previous entr(ies) filed as replaced in recorrido_corrections.json.`
    );
  }

  return fresh;
}

/**
 * Drops station→wagon route mappings that no route's authoritative recorrido
 * corroborates.
 *
 * `mergeCatalogs` retains a previous catalog's station-wagon mappings so
 * services the upstream listing happens to omit on a given run, and partial
 * fetches, survive. That same retention also preserves mappings for routes
 * upstream has since rerouted *away* from a station — e.g. a troncal
 * "C15 Chapinero" that no longer calls at Nariño, or "M85 Museo Nacional" no
 * longer serving Fucha. Those stale mappings surface as phantom or duplicate
 * route tags in a station popup.
 *
 * The route recorrido (`routes[code][].stops`) is the source of truth for which
 * stations a route serves (spec §5.1.2). A wagon entry is kept only if some
 * variant sharing its código + normalized name lists this station among its
 * stops; retained day-dependent routes keep their own retained recorrido, so
 * they survive. Empty wagons left behind are removed. Returns the count pruned.
 */
export function pruneUnservedStationRoutes(catalog: MasterCatalog): number {
  // código → normalized name → set of station codes the recorrido serves.
  const served = new Map<string, Map<string, Set<string>>>();
  for (const [code, variants] of Object.entries(catalog.routes || {})) {
    const codeKey = code.toUpperCase().trim();
    let byName = served.get(codeKey);
    if (!byName) {
      byName = new Map();
      served.set(codeKey, byName);
    }
    for (const variant of variants) {
      const nameKey = cleanRouteName(variant.nombre);
      let stops = byName.get(nameKey);
      if (!stops) {
        stops = new Set();
        byName.set(nameKey, stops);
      }
      for (const stop of variant.stops || []) {
        if (stop?.codigo) stops.add(String(stop.codigo).toUpperCase().trim());
      }
    }
  }

  let pruned = 0;
  for (const [stationCode, station] of Object.entries(catalog.stations || {})) {
    const stationKey = String(stationCode).toUpperCase().trim();
    for (const [wagon, routes] of Object.entries(station.wagons || {})) {
      const kept = routes.filter((r) => {
        const stops = served.get((r.codigo || '').toUpperCase().trim())?.get(cleanRouteName(r.nombre));
        return stops ? stops.has(stationKey) : false;
      });
      if (kept.length === routes.length) continue;
      pruned += routes.length - kept.length;
      if (kept.length > 0) station.wagons[wagon] = kept;
      else delete station.wagons[wagon];
    }
  }
  return pruned;
}

/**
 * Drops route variants no sync has seen for `ROUTE_RETENTION_DAYS`.
 *
 * The counterpart to retention. `mergeCatalogs` keeps everything a fetch missed,
 * because the upstream listing drifts and absence from one run proves nothing —
 * but with no clock that rule also keeps routes TransMi has genuinely retired,
 * forever. A variant is dropped only when the catalog has watched it be absent
 * across the whole window, and only after a sync that saw the whole network
 * (the caller's health check): a partial fetch is precisely what retention is
 * for, and must never be read as a retirement.
 *
 * Unstamped variants are stamped rather than judged, so the first sync after
 * this shipped starts everyone's clock instead of expiring the catalog.
 */
/**
 * Names estaciones the registry does not know yet — the one silent failure mode
 * of answering "is this a station?" from a generated file (§5.5.6). Logged at
 * boot and after every sync, because the symptom is a station simply missing
 * from the map rather than anything visibly wrong.
 */
export function warnUnregisteredStations(): void {
  const missing = unregisteredServedStations(masterCatalog);
  if (missing.length === 0) return;
  console.warn(
    `[TM API] ${missing.length} station(s) carry TransMilenio service but are not in the register — ` +
      `run \`npm run sync:stations\`: ${missing.map((s) => `${s.codigo} ${s.nombre}`).join(', ')}`
  );
}

export function expireUnseenVariants(catalog: MasterCatalog, now: number): number {
  const cutoff = now - ROUTE_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  let dropped = 0;

  for (const [code, variants] of Object.entries(catalog.routes || {})) {
    // An answered retirement does not wait out the window. Retention exists
    // because absence from one listing proves nothing; a route the network has
    // actually ended is not an absence, it is a fact on file
    // (`recorrido_corrections.json`) — and upstream can retire a código without
    // ever reusing its id, which is the one case the rename purge cannot see.
    if (isRetiredRoute(code)) {
      dropped += variants.length;
      delete catalog.routes[code];
      continue;
    }
    const kept = variants.filter((variant) => {
      if (typeof variant.seenAt !== 'number') {
        variant.seenAt = now;
        return true;
      }
      return variant.seenAt >= cutoff;
    });
    if (kept.length === variants.length) continue;
    dropped += variants.length - kept.length;
    if (kept.length > 0) catalog.routes[code] = kept;
    else delete catalog.routes[code];
  }

  return dropped;
}

/**
 * Drops the route variants `recorrido_corrections.json` files as replaced.
 *
 * `mergeCatalogs` refuses them on the way in, but a variant already sitting in
 * the catalog when the entry is filed would otherwise wait out the full 21-day
 * retention window — and a whole re-sync is a ~70-minute round trip to apply a
 * fact that is already answered. Returns the number dropped.
 */
export function dropRetiredVariants(catalog: MasterCatalog): number {
  let dropped = 0;
  for (const [code, variants] of Object.entries(catalog.routes || {})) {
    const kept = variants.filter((variant) => !isRetiredVariant(code, variant.id));
    if (kept.length === variants.length) continue;
    // Named, not just counted. A file entry outlives its cause the moment
    // upstream republishes the route, and this is the one path that would drop
    // it again on the way past — so it says out loud which (código, id) it took.
    for (const variant of variants) {
      if (!kept.includes(variant)) {
        console.log(`[TM API]   dropped ${code} #${variant.id} "${variant.nombre}" (filed as replaced)`);
      }
    }
    dropped += variants.length - kept.length;
    if (kept.length > 0) catalog.routes[code] = kept;
    else delete catalog.routes[code];
  }
  return dropped;
}

/**
 * Moves services out of the unlettered `"0"` pool onto the vagón their station's
 * plano prints (`plateWagon`).
 *
 * The sync applies this at the edge, where the recorrido's empty `vagon` is
 * first read. This is the same answer applied to what is already in the catalog
 * — mappings retained from a previous run, and every station written before the
 * sheet was read — so the two paths converge without a 70-minute re-fetch.
 * Returns the number of mappings moved.
 */
export function applyPlanoWagons(catalog: MasterCatalog): number {
  let moved = 0;
  for (const station of Object.values(catalog.stations || {})) {
    const pool = station.wagons?.['0'];
    if (!pool || pool.length === 0) continue;

    const stayed: CatalogRoute[] = [];
    for (const route of pool) {
      const wagon = plateWagon(station.codigo, route.codigo);
      if (!wagon) {
        stayed.push(route);
        continue;
      }
      const target = station.wagons[wagon] || (station.wagons[wagon] = []);
      const key = `${(route.codigo || '').toUpperCase().trim()}|${cleanRouteName(route.nombre)}`;
      const already = target.some(
        (r) => `${(r.codigo || '').toUpperCase().trim()}|${cleanRouteName(r.nombre)}` === key
      );
      if (!already) target.push(route);
      moved++;
    }

    if (stayed.length === pool.length) continue;
    if (stayed.length > 0) station.wagons['0'] = stayed;
    else delete station.wagons['0'];
  }
  return moved;
}

/**
 * Repairs the on-disk catalog in place: loads it, drops variants filed as
 * replaced, places the services the planos letter and the recorrido does not,
 * prunes phantom station-wagon mappings (see
 * `pruneUnservedStationRoutes`), and rewrites it atomically. Used to heal a
 * catalog whose stale mappings predate the prune step now baked into
 * `syncMasterCatalog`. Returns the number of mappings pruned.
 *
 * Order matters: the mapping prune reads each route's recorrido as the proof
 * that a platform tag is real, so a replaced variant has to be gone before its
 * own stale recorrido gets a vote.
 */
export async function pruneCatalogFileInPlace(): Promise<number> {
  await loadCatalogFromDisk();
  const retired = dropRetiredVariants(masterCatalog);
  if (retired > 0) {
    console.log(`[TM API] Dropped ${retired} route variant(s) filed as replaced in recorrido_corrections.json.`);
  }
  const placed = applyPlanoWagons(masterCatalog);
  if (placed > 0) {
    console.log(`[TM API] Placed ${placed} unlettered mapping(s) on the vagón their plano prints.`);
  }
  const pruned = pruneUnservedStationRoutes(masterCatalog);
  if (pruned > 0 || retired > 0 || placed > 0) {
    await writeCatalogAtomically(masterCatalog);
    invalidateLightCatalog();
  }
  return pruned;
}

/**
 * Warns when a recorrido files two stops at the same metre.
 *
 * `posicion` is the operator's own chainage along the route, so two stops
 * sharing one — while sitting far apart on the ground — means the recorrido is
 * carrying something that is not a position in the sequence. That is how A61
 * arrived with its retired cabecera still attached (Portal Américas at 0, tied
 * with the real head at Tibanica). Only ever a warning: which of the two is the
 * stale one is a question about the network, answered in
 * `recorrido_corrections.json` with evidence, never guessed at here (§1).
 */
function warnTiedChainage(codigo: string, stops: Array<{ codigo?: string; nombre?: string; posicion?: number; coordenada?: string }>): void {
  const byPosition = new Map<number, typeof stops>();
  for (const stop of stops) {
    const position = Number(stop?.posicion);
    if (!Number.isFinite(position)) continue;
    const bucket = byPosition.get(position) ?? [];
    bucket.push(stop);
    byPosition.set(position, bucket);
  }
  for (const [position, tied] of byPosition) {
    if (tied.length < 2) continue;
    // Opposite kerbs of one street legitimately share a metre; kilometres apart
    // does not.
    const points = tied
      .map((stop) => String(stop?.coordenada || '').split(',').map(Number))
      .filter((pair) => pair.length === 2 && pair.every(Number.isFinite));
    let apart = 0;
    for (let i = 0; i < points.length; i++) {
      for (let j = i + 1; j < points.length; j++) {
        const [lat1, lng1] = points[i];
        const [lat2, lng2] = points[j];
        apart = Math.max(apart, Math.hypot((lat1 - lat2) * 111320, (lng1 - lng2) * 110000));
      }
    }
    if (apart < TIED_CHAINAGE_TOLERANCE_M) continue;
    console.warn(
      `[TM API] ${codigo}: ${tied.length} stops filed at posicion ${position}, ${Math.round(apart)} m apart ` +
        `(${tied.map((stop) => stop?.codigo).join(', ')}) — upstream recorrido looks stale.`
    );
  }
}

// ─── Master Sync ────────────────────────────────────────

let syncInProgress = false;

export async function syncMasterCatalog(): Promise<void> {
  if (syncInProgress) {
    console.log('[TM API] Sync already in progress, skipping.');
    return;
  }

  syncInProgress = true;
  // One clock for the whole run: every variant this sync sees is stamped with
  // the same moment, so the retention window is measured between syncs rather
  // than between the first and last route of one.
  const syncStartedAt = Date.now();
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
      // A código the network has retired is not fetched, indexed or retained —
      // upstream keeps listing one for a while after the service ends.
      if (isRetiredRoute(route.codigo)) {
        console.log(`[TM API] [${progress}] ${route.codigo} — retired (recorrido_corrections.json), skipped`);
        continue;
      }

      try {
        const { recorrido, color, horarios, sistema, tipoServicio, trazado } = await getRouteInfo(route.id, route.nombre, route.codigo);
        // A recorrido carries what the operator filed, which is not always what
        // the service does (`recorrido_corrections.json`). Corrected here, at the
        // edge, so the catalog on disk records the route as it is actually run
        // and nothing downstream has to know about the difference.
        const corrected = correctRecorrido(route.codigo, recorrido || []);
        if (corrected.length !== (recorrido || []).length) {
          console.log(
            `[TM API] [${progress}] ${route.codigo} — dropped ${(recorrido || []).length - corrected.length} ` +
              'stop(s) upstream files but the service does not make.'
          );
        }
        warnTiedChainage(route.codigo, corrected);
        const routeColor = color || route.color || '#64748B';

        if (corrected.length === 0) {
          console.log(`[TM API] [${progress}] ${route.codigo} — no stops`);
          errors++;
        } else {
          let stopsAdded = 0;

          for (const stop of corrected) {
            const stationCode = stop.codigo;
            if (!stationCode || stationCode.length === 0) continue;

            // Wagon label from the API, or from the station's own plano where
            // the API sends none (`plateWagon`). "0" is the pool for a stop with
            // no platform on file, and it takes no vagón number on any surface —
            // so a service the plano *does* place is worth placing here, at the
            // edge, rather than published as a route that stops at no platform.
            const planoWagon = plateWagon(stationCode, route.codigo);
            if (planoWagon && stop.vagon && stop.vagon.trim().toUpperCase() !== planoWagon.toUpperCase()) {
              // Upstream filling the field in is the good outcome; upstream
              // filling it in with a different answer is a fact worth hearing
              // about, not one to resolve silently in favour of either side.
              console.warn(
                `[TM API] ${route.codigo} at ${stationCode}: recorrido says vagón ${stop.vagon}, ` +
                  `plano_vagones.json says ${planoWagon} — recorrido kept, re-read the plano.`
              );
            }
            const wagonLabel = stop.vagon || planoWagon || '0';

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
              stops: corrected.map(s => ({
                nombre: s.nombre,
                codigo: s.codigo,
                coordenada: s.coordenada,
                posicion: s.posicion
              })),
              trazado,
              // Seen in this run's listing — the clock `expireUnseenVariants`
              // reads. Retained variants keep whatever stamp they arrived with.
              seenAt: syncStartedAt,
            });
          }

          console.log(
            `[TM API] [${progress}] ${route.codigo} (${route.nombre}) — ${corrected.length} stops, ${stopsAdded} new mappings`
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
    //    runs Sundays and festivos) and anything a partial fetch missed survive,
    //    then save atomically and publish once the file is complete.
    const merged = mergeCatalogs(masterCatalog, newCatalog);

    // 3a. Retained mappings predate the edge rule above, so the plano answer is
    //     applied to the merged whole as well — otherwise a service the sheet
    //     letters stays in "0" for as long as retention keeps carrying it.
    const placed = applyPlanoWagons(merged);
    if (placed > 0) {
      console.log(`[TM API] Placed ${placed} unlettered mapping(s) on the vagón their plano prints.`);
    }

    // 3b. …and let go of what the network has actually retired. Only after a run
    //     that plainly saw the whole listing: a short fetch is the case
    //     retention exists for, and reading it as a retirement would delete
    //     real routes on a bad night.
    const previousCodes = Object.keys(masterCatalog.routes || {}).length;
    const coverage = previousCodes === 0 ? 1 : Object.keys(newCatalog.routes).length / previousCodes;
    const healthy = errors === 0 && coverage >= HEALTHY_SYNC_COVERAGE;
    if (healthy) {
      const expired = expireUnseenVariants(merged, syncStartedAt);
      if (expired > 0) {
        console.log(
          `[TM API] Dropped ${expired} route variant(s) unlisted for more than ${ROUTE_RETENTION_DAYS} days.`
        );
      }
    } else {
      console.warn(
        `[TM API] Partial sync (${Math.round(coverage * 100)}% of known códigos, ${errors} errors) — ` +
          'nothing expired; every retained route kept.'
      );
    }

    const prunedMappings = pruneUnservedStationRoutes(merged);
    if (prunedMappings > 0) {
      console.log(`[TM API] Pruned ${prunedMappings} stale station-wagon mappings no recorrido corroborates.`);
    }

    // 3c. Every correction is re-checked on each run (§5.1.3): one that fired
    //     nothing has outlived the upstream fact it was filed against, and a
    //     correction kept past its cause is the same stale data it exists to
    //     remove. Named, never auto-deleted — the file is maintained by hand.
    const unusedCorrections = reportUnusedCorrections(
      new Set(Object.keys(newCatalog.routes).map((code) => code.toUpperCase().trim()))
    );
    for (const entry of unusedCorrections) {
      console.warn(`[TM API] Correction no longer needed — ${entry} (delete it from recorrido_corrections.json).`);
    }
    merged.syncedAt = Date.now();
    await writeCatalogAtomically(merged);
    masterCatalog = merged;
    invalidateLightCatalog();
    catalogLoadedAt = merged.syncedAt;

    const stationCount = Object.keys(masterCatalog.stations).length;
    const totalRoutes = Object.values(masterCatalog.stations).reduce((sum, s) => {
      return sum + Object.values(s.wagons).reduce((ws, routes) => ws + routes.length, 0);
    }, 0);

    console.log(
      `[TM API] ═══ Sync Complete! ${stationCount} stations, ${totalRoutes} mappings, ${errors} errors ═══`
    );
    // A sync is exactly when a new station arrives, so it is exactly when the
    // register is most likely to be a step behind.
    warnUnregisteredStations();
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

// Live requests repeat every 15 s per tracking client, so the TCP+TLS handshake
// is pure cold-start cost on every poll. Keeping the sockets alive removes it
// (~200-400 ms/poll) and, together with the warm-up below, means the first poll
// of a tracking session reuses an already-open connection.
const liveKeepAliveAgent = new https.Agent({ keepAlive: true, keepAliveMsecs: 15_000, maxSockets: 12 });
const relayKeepAliveAgents = {
  https: new https.Agent({ keepAlive: true, keepAliveMsecs: 15_000, maxSockets: 12 }),
  http: new http.Agent({ keepAlive: true, keepAliveMsecs: 15_000, maxSockets: 12 }),
};

// A non-CO egress is rejected by the geofence for EVERY route, so once the live
// host has answered 401/451 the direct tier is known-dead: trying it anyway adds
// a full handshake + rejection round-trip to the front of every request (and the
// whole cascade behind it). Remember the rejection and skip straight to the
// relay until the memo expires — a host that gains a Colombian egress (or a
// changed geofence) is picked up on the next expiry.
const DIRECT_GEOFENCE_MEMO_MS = Number(process.env.TM_DIRECT_GEOFENCE_MEMO_MS || 10 * 60_000);
let directGeofencedUntil = 0;

function isDirectTierGeofenced(): boolean {
  return Date.now() < directGeofencedUntil;
}

function markDirectTierGeofenced(): void {
  if (DIRECT_GEOFENCE_MEMO_MS <= 0) return;
  if (!isDirectTierGeofenced()) {
    console.log(`[TM API] Live host geofenced this egress — skipping the direct tier for ${Math.round(DIRECT_GEOFENCE_MEMO_MS / 1000)}s`);
  }
  directGeofencedUntil = Date.now() + DIRECT_GEOFENCE_MEMO_MS;
}

function clearDirectTierGeofence(): void {
  directGeofencedUntil = 0;
}

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

/** Shared decode + JSON + upstream-error handling for any live-host endpoint.
 *  The `normalize` step is what differs (buses vs arrivals). */
async function parseLivePayload(
  raw: Buffer,
  encoding: string | string[] | undefined,
  source: string,
  normalize: (payload: any) => any[]
): Promise<any[]> {
  const body = await decodeBody(raw, encoding).catch(() => raw);
  const text = body.toString('utf-8');

  let payload: any;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(`${source}: Live JSON parse error (${text.slice(0, 120)})`);
  }

  if (payload?.success === false) {
    throw new Error(`${source}: ${payload.error || 'Proxy returned success=false'}`);
  }

  const problemStatus = Number(payload?.status);
  if (Number.isFinite(problemStatus) && problemStatus >= 400) {
    throw new Error(`${source}: Status: ${problemStatus} ${payload.title || payload.detail || ''}`.trim());
  }

  return normalize(payload);
}

function parseLiveResponse(raw: Buffer, encoding: string | string[] | undefined, source: string): Promise<any[]> {
  return parseLivePayload(raw, encoding, source, normalizeLiveBusesPayload);
}

function parseArrivalsResponse(raw: Buffer, encoding: string | string[] | undefined, source: string): Promise<any[]> {
  return parseLivePayload(raw, encoding, source, normalizeArrivalsPayload);
}

function requestLiveJson(
  url: URL,
  headers: Record<string, string | number>,
  postData: string,
  timeoutMs: number,
  agent?: https.Agent,
  signal?: AbortSignal,
  parse: (raw: Buffer, encoding: string | string[] | undefined, source: string) => Promise<any[]> = parseLiveResponse
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
      // Bounded read + `error` listener live in one place (upstream_body.ts):
      // the transport may be an untrusted free proxy (spec §5.2.5).
      collectBody(res, source).then(
        async (raw) => {
          cleanup();
          if (res.statusCode !== 200) {
            reject(new Error(`${source}: Status: ${res.statusCode}`));
            return;
          }
          try {
            resolve(await parse(raw, res.headers['content-encoding'], source));
          } catch (error) {
            reject(error);
          }
        },
        (error) => {
          cleanup();
          reject(error);
        }
      );
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
  const agent = url.protocol === 'http:' ? relayKeepAliveAgents.http : relayKeepAliveAgents.https;
  return requestLiveJson(url, headers, postData, COLOMBIA_RELAY_TIMEOUT_MS, agent as https.Agent, signal);
}

/**
 * The exact header set the official app sends to the live host (spec §5.2.3 /
 * §5.5.1a). ONE definition: the direct tier, the proxy tier and the arrivals
 * request all send the same thing, and three hand-maintained copies of an
 * upstream contract is exactly how one of them drifts (spec §1.1 R2).
 * `Content-Type` is omitted for a bodyless request (zonal `/location/ruta`).
 */
function buildLiveApiHeaders(postData: string): Record<string, string | number> {
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
  if (postData) headers['Content-Type'] = 'application/json; charset=UTF-8';
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
  signal?: AbortSignal,
  parse?: (raw: Buffer, encoding: string | string[] | undefined, source: string) => Promise<any[]>
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
        controller.signal,
        parse
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
  const headers = buildLiveApiHeaders(context.postData);

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
  const headers = buildLiveApiHeaders(postData);

  console.log(`[TM API] fetchLiveBuses: type=${context.routeType} ruta=${context.routeCode} nombre=${context.destinationName} via=DIRECT`);
  try {
    const buses = await requestLiveJson(url, headers, postData, LIVE_REQUEST_TIMEOUT_MS, liveKeepAliveAgent, signal);
    clearDirectTierGeofence(); // this egress reaches the host after all
    return buses;
  } catch (error) {
    if (isGeofenceRejection(error)) markDirectTierGeofenced();
    throw error;
  }
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

  // Multi-candidate: fire all in parallel and resolve the MOMENT one returns
  // buses — waiting for every candidate to settle would pin the response to the
  // slowest one (the live host answers anywhere between 0.3 s and its 9 s
  // timeout), which lands squarely on the first fix of a tracking session.
  // A valid empty result and the error paths still need every candidate, since
  // only a non-empty hit proves the name matched (spec §5.2.4).
  const controller = new AbortController();
  const onParentAbort = () => controller.abort();
  signal?.addEventListener('abort', onParentAbort, { once: true });

  let pending = contexts.length;
  let emptyResult: any[] | null = null;
  let geofenced = false;

  try {
    return await new Promise<any[] | null>((resolve) => {
      const settle = (value: any[] | null) => {
        controller.abort(); // cancel the stragglers
        resolve(value);
      };

      for (const ctx of contexts) {
        fetcher(ctx, controller.signal).then(
          (buses) => {
            if (buses.length > 0) {
              console.log(`[TM API] ${label} candidate "${ctx.candidateName}" succeeded with ${buses.length} buses`);
              settle(buses);
              return;
            }
            emptyResult = buses;
            if (--pending === 0) settle(emptyResult);
          },
          (error: any) => {
            errors.push(`[${label} ${ctx.candidateName}] ${error?.message ?? error}`);
            if (shouldAbort?.(error)) geofenced = true;
            // A geofenced rejection means no candidate on this transport will
            // ever work, so a fully-failed strategy reports nothing at all.
            if (--pending === 0) settle(geofenced && emptyResult === null ? null : emptyResult);
          }
        );
      }
    });
  } finally {
    signal?.removeEventListener('abort', onParentAbort);
  }
}

/** Which transport actually answered a live-bus request. Lets the route layer
 *  decide how much to trust an empty result: `direct`/`co-relay` egress from a
 *  known Colombian IP (an empty list is genuinely "no buses"), whereas a free
 *  `public-co-proxy` empty is low-confidence (the proxy may have returned a
 *  silent/garbage body that merely parses to empty). */
export type LiveBusSource = 'direct' | 'co-relay' | 'public-co-proxy';

export interface LiveBusesResult {
  buses: any[];
  source: LiveBusSource;
}

export async function fetchLiveBuses(
  ruta: string,
  nombre: string,
  routeType: 'troncal' | 'zonal' = 'troncal',
  nombreCandidates: string[] = []
): Promise<LiveBusesResult> {
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
    // 1. Direct (works when the backend egress is Colombian). Skipped entirely
    // while the geofence memo is hot — the rejection is egress-wide, so paying
    // the round-trip again would only delay the relay.
    if (!isDirectTierGeofenced()) {
      const direct = await runLiveStrategy('direct', fetchLiveBusesDirect, contexts, errors, isGeofenceRejection, overallController.signal);
      if (direct) return { buses: direct, source: 'direct' };
    }

    // 2. Colombia relay (for non-Colombian hosts with a relay configured).
    const relay = await runLiveStrategy('co-relay', fetchLiveBusesViaColombiaRelay, contexts, errors, undefined, overallController.signal);
    if (relay) return { buses: relay, source: 'co-relay' };

    // 3. Public Colombian proxy (opt-in best-effort fallback).
    if (allowPublicColombianProxyFallback()) {
      const proxy = await runLiveStrategy('public-co-proxy', fetchLiveBusesViaColombianProxy, contexts, errors, undefined, overallController.signal);
      if (proxy) return { buses: proxy, source: 'public-co-proxy' };
    }

    throw new Error(`Live tracking unavailable: ${errors.join(' | ')}`);
  } finally {
    clearTimeout(overallTimer);
  }
}

// ─── Live path warm-up (cold-start removal) ───────────────
// The CO egress is a serverless OCI Function (§5.2.2a): idle it drops its
// container, so the FIRST live request of a tracking session pays a container
// cold start on top of the upstream's own (App Engine also idles down). A cheap
// periodic probe keeps both hot — and keeps the keep-alive sockets above open —
// so a user who starts tracking gets the warm latency, not the cold one.
const LIVE_WARMUP_INTERVAL_MS = Number(process.env.TM_LIVE_WARMUP_MS ?? 240_000);
const WARMUP_ROUTE = { ruta: '1', nombre: 'Universidades' };
let warmupTimer: NodeJS.Timeout | null = null;

async function warmLivePath(): Promise<void> {
  const context = createLiveRequestContext(WARMUP_ROUTE.ruta, WARMUP_ROUTE.nombre, 'troncal');
  try {
    if (getConfiguredColombiaRelayUrl()) await fetchLiveBusesViaColombiaRelay(context);
    else if (!isDirectTierGeofenced()) await fetchLiveBusesDirect(context);
  } catch (error) {
    // A failed warm-up is not a user-facing failure — the next real request
    // still runs the full cascade. Log it once per tick and move on.
    console.warn('[TM API] live warm-up failed:', (error as any)?.message || error);
  }
}

/** Starts the periodic live-path warm-up. Idempotent; `TM_LIVE_WARMUP_MS=0` disables it. */
export function startLiveWarmup(): void {
  if (warmupTimer || !(LIVE_WARMUP_INTERVAL_MS > 0)) return;
  void warmLivePath();
  warmupTimer = setInterval(() => void warmLivePath(), LIVE_WARMUP_INTERVAL_MS);
  warmupTimer.unref(); // never hold the process open
  console.log(`[TM API] Live warm-up every ${Math.round(LIVE_WARMUP_INTERVAL_MS / 1000)}s (TM_LIVE_WARMUP_MS=0 to disable)`);
}

// ─── Arrivals (llegadas at a paradero, spec §5.8) ─────────
const ARRIVALS_TIMEOUT_MS = 9_000;

/** Normalize the `/paradero/buses` response to a stable arrivals array. */
function normalizeArrivalsPayload(payload: any): any[] {
  const list = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.data) ? payload.data
    : Array.isArray(payload?.buses) ? payload.buses
    : Array.isArray(payload?.llegadas) ? payload.llegadas
    : Array.isArray(payload?.vehiculos) ? payload.vehiculos
    : [];
  return list
    .filter((it: any) => it && typeof it === 'object')
    .map((it: any) => ({
      codigo: String(it.ruta_extraida ?? it.codigo ?? '').trim(),
      idRuta: String(it.ruta_sae ?? it.idRuta ?? '').trim(),
      destino: String(it.destino_limpio ?? it.destino ?? it.nombre ?? '').trim(),
      color: String(it.color_ruta ?? it.color ?? '').trim(),
      paradero: String(it.labelparadero ?? it.paradero ?? '').trim(),
      tiempo: String(it.labeltiempo ?? it.tiempo ?? it.time ?? '').trim(),
      distancia: String(it.distancia ?? '').trim(),
    }))
    .filter((it: any) => it.codigo || it.destino);
}

export interface ArrivalsResult {
  arrivals: any[];
  /** `null` = no transport reached upstream (an empty list is NOT a verified
   *  "no buses inbound"). */
  source: LiveBusSource | null;
}

/**
 * Real-time arrivals at a paradero (`POST /paradero/buses`, spec §5.8). Reuses
 * the live transport tiers: direct (Colombian egress) → CO relay → public CO
 * proxy. Never throws for "no buses" — returns an empty list, with `source: null`
 * when no transport reached upstream at all, so the caller can tell a verified
 * "nothing inbound" from an outage (spec §1 certainty).
 */
export async function fetchArrivals(paradero: string): Promise<ArrivalsResult> {
  const cenefa = normalizeLiveText(paradero, LIVE_ROUTE_CODE_MAX_LENGTH);
  if (!cenefa) return { arrivals: [], source: null };

  const url = new URL(`${LIVE_API_ORIGIN}/paradero/buses`);
  const postData = JSON.stringify({ paradero: cenefa });
  const headers = buildLiveApiHeaders(postData);

  const overall = new AbortController();
  const timer = setTimeout(() => overall.abort(), LIVE_OVERALL_TIMEOUT_MS);
  try {
    // 1. Direct (works when the backend egress is Colombian: local / CO host).
    // Skipped while the geofence memo is hot — same egress, same rejection.
    if (!isDirectTierGeofenced()) {
      try {
        const arrivals = await requestLiveJson(url, headers, postData, ARRIVALS_TIMEOUT_MS, liveKeepAliveAgent, overall.signal, parseArrivalsResponse);
        clearDirectTierGeofence();
        return { arrivals, source: 'direct' };
      } catch (error) {
        if (isGeofenceRejection(error)) markDirectTierGeofenced();
        else console.warn('[TM API] arrivals direct failed:', (error as any)?.message || error);
      }
    }

    // 2. Colombia relay (OCI Function, Bogotá egress) — reliable CO path.
    if (isColombiaRelayConfigured()) {
      try {
        const { upstreamStatus, payload } = await relayForward('/paradero/buses', { paradero: cenefa }, ARRIVALS_TIMEOUT_MS, overall.signal);
        if (upstreamStatus === 200) {
          return { arrivals: normalizeArrivalsPayload(payload), source: 'co-relay' };
        }
        console.warn(`[TM API] arrivals CO relay upstream status ${upstreamStatus}`);
      } catch (error) {
        console.warn('[TM API] arrivals CO relay failed:', (error as any)?.message || error);
      }
    }

    // 3. Public Colombian proxy (opt-in prod fallback, §5.2.5).
    if (allowPublicColombianProxyFallback()) {
      const { ProxyManager, SimpleProxyAgent } = await import('./proxy_manager.js');
      if ((await ProxyManager.waitForReady(CO_PROXY_READY_TIMEOUT_MS)) > 0) {
        const tried = new Set<string>();
        for (let wave = 1; wave <= CO_PROXY_MAX_WAVES; wave++) {
          if (overall.signal.aborted) break;
          const proxies = ProxyManager.getProxies(CO_PROXY_RACE_WIDTH, tried);
          if (proxies.length === 0) break;
          for (const p of proxies) tried.add(`${p.ip}:${p.port}`);
          try {
            const arrivals = await raceProxyWave(proxies, url, headers, postData, SimpleProxyAgent, ProxyManager, overall.signal, parseArrivalsResponse);
            return { arrivals, source: 'public-co-proxy' };
          } catch {
            /* dead wave — try the next */
          }
        }
      }
    }
    // Nothing reached upstream. Reporting `direct` here would claim a Colombian
    // egress verified an empty arrivals board when in fact none answered.
    return { arrivals: [], source: null };
  } finally {
    clearTimeout(timer);
  }
}
