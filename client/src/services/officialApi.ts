/**
 * Official-host direct client (native app only)
 *
 * Inside the Android app (`mobile/`), native HTTP (`CapacitorHttp`) is exempt
 * from browser CORS and egresses from the phone's own Colombian connection. That
 * lets the app be a true peer of the official TransMi app: it talks to the same
 * government / public hosts **directly**, never through our web server (spec
 * §5.2.1b). This module mirrors, on-device, what our Express backend does for
 * the browser client — so `api.ts` can serve the app straight from source:
 *
 *   • ArcGIS FeatureServer  (`gis.transmilenio.gov.co`)   — troncal/zonal layers (spec §5.3)
 *   • Live/Bodega host      (`tmsa-transmiapp-…appspot`)  — arrivals + card ledger (spec §5.8, §5.5.1a)
 *   • Public OSRM foot      (`routing.openstreetmap.de`)   — walking-route geometry (spec §5.6)
 *
 * The master catalog + offline POI/demand datasets have no single official
 * endpoint, so the app reads those from APK-bundled assets instead (spec §5.2.1b,
 * `client/mobile/src/data.ts`) — they are not handled here.
 *
 * Every function assumes it runs natively; callers in `api.ts` gate on
 * `isNativeLiveAvailable()`. The response shapes match the corresponding
 * `/api/*` endpoints exactly, so the shared client code is unchanged (spec §1.1 R2).
 */

import type { ApiResponse } from '../types/transmilenio';
import { BOGOTA_BOUNDS, isWithinBogota } from '../utils/geo';
import { LIVE_HOST, APPID, nativeHttpRequest } from './nativeLive';
import { installUuid } from './installId';
import { normalizeArrivalsPayload } from '../../../shared/live_payload.js';
import { isCardNumber, isLedgerRow, ledgerMovement, maskCardNumber } from '../../../shared/card_ledger.js';
import { FOOT_HEADERS, FOOT_MIN_INTERVAL_MS, createPacer, footRouteUrl, readFootRoute } from '../../../shared/osrm_foot.js';
import type {
  ArrivalsResponse,
  CardBalanceRead,
  CardBalanceResponse,
  WalkingRouteResponse,
} from './api';

// ─── ArcGIS FeatureServer (mirrors server/src/services/arcgis.ts) ──────────
const ARCGIS_BASE = 'https://gis.transmilenio.gov.co/arcgis/rest/services';
const ARCGIS_TIMEOUT_MS = 15_000;
const ARCGIS_PAGE_SIZE = 2000;

interface ArcgisConfig {
  folder: string;
  service: string;
  layerIndex?: number;
  where?: string;
  outFields?: string;
  outSR?: number;
  returnGeometry?: boolean;
}

function parseJson(data: unknown): any {
  return typeof data === 'string' ? JSON.parse(data) : data;
}

/** Paginate an ArcGIS layer (cursor on `exceededTransferLimit`, spec §5.3.1). */
async function arcgisQuery(cfg: ArcgisConfig): Promise<any[]> {
  const layerIndex = cfg.layerIndex ?? 0;
  const base = `${ARCGIS_BASE}/${cfg.folder}/${cfg.service}/FeatureServer/${layerIndex}/query`;
  const features: any[] = [];
  let offset = 0;
  let hasMore = true;

  while (hasMore) {
    const params = new URLSearchParams({
      where: cfg.where ?? '1=1',
      outFields: cfg.outFields ?? '*',
      outSR: String(cfg.outSR ?? 4326),
      f: 'json',
      resultRecordCount: String(ARCGIS_PAGE_SIZE),
      resultOffset: String(offset),
      returnGeometry: String(cfg.returnGeometry ?? true),
    });

    const res = await nativeHttpRequest({ method: 'GET', url: `${base}?${params.toString()}`, timeoutMs: ARCGIS_TIMEOUT_MS });
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`ArcGIS ${res.status} for ${cfg.folder}/${cfg.service}`);
    }
    const data = parseJson(res.data);
    if (data?.error) {
      const details = Array.isArray(data.error.details) ? ` ${data.error.details.join(' ')}` : '';
      throw new Error(`${data.error.message ?? 'ArcGIS query failed'}${details}`);
    }

    const page: any[] = data?.features ?? [];
    if (page.length > 0) {
      features.push(...page);
      offset += page.length;
    }
    hasMore = data?.exceededTransferLimit === true && page.length > 0;
  }

  return features;
}

