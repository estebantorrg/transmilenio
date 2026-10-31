/**
 * TransMilenio Mobile App API Client & Scraper
 *
 * Fetches station/wagon/route data directly from the official TransMi app API.
 * Builds a master catalog keyed by station code → wagon label → routes.
 */

import https from 'https';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import zlib from 'zlib';
import { createHash } from 'crypto';
import { promisify } from 'util';
import { isColombiaRelayConfigured, relayAgentFor, relayBaseUrl, relaySecret } from './co_relay.js';
import { collectBody, decodeBody } from './upstream_body.js';
import { isIdRefused, nextProxyUuid, OFFICIAL_APP_HEADERS } from './official_app_headers.js';
import { forgetLiveName, recallLiveName, rememberLiveName } from '../../../shared/live_name_memo.js';
import { traceToPaths } from '../../../shared/eta_geometry.js';
import { createSharedWindow } from './flow_control.js';
import {
  buildLiveNameCandidates,
  createLiveRequestContext,
  raceLiveCandidates,
  requestLiveBuses,
  requestLiveJson,
  type LiveRequestContext,
} from './live_request.js';
import { CO_PROXY_TIMEOUT_MS, viaColombianProxy } from './proxy_race.js';
import {
  ROUTE_RETENTION_DAYS,
  applyPlanoWagons,
  dropRenamedInPlace,
  dropRetiredVariants,
  expireUnseenVariants,
  isDuplicateRoute,
  mergeCatalogs,
  pruneUnservedStationRoutes,
  variantKey,
  type CatalogRoute,
  type CatalogRouteDetail,
  type CatalogStation,
  type CatalogWagons,
  type MasterCatalog,
  type RouteTrace,
} from './catalog_merge.js';
import {
  layoutServices,
  planoDetalle,
  planoGeo,
  planoLayout,
  plateWagon,
  printedVagonLabels,
  type PlanoDetalle,
  type PlanoLayout,
} from './plano_vagones.js';
import { buildWagonPlan, stationCorridor } from './station_plan.js';
import { stationAvisos } from './avisos.js';
import { platformsOf } from '../../../shared/station_platforms.js';
import { isTroncalStationCode, troncalStationEntry, unregisteredServedStations } from './station_registry.js';
import { publicProxyAllowed } from './public_proxy_policy.js';
import {
  applyStopAliases,
  correctRecorrido,
  isRetiredRoute,
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
  ...OFFICIAL_APP_HEADERS,
};

const MIN_DELAY_MS = 800;
const MAX_DELAY_MS = 1500;
const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 3000;
const STALE_DAYS = 7;
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

/**
 * Decimals kept on the browser catalog's coordinates. Upstream ships 13–15
 * (sub-millimetre), and those random digits were most of the gzipped payload:
 * rounding took it from 4.3 to 2.4 MB, the bulk of a first visit from a search
 * result. 6 is ~0.1 m for a stop or a station; a trace gets 5 (~1 m), still finer
 * than the 5.5 m its simplification already gives up (`TRACE_SIMPLIFY_EPSILON`).
 */
const LIGHT_POINT_DECIMALS = 6;
const LIGHT_TRACE_DECIMALS = 5;

/** A `"lat,lon"` string with each number cut to {@link LIGHT_POINT_DECIMALS}. */
function lightCoordenada<T>(coordenada: T): T {
  if (typeof coordenada !== 'string') return coordenada;
  return coordenada.replace(/-?\d+\.\d+/g, (n) => String(Number(Number(n).toFixed(LIGHT_POINT_DECIMALS)))) as T;
}

const lightTracePoint = (point: number[]): number[] => point.map((n) => Number(n.toFixed(LIGHT_TRACE_DECIMALS)));

// ─── Types ──────────────────────────────────────────────

export type { CatalogRoute, CatalogRouteDetail, CatalogStation, CatalogWagons, MasterCatalog } from './catalog_merge.js';

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
let lightCatalogEtagValue = '';
let lightCatalogStationCount = 0;
// De-dupes concurrent first-hit builds so a burst of requests compresses once.
let lightCatalogBuilding: Promise<LightCatalogArtifact> | null = null;
let catalogLoadedAt: number = 0;

const gzipAsync = promisify(zlib.gzip);