async function arcgisResponse(cfg: ArcgisConfig): Promise<ApiResponse<any>> {
  const features = await arcgisQuery(cfg);
  return { success: true, count: features.length, features };
}

// Layer configs mirror `queries` in server/src/services/arcgis.ts — keep in sync.
const ARCGIS_LAYERS = {
  troncalCorridors: { folder: 'ConsultaSubgerenciaPlanificacionSITP', service: 'Consulta_Planificacion_SITP', layerIndex: 5 },
  zonalRoutes: {
    folder: 'Zonal',
    service: 'consulta_rutas_zonales',
    outFields: 'route_name_ruta_zonal,codigo_definitivo_ruta_zonal,zona_origen_ruta_zonal,zona_destino_ruta_zonal',
    returnGeometry: false,
  },
  zonalStops: { folder: 'Zonal', service: 'consulta_paraderos_zonales' },
  // `orden` (e.g. "CBO012"/"NOR045") carries the riding sequence per direction.
  // `buildZonalStopGroups` splits on its prefix and sorts on its number; without
  // the field every stop of a route collapses into one group in objectid order
  // and the planner graph chains them arbitrarily (spec §5.4.2a).
  zonalStopRoutes: { folder: 'Zonal', service: 'consulta_paraderos_rutas', outFields: 'cenefa,ruta,orden', returnGeometry: false },
  // TransMiCable (spec §5.3) — same service, two layers (mirrors server arcgis.ts).
  cableStations: { folder: 'ConsultaSubgerenciaPlanificacionSITP', service: 'Consulta_Planificacion_SITP', layerIndex: 11 },
  cableTraces: { folder: 'ConsultaSubgerenciaPlanificacionSITP', service: 'Consulta_Planificacion_SITP', layerIndex: 14 },
} satisfies Record<string, ArcgisConfig>;

// ─── Live/Bodega host (arrivals + card, spec §5.8 / §5.5.1a) ───────────────
const LIVE_TIMEOUT_MS = 9_000;
const CARD_HOST = 'tmsa-transmiapp-shvpc.uc.r.appspot.com';

/** Header set for native browser-parity calls to the live host (spec §5.2.3:
 *  `Appid` and — since 2026-09-21 — `uuid` are both required; a missing `uuid`
 *  is an empty 403. The install id is this device's, kept across launches. */
const LIVE_JSON_HEADERS: Record<string, string> = {
  Appid: APPID,
  uuid: installUuid(),
  'Content-Type': 'application/json; charset=UTF-8',
};

/** Real-time arrivals at a paradero, the official app's own board (spec §5.8).
 *  Never hard-fails — empty list on any outage, `source: null` when nothing
 *  answered. */
async function getArrivals(paradero: string): Promise<ArrivalsResponse> {
  const cenefa = String(paradero ?? '').trim();
  if (!cenefa) return { success: true, count: 0, arrivals: [], source: null };
  try {
    const res = await nativeHttpRequest({
      method: 'POST',
      url: `${LIVE_HOST}/paradero/buses`,
      headers: LIVE_JSON_HEADERS,
      data: { paradero: cenefa },
      timeoutMs: LIVE_TIMEOUT_MS,
    });
    if (res.status < 200 || res.status >= 300) throw new Error(`arrivals status ${res.status}`);
    const arrivals = normalizeArrivalsPayload(parseJson(res.data));
    return { success: true, count: arrivals.length, arrivals, source: 'native' };
  } catch (error) {
    console.warn('[officialApi] arrivals failed:', error);
    return { success: true, count: 0, arrivals: [], source: null };
  }
}

// ─── Card ledger (`/lectura_tarjeta`, spec §5.5.1a) ────────────────────────
function normalizeConsultar(value: 'true' | 'false'): 'true' | 'false' {
  return value === 'true' ? 'true' : 'false';
}

/**
 * Reads the server card ledger straight from the live host (spec §5.5.1a). On a
 * Colombian phone the geofence is satisfied natively — no proxy needed. Provenance
 * stays `source:"server"`; NFC chip reads remain `source:"card"` (nfc.ts, §5.5.1b).
 */
async function readCardBalance(numeroTarjeta: string, consultar: 'true' | 'false' = 'false'): Promise<CardBalanceResponse> {
  const card = String(numeroTarjeta ?? '').trim();
  if (!isCardNumber(card)) {
    return { success: false, error: 'numero_tarjeta must be 8 to 20 digits' };
  }
  const cons = normalizeConsultar(consultar);

  try {
    const res = await nativeHttpRequest({
      method: 'POST',
      url: `${LIVE_HOST}/lectura_tarjeta`,
      headers: LIVE_JSON_HEADERS,
      data: { numero_tarjeta: card, consultar: cons },
      timeoutMs: LIVE_TIMEOUT_MS,
    });
    if (res.status < 200 || res.status >= 300) {
      const geofenced = res.status === 401 || res.status === 451;
      return {
        success: false,
        error: geofenced
          ? 'La consulta de saldo solo funciona desde una conexión colombiana.'
          : `El servidor respondió ${res.status}.`,
      };
    }

    const payload = parseJson(res.data);
    const rows = Array.isArray(payload) ? payload.filter(isLedgerRow) : [];
    const masked = maskCardNumber(card);
    const movements = rows.map((row) => ledgerMovement(row, masked));
    const latest = movements[0];

    const data: CardBalanceRead = {
      numeroTarjeta: masked,
      consultar: cons,
      balance: latest?.finalBalance,
      balanceSource: latest ? 'server' : undefined,
      asOf: latest?.occurredAt,
      movements,
      sources: {
        server: {
          status: 'ok',
          host: CARD_HOST,
          path: '/lectura_tarjeta',
          method: 'POST',
          requestBody: { numero_tarjeta: masked, consultar: cons },
          count: movements.length,
        },
        card: {
          status: 'unavailable',
          reason: 'El endpoint oficial devuelve solo el registro del servidor. El saldo y los últimos movimientos tras acercar la tarjeta se leen del chip NFC (§5.5.1b).',
        },
      },
    };
    return { success: true, data };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Error de red' };
  }
}

// ─── Walking route (public OSRM foot profile, spec §5.6) ───────────────────
const OSRM_TIMEOUT_MS = 9_000;
// This phone's own share of FOSSGIS's one request a second (`shared/osrm_foot.js`).
// A leg that would wait longer keeps its estimate; the next search asks again.
const footPacer = createPacer(FOOT_MIN_INTERVAL_MS, 10_000);

/**
 * Real pedestrian geometry from the public OSRM foot router, asked from the phone
 * — the same answer, read the same way, as the website's `GET /api/walking-route`.
 */
async function getWalkingRoute(from: [number, number], to: [number, number]): Promise<WalkingRouteResponse> {
  if (!isWithinBogota(from[0], from[1]) || !isWithinBogota(to[0], to[1])) {
    return { success: false, error: 'Walking route coordinates must be within Bogota bounds' };
  }
  const wait = footPacer();
  if (wait === null) return { success: false, error: 'Walking route queue is full' };
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  try {
    const res = await nativeHttpRequest({ method: 'GET', url: footRouteUrl(from, to), headers: FOOT_HEADERS, timeoutMs: OSRM_TIMEOUT_MS });
    if (res.status < 200 || res.status >= 300) throw new Error(`OSRM HTTP ${res.status}`);
    const route = readFootRoute(parseJson(res.data));
    return route ? { success: true, data: route } : { success: false, error: 'Walking route upstream returned no usable route' };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Walking route lookup failed' };
  }
}