/** Drop the cached gzip body so the next request rebuilds it from the new catalog. */
function invalidateLightCatalog(): void {
  lightCatalogGzip = null;
  lightCatalogEtagValue = '';
  lightCatalogStationCount = 0;
  // A build already in flight was started from the catalog that has just been
  // replaced, so it is detached here too. Leaving it attached handed its stale
  // body to the next request — which computes the ETag from the NEW
  // `catalogLoadedAt` — and then cached it, so every client cached the previous
  // catalog under the current validator for the full 30-minute `max-age`. That
  // is the §5.5.6 trap (the validator names the shape, the body is older than
  // it says) one layer down, and it survives until the next sync.
  lightCatalogBuilding = null;
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
    const path = simplifyLine(paths[0], LIGHT_TRACE_MAX_POINTS).map(lightTracePoint);
    return path.length > 1 ? path : undefined;
  }

  const maxPerPath = Math.max(2, Math.floor(LIGHT_TRACE_MAX_POINTS / paths.length));
  const simplified = paths
    .map((path) => simplifyLine(path, maxPerPath).map(lightTracePoint))
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

      // The station's drawn shape, for the staggered stations whose platforms
      // the catalog's lettered wagons cannot express (§5.5.4). Reconciled here,
      // where both the sheet and the catalog's own services are in hand: a
      // layout naming a service this station does not run, or missing one it
      // does, is a sheet that has drifted from the network, and a stale drawing
      // of a platform is worse than no drawing at all.
      const layout = planoLayout(station.codigo);
      let planoLayoutOut: PlanoLayout | undefined;
      // The full drawn station, for the estación page. Not gated against the
      // catalog the way the layout is: it carries no services of its own —
      // its vagones are numbers, and the services behind them come from the
      // layout, which IS gated. Furniture cannot drift out of date the way a
      // service list can; a taquilla is where the sheet put it.
      // Columns only. Its `source` and `why` are why the furniture is on file,
      // which belongs in the file and not in a payload every visitor downloads —
      // the same rule the layout above follows.
      // A portal's measured geometry, where its sheet has been read that way.
      const geoOut = planoGeo(station.codigo);
      // And each platform's own, for a stop the catalog files as one and that is
      // two stations on two sheets (Ricaurte, Av. Jiménez): a platform page
      // draws its own sheet, never its parent's (`platformStation`).
      const geoPlataformas = Object.fromEntries(
        platformsOf(station.codigo)
          .map((p: { codigo: string }) => [p.codigo, planoGeo(p.codigo)] as const)
          .filter(([, geo]) => geo !== undefined)
      );
      // Operator notices not yet ended. Which of them is in force is the
      // browser's call (`shared/avisos.js`): this payload outlives a night.
      const avisosOut = stationAvisos(station.codigo);
      const detalleRead = planoDetalle(station.codigo);
      const detalleOut: PlanoDetalle | undefined = detalleRead
        ? {
            ...(detalleRead.filas
              ? { filas: detalleRead.filas, ...(detalleRead.alineadas ? { alineadas: true } : {}) }
              : { columnas: detalleRead.columnas }),
            ...(detalleRead.zonal ? { zonal: detalleRead.zonal } : {}),
          }
        : undefined;
      if (layout) {
        const claimed = layoutServices(layout);
        // Every service the station files, wagon "0" included. A sheet places
        // what the catalog left unplaced — that is half the reason to read one —
        // so measuring the layout only against the LETTERED wagons rejected it
        // for "extra" códigos that are in fact filed here, just without a
        // platform. El Tiempo puts K86 and M86 on vagones the catalog leaves
        // blank, and its layout was refused for saying so.
        const served = new Set<string>();
        const boards = new Set<string>();
        for (const [wagon, routes] of Object.entries(cleanWagons)) {
          for (const route of routes) {
            const code = String(route.codigo ?? '').trim().toUpperCase();
            if (!code) continue;
            served.add(code);
            // Only a service that boards a platform must appear in the drawing.
            // A zonal parked in the integration zone has no vagón to be drawn on
            // and its absence is not the sheet drifting.
            const troncal = route.tipoServicio === 'TRONCAL' || route.tipoServicio === 'PADRON';
            if (wagon !== '0' || troncal) boards.add(code);
          }
        }
        const missing = [...boards].filter((c) => !claimed.has(c));
        const extra = [...claimed].filter((c) => !served.has(c));
        // Only a PHANTOM is fatal. The two disagreements are not symmetric:
        //
        //   • `extra` — the sheet draws a service the station does not run — is
        //     a drawing that lies about where a bus stops, and no drawing is
        //     better than that.
        //   • `missing` — the catalog runs a service the sheet does not draw —
        //     is just a sheet older than the network, which every sheet is.
        //     CAN's is stamped November 2025 and the catalog has gained K53 and
        //     G53 since; Corferias, Gobernación and the rest of Calle 26 will
        //     all drift the same way as services are added.
        //
        // `missing` used to be fatal too, which meant a split station lost its
        // true shape and fell back to a bar the moment one new service reached
        // it — trading a drawing that is incomplete for one that is wrong. The
        // client now lists every service a layout does not place, under the
        // drawing, so an unplaced service is shown rather than lost, and that
        // is what makes this safe to warn about instead of reject.
        if (extra.length === 0) {
          if (missing.length > 0) {
            console.warn(
              `[TM API] ${station.codigo}: plano layout does not place ${missing.join(', ')} — ` +
                'sheet is older than the catalog; drawn anyway, unplaced services listed below it.'
            );
          }
          // Rows only. The entry's `source` and `why` are why the shape is on
          // file, which belongs in the file and not in a 4 MB payload every
          // visitor downloads.
          planoLayoutOut = { rows: layout.rows, ...(layout.divider ? { divider: layout.divider } : {}) };
        } else {
          console.warn(
            `[TM API] ${station.codigo}: plano layout draws a service the station ` +
              `does not run: ${extra.join(', ')}; layout dropped, re-read the plano.`
          );
        }
      }

      cleanStations[code] = {
        id: station.id,
        codigo: station.codigo,
        nombre: station.nombre,
        // Upstream files some stations' address as their name (Calle 53 – UMB,
        // 2026-10): read as an address, every surface printed the name twice and
        // the estación page answered "¿Dónde queda X?" with "X queda en X".
        ...(station.direccion !== station.nombre ? { direccion: station.direccion } : {}),
        coordenada: lightCoordenada(station.coordenada),
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
        ...(planoLayoutOut ? { planoLayout: planoLayoutOut } : {}),
        ...(detalleOut ? { planoDetalle: detalleOut } : {}),
        ...(geoOut ? { planoGeo: geoOut } : {}),
        ...(Object.keys(geoPlataformas).length ? { planoGeoPlataformas: geoPlataformas } : {}),
        ...(avisosOut ? { avisos: avisosOut } : {}),
        wagons: cleanWagons,
      };
    } else {
      cleanStations[code] = {
        codigo: station.codigo,
        nombre: station.nombre,
        coordenada: lightCoordenada(station.coordenada),
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
        stops: (route.stops || []).map((stop: any) => ({ ...stop, coordenada: lightCoordenada(stop.coordenada) })),
        trazado: simplifyTraceForLight(route.trazado),
      };
    });
  }

  return {
    stations: cleanStations,
    routes: cleanRoutes,
  };
}

/**
 * The catalog's version — and its ETag — is a hash of the bytes it names.
 *
 * It used to be `catalog-<syncedAt>`, which identifies the catalog the payload
 * was built *from* rather than the payload — and everything else this endpoint
 * ships is built from files the sync never touches: `plano_vagones.json`,
 * `station_corridors.json`, the register. Edit one of those and the body
 * changes while the validator does not, so every cache goes on serving the old
 * bytes. The service worker is network-first with `cache: 'no-cache'`, which
 * makes it *worse*, not better: it dutifully revalidates, gets a `304` naming
 * an ETag that never moved, and serves the stale body with full confidence.
 * That is what hid `corridor.sentidos` and then `destinos` from the browser
 * while the API plainly returned both — twice in one afternoon, each time
 * looking like the renderer was broken.
 *
 * A hand-bumped shape counter fixed the first case and missed the second,
 * because the second was a data edit and not a shape change. There is no
 * version of that counter someone will remember to bump. Hashing the data
 * costs one pass per catalog build and cannot be forgotten.
 *
 * The hash also travels IN the body (`version`), because the app has no ETag
 * to read: it ships this body inside the APK (`bundle_mobile_data.ts`) and keeps
 * a copy in IndexedDB, and it judged "changed" by counting stations and routes —
 * so a release that moved K43 off CAD, same counts, left every updated phone on
 * the cached catalog that still drew it there.
 */