// ─── Address/place geocoding (public Photon, spec §5.5.1) ──────────────────
const GEOCODE_TIMEOUT_MS = 6_000;
const GEOCODE_LIMIT = 8;
// Same window as the server's single Bogotá box (`services/bogota.ts`), read
// from the client's own gate rather than re-typed — a city boundary has one
// definition (spec §1.1 R2), and the copy that used to live in this file was
// the fifth.
const BOGOTA_BBOX = `${BOGOTA_BOUNDS.minLng},${BOGOTA_BOUNDS.minLat},${BOGOTA_BOUNDS.maxLng},${BOGOTA_BOUNDS.maxLat}`;

export interface GeocodeCandidate {
  name: string;
  lat: number;
  lon: number;
  type: 'station' | 'stop' | 'address' | 'place';
  code?: string;
}

export interface GeocodeResponse {
  success: boolean;
  candidates?: GeocodeCandidate[];
  error?: string;
}

function normalizeCity(value: unknown): string {
  return String(value ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

/**
 * Address/place lookup for the app.
 *
 * The server's `/api/geocode` fans out to three sources; the app has no server
 * (spec §5.2.1b), so it queries the same **public** Photon instance the server
 * uses for its place tier — enough to turn "planear a una dirección" from
 * impossible into working. The station/stop half of the merge is already local:
 * the app searches the APK-bundled catalog itself.
 */
async function geocode(query: string): Promise<GeocodeResponse> {
  const q = String(query ?? '').trim();
  if (q.length < 3) return { success: true, candidates: [] };
  const url =
    `https://photon.komoot.io/api?q=${encodeURIComponent(q)}` +
    `&bbox=${BOGOTA_BBOX}&lat=4.60&lon=-74.08&limit=${GEOCODE_LIMIT}`;
  try {
    const res = await nativeHttpRequest({
      method: 'GET',
      url,
      headers: { Accept: 'application/json', 'Accept-Language': 'es-CO,es;q=0.9' },
      timeoutMs: GEOCODE_TIMEOUT_MS,
    });
    if (res.status < 200 || res.status >= 300) throw new Error(`Photon HTTP ${res.status}`);
    const data = parseJson(res.data);
    const features: any[] = Array.isArray(data?.features) ? data.features : [];
    const candidates = features
      .map((feature): GeocodeCandidate | null => {
        const coords = feature?.geometry?.coordinates;
        const lon = Number(coords?.[0]);
        const lat = Number(coords?.[1]);
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
        if (!isWithinBogota(lon, lat)) return null;
        const p = feature.properties ?? {};
        // Photon's bbox is a rectangle, so a neighbouring municipality can slip
        // in — drop anything not tagged Bogotá.
        const cityOk =
          !p.city || normalizeCity(p.city).includes('bogota') || normalizeCity(p.county).includes('bogota');
        if (!cityOk) return null;
        const parts = [p.name || p.street, p.district || p.suburb || p.city].filter(
          (part: unknown): part is string => typeof part === 'string' && part.length > 0
        );
        const name = Array.from(new Set(parts)).slice(0, 3).join(', ').trim();
        if (!name) return null;
        return { name, lat, lon, type: 'place' };
      })
      .filter((c): c is GeocodeCandidate => c !== null);
    return { success: true, candidates };
  } catch (error) {
    // Never hard-fail: the catalog half of the suggestions still answers.
    console.warn('[officialApi] geocode failed:', error);
    return { success: false, candidates: [], error: error instanceof Error ? error.message : 'geocode failed' };
  }
}

export const officialApi = {
  getTroncalCorridors: () => arcgisResponse(ARCGIS_LAYERS.troncalCorridors),
  getZonalRoutes: () => arcgisResponse(ARCGIS_LAYERS.zonalRoutes),
  getZonalStops: () => arcgisResponse(ARCGIS_LAYERS.zonalStops),
  getZonalStopRoutes: () => arcgisResponse(ARCGIS_LAYERS.zonalStopRoutes),
  getCableStations: () => arcgisResponse(ARCGIS_LAYERS.cableStations),
  getCableTrazado: () => arcgisResponse(ARCGIS_LAYERS.cableTraces),
  getArrivals,
  readCardBalance,
  getWalkingRoute,
  geocode,
};