function lightCatalogVersion(dataJson: string): string {
  return createHash('sha1').update(dataJson).digest('hex').slice(0, 16);
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
 *
 * The build carries the catalog version it was started from, and the ETag it
 * answers with is that version's — never whatever `catalogLoadedAt` happens to
 * be when it finishes. A body and the validator that names it are one thing: a
 * sync landing mid-build must not be able to publish the previous catalog under
 * the new tag, nor overwrite a fresher buffer on the way out (see
 * {@link invalidateLightCatalog}). A caller already waiting on a superseded
 * build still gets that build's own body under that build's own tag, which is
 * the same read-continuity §4.3 asks of the catalog itself.
 */
export async function getCatalogLightGzip(): Promise<LightCatalogArtifact> {
  if (lightCatalogGzip) {
    return {
      gzip: lightCatalogGzip,
      count: lightCatalogStationCount,
      etag: lightCatalogEtagValue,
    };
  }
  if (!lightCatalogBuilding) {
    const version = catalogLoadedAt;
    const build = (async (): Promise<LightCatalogArtifact> => {
      const light = buildCatalogLight();
      const count = Object.keys(light.stations).length;
      // Spliced rather than stringified twice: the data is ~15 MB of JSON on a
      // 512 MB instance, and the body's `version` has to be its hash.
      const dataJson = JSON.stringify(light);
      const contentVersion = lightCatalogVersion(dataJson);
      const gzip = await gzipAsync(`{"success":true,"version":"${contentVersion}","count":${count},"data":${dataJson}}`);
      const etag = `W/"catalog-${contentVersion}"`;
      // Publish only while this is still the catalog on disk.
      if (catalogLoadedAt === version) {
        lightCatalogGzip = gzip;
        lightCatalogEtagValue = etag;
        lightCatalogStationCount = count;
      }
      return { gzip, count, etag };
    })();
    lightCatalogBuilding = build;
    // Release the slot on settle, but only if it is still this build's — a sync
    // may already have detached it in favour of a newer one.
    void build.catch(() => undefined).then(() => {
      if (lightCatalogBuilding === build) lightCatalogBuilding = null;
    });
  }
  return lightCatalogBuilding;
}

/**
 * Whether `code` is a route this catalog files. A live request names its route
 * in free text and the server forwards it, so this is the check that keeps a
 * made-up código from becoming upstream traffic (spec §3.4). With no catalog
 * loaded there is nothing to check against, and nothing is refused.
 */
export function isCatalogRouteCode(code: string): boolean {
  return routeCodeIndex().size === 0 || routeCodeIndex().has(code.trim().toUpperCase());
}

/** The variants the catalog files under `code` (any letter case), or none. */
export function catalogRouteVariants(code: string): CatalogRouteDetail[] {
  const key = routeCodeIndex().get(code.trim().toUpperCase());
  return key === undefined ? [] : masterCatalog.routes[key];
}

// UPPER-CASED código → the catalog's own key, built once per catalog: every live
// request asks, and walking ~800 keys each time is work on a 0.1-CPU instance.
let routeCodes: { of: MasterCatalog; byUpper: Map<string, string> } | null = null;

function routeCodeIndex(): Map<string, string> {
  if (routeCodes?.of !== masterCatalog) {
    const keys = Object.keys(masterCatalog.routes || {});
    routeCodes = { of: masterCatalog, byUpper: new Map(keys.map((key) => [key.toUpperCase(), key])) };
  }
  return routeCodes.byUpper;
}

export function isCatalogStale(): boolean {
  if (!masterCatalog.stations || Object.keys(masterCatalog.stations).length === 0) return true;
  if (catalogLoadedAt === 0) return true;
  return Date.now() - catalogLoadedAt > STALE_DAYS * 24 * 60 * 60 * 1000;
}

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
  const renamed = dropRenamedInPlace(masterCatalog);
  if (renamed > 0) {
    console.log(`[TM API] Dropped ${renamed} route variant(s) whose id was re-listed under a new name.`);
  }
  const retired = dropRetiredVariants(masterCatalog);
  if (retired > 0) {
    console.log(`[TM API] Dropped ${retired} route variant(s) filed as replaced in recorrido_corrections.json.`);
  }
  // Before the prune, which reads each recorrido's stop codes as its evidence.
  const aliased = applyStopAliases(masterCatalog);
  if (aliased > 0) {
    console.log(`[TM API] Filed ${aliased} aliased stop(s) and mapping(s) under their real station.`);
  }
  const placed = applyPlanoWagons(masterCatalog);
  if (placed > 0) {
    console.log(`[TM API] Placed ${placed} unlettered mapping(s) on the vagón their plano prints.`);
  }
  const pruned = pruneUnservedStationRoutes(masterCatalog);
  if (pruned > 0 || retired > 0 || placed > 0 || renamed > 0 || aliased > 0) {
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
          
          // Ciclovía-aware: a route's Sunday detour is its own variant (`variantKey`).
          const routeExists = newCatalog.routes[route.codigo].some(
            (r) => variantKey(r.nombre) === variantKey(route.nombre)
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
    // Retained data predates the stop aliases the fetch applied at the edge.
    applyStopAliases(merged);

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
      new Set(Object.keys(newCatalog.routes).map((code) => code.toUpperCase().trim())),
      healthy
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

export const LIVE_TRACKING_VERSION = 'colombia-relay-v1';
const LIVE_REQUEST_TIMEOUT_MS = 9_000;
const COLOMBIA_RELAY_TIMEOUT_MS = 12_000;

// Live requests repeat every 15 s per tracking client, so the TCP+TLS handshake
// is pure cold-start cost on every poll. Keeping the sockets alive removes it
// (~200-400 ms/poll) and, together with the warm-up below, means the first poll
// of a tracking session reuses an already-open connection.
const liveKeepAliveAgent = new https.Agent({ keepAlive: true, keepAliveMsecs: 15_000, maxSockets: 12 });

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

// Live buses may use the public CO proxy pool (spec §5.2.5).
function allowPublicColombianProxyFallback(): boolean {
  return publicProxyAllowed('live');
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
  const relayUrl = relayBaseUrl();
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
  const secret = relaySecret();
  if (secret) headers.Authorization = `Bearer ${secret}`;

  console.log(`[TM API] fetchLiveBuses: type=${context.routeType} ruta=${context.routeCode} nombre=${context.destinationName} via=CO relay ${url.origin}`);
  return requestLiveJson(url, headers, postData, COLOMBIA_RELAY_TIMEOUT_MS, relayAgentFor(url), signal);
}

/** One live request through the public CO proxy pool (`proxy_race.ts`, spec §5.2.5). */
function fetchLiveBusesViaColombianProxy(context: LiveRequestContext, signal?: AbortSignal): Promise<any[]> {
  return viaColombianProxy(
    `buses type=${context.routeType} ruta=${context.routeCode} nombre=${context.destinationName}`,
    (agent, proxySignal) => requestLiveBuses(context, CO_PROXY_TIMEOUT_MS, agent, proxySignal, nextProxyUuid()),
    signal
  );
}

/**
 * Direct call to the live API host. This is the primary path: when the backend
 * itself runs with a Colombian egress IP (local/CO-hosted), it works with no
 * relay or proxy. From a non-Colombian host the geofence answers 401/451, which
 * fails fast and falls through to the relay below.
 */
async function fetchLiveBusesDirect(context: LiveRequestContext, signal?: AbortSignal): Promise<any[]> {
  console.log(`[TM API] fetchLiveBuses: type=${context.routeType} ruta=${context.routeCode} nombre=${context.destinationName} via=DIRECT`);
  try {
    const buses = await requestLiveBuses(context, LIVE_REQUEST_TIMEOUT_MS, liveKeepAliveAgent, signal);
    clearDirectTierGeofence(); // this egress reaches the host after all
    return buses;
  } catch (error) {
    if (isGeofenceRejection(error)) markDirectTierGeofenced();
    throw error;
  }
}

/** A non-Colombian egress is rejected by the geofence — an egress-wide verdict,
 *  which is what the memo above remembers. */
function isGeofenceRejection(error: any): boolean {
  return /Status: (401|451)/.test(String(error?.message || ''));
}

/** Overall budget for the entire live-bus cascade (all strategies + candidates).
 *  Must be under the client's 15 s timeout so the server answers before the
 *  browser gives up, leaving room for the stale-cache fallback. */
const LIVE_OVERALL_TIMEOUT_MS = 14_500;

/** One transport strategy across every name candidate (`raceLiveCandidates`,
 *  `live_request.ts`); a candidate's failure lands in `errors`. */
function runLiveStrategy(
  label: string,
  fetcher: (context: LiveRequestContext, signal?: AbortSignal) => Promise<any[]>,
  contexts: LiveRequestContext[],
  errors: string[],
  signal?: AbortSignal,
  onHit?: (context: LiveRequestContext) => void
): Promise<any[] | null> {
  return raceLiveCandidates(contexts, fetcher, {
    signal,
    onHit,
    onError: (context, error) => errors.push(`[${label} ${context.candidateName}] ${error?.message ?? error}`),
  });
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

/** The tier cascade for one candidate set: direct → CO relay → public CO proxy. */
async function runLiveTiers(
  contexts: LiveRequestContext[],
  errors: string[],
  signal: AbortSignal,
  onHit: (context: LiveRequestContext) => void
): Promise<LiveBusesResult | null> {
  // 1. Direct (works when the backend egress is Colombian). Skipped entirely
  // while the geofence memo is hot — the rejection is egress-wide, so paying
  // the round-trip again would only delay the relay.
  if (!isDirectTierGeofenced()) {
    const direct = await runLiveStrategy('direct', fetchLiveBusesDirect, contexts, errors, signal, onHit);
    if (direct) return { buses: direct, source: 'direct' };
  }

  // 2. Colombia relay (for non-Colombian hosts with a relay configured).
  const relay = await runLiveStrategy('co-relay', fetchLiveBusesViaColombiaRelay, contexts, errors, signal, onHit);
  if (relay) return { buses: relay, source: 'co-relay' };

  // 3. Public Colombian proxy (opt-in best-effort fallback).
  if (allowPublicColombianProxyFallback()) {
    const proxy = await runLiveStrategy('public-co-proxy', fetchLiveBusesViaColombianProxy, contexts, errors, signal, onHit);
    if (proxy) return { buses: proxy, source: 'public-co-proxy' };
  }

  return null;
}

// The live host refreshes a route's positions about every 47 s (measured,
// `tests/live-footprint.spec.ts`), so riders watching the same route are asking
// the same question: they share one cascade while it runs and its answer for
// this long after. Under the 15 s poll (spec §3.4), so a rider alone on a route
// still gets a new answer on every poll.
const LIVE_SHARED_WINDOW_MS = 10_000;
const LIVE_SHARED_MAX = 400; // bounded like the name memo
const sharedLiveBuses = createSharedWindow<LiveBusesResult>(LIVE_SHARED_WINDOW_MS, LIVE_SHARED_MAX);

/**
 * Live buses for a route, through the tier cascade. Upstream load follows the
 * number of routes being watched, not the number of people watching them: the
 * name candidates are part of the identity (the direction is in the name, spec
 * §5.2.4), and `/api/buses` and the stop-arrivals fan-out both come through here.
 * A zonal request carries the route code and nothing else, so its names are
 * not part of who shares the answer — a tracker and a stop board asking about
 * one route used to make two identical upstream calls.
 */
export function fetchLiveBuses(
  ruta: string,
  nombre: string,
  routeType: 'troncal' | 'zonal' = 'troncal',
  nombreCandidates: string[] = []
): Promise<LiveBusesResult> {
  const identity = routeType === 'zonal' ? [routeType, ruta] : [routeType, ruta, nombre, ...nombreCandidates];
  const key = identity.join('|').toLowerCase();
  return sharedLiveBuses(key, () => runLiveCascade(ruta, nombre, routeType, nombreCandidates));
}

async function runLiveCascade(
  ruta: string,
  nombre: string,
  routeType: 'troncal' | 'zonal',
  nombreCandidates: string[]
): Promise<LiveBusesResult> {
  // Every tier would carry the refused id (`official_app_headers.ts`), so there is no one to ask.
  if (isIdRefused()) throw new Error('Live host refuses this install id; live requests paused');
  const contexts = routeType === 'zonal'
    ? [createLiveRequestContext(ruta, nombre, routeType)]
    : buildLiveNameCandidates(nombre, nombreCandidates)
        .map((candidate) => createLiveRequestContext(ruta, nombre, routeType, candidate));
  const primaryContext = contexts[0];
  const errors: string[] = [];

  if (!primaryContext?.routeCode) {
    throw new Error('ruta is required');
  }

  const routeCode = primaryContext.routeCode;
  const memoKey = `${routeType}:${routeCode}`;
  const remember = (context: LiveRequestContext) => rememberLiveName(memoKey, context.candidateName);

  // Overall budget: abort everything if the cascade exceeds the wall-clock cap.
  const overallController = new AbortController();
  const overallTimer = setTimeout(() => overallController.abort(), LIVE_OVERALL_TIMEOUT_MS);

  try {
    // One remembered name instead of the whole fan-out. A troncal poll fires
    // every candidate in parallel (up to LIVE_NAME_CANDIDATE_LIMIT) and only one
    // of them can match, so a tracking session used to re-ask the live host the
    // same 11 dead questions every 15 s — pure load on an upstream that has
    // already blocklisted one id over volume (spec §5.2.3, §5.2.5).
    const memo = recallLiveName(memoKey);
    const memoContext = memo ? contexts.find((ctx) => ctx.candidateName === memo.name) : undefined;
    if (memoContext && contexts.length > 1) {
      const hit = await runLiveTiers([memoContext], errors, overallController.signal, remember);
      if (hit && hit.buses.length > 0) return hit;
      // Empty from the remembered name is the route's real answer while the memo
      // is fresh (no buses right now); once it is stale the name itself is the
      // suspect, so fall through and re-ask every candidate.
      if (hit && memo!.fresh) return hit;
      forgetLiveName(memoKey);
    }

    const result = await runLiveTiers(contexts, errors, overallController.signal, remember);
    if (result) return result;

    throw new Error(`Live tracking unavailable: ${errors.join(' | ')}`);
  } finally {
    clearTimeout(overallTimer);
  }
}

// ─── Live path warm-up (cold-start removal) ───────────────
// For a CO relay that idles down (the serverless backend this was written
// against dropped its container, §5.2.2a), the FIRST live request of a tracking
// session pays that cold start on top of the upstream's own (App Engine also
// idles down). A cheap periodic probe keeps both hot — and keeps the keep-alive
// sockets above open — so a user who starts tracking gets the warm latency, not
// the cold one.
//
// Only with a relay. Without one the probe could only ask the live host
// directly, which a non-CO host is 401-ed on: ~6 refused requests an hour, in
// the official app's name, to a host that has already blocklisted an id over
// volume (§5.2.3) — and that is what an unset `TM_LIVE_WARMUP_MS` used to do.
const LIVE_WARMUP_INTERVAL_MS = Number(process.env.TM_LIVE_WARMUP_MS ?? 240_000);
const WARMUP_ROUTE = { ruta: '1', nombre: 'Universidades' };
let warmupTimer: NodeJS.Timeout | null = null;

async function warmLivePath(): Promise<void> {
  const context = createLiveRequestContext(WARMUP_ROUTE.ruta, WARMUP_ROUTE.nombre, 'troncal');
  try {
    await fetchLiveBusesViaColombiaRelay(context);
  } catch (error) {
    // A failed warm-up is not a user-facing failure — the next real request
    // still runs the full cascade. Log it once per tick and move on.
    console.warn('[TM API] live warm-up failed:', (error as any)?.message || error);
  }
}

/** Starts the periodic relay warm-up. Idempotent; a no-op with no relay, and
 *  `TM_LIVE_WARMUP_MS=0` disables it. */
export function startLiveWarmup(): void {
  if (warmupTimer || !(LIVE_WARMUP_INTERVAL_MS > 0) || !isColombiaRelayConfigured()) return;
  void warmLivePath();
  warmupTimer = setInterval(() => void warmLivePath(), LIVE_WARMUP_INTERVAL_MS);
  warmupTimer.unref(); // never hold the process open
  console.log(`[TM API] Live warm-up every ${Math.round(LIVE_WARMUP_INTERVAL_MS / 1000)}s (TM_LIVE_WARMUP_MS=0 to disable)`);
}
