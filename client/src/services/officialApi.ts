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
import { LIVE_HOST, APPID, nativeHttpRequest } from './nativeLive';
import type {
  ArrivalItem,
  ArrivalsResponse,
  CardBalanceMovement,
  CardBalanceRead,
  CardBalanceResponse,
  WalkingRouteResponse,
  StopArrival,
  StopArrivalsResponse,
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
  troncalRoutes: { folder: 'Troncal', service: 'consulta_rutas_troncales' },
  troncalCorridors: { folder: 'Troncal', service: 'consulta_trazados_troncales' },
  zonalRoutes: {
    folder: 'Zonal',
    service: 'consulta_rutas_zonales',
    outFields: 'route_name_ruta_zonal,codigo_definitivo_ruta_zonal,zona_origen_ruta_zonal,zona_destino_ruta_zonal',
    returnGeometry: false,
  },
  zonalStops: { folder: 'Zonal', service: 'consulta_paraderos_zonales' },
  zonalStopRoutes: { folder: 'Zonal', service: 'consulta_paraderos_rutas', outFields: 'cenefa,ruta', returnGeometry: false },
  // TransMiCable (spec §5.3) — same service, two layers (mirrors server arcgis.ts).
  cableStations: { folder: 'ConsultaSubgerenciaPlanificacionSITP', service: 'Consulta_Planificacion_SITP', layerIndex: 11 },
  cableTraces: { folder: 'ConsultaSubgerenciaPlanificacionSITP', service: 'Consulta_Planificacion_SITP', layerIndex: 14 },
} satisfies Record<string, ArcgisConfig>;

// ─── Live/Bodega host (arrivals + card, spec §5.8 / §5.5.1a) ───────────────
const LIVE_TIMEOUT_MS = 9_000;
const CARD_HOST = 'tmsa-transmiapp-shvpc.uc.r.appspot.com';

/** Header set for native browser-parity calls to the live host (spec §5.2.3:
 *  Appid is the only required header; native/browser paths send Appid + type). */
const LIVE_JSON_HEADERS: Record<string, string> = {
  Appid: APPID,
  'Content-Type': 'application/json; charset=UTF-8',
};

function isRow(item: unknown): item is Record<string, unknown> {
  return item != null && typeof item === 'object' && !Array.isArray(item);
}

/** Normalize `/paradero/buses` → stable arrivals (mirrors tm_api normalizeArrivalsPayload). */
function normalizeArrivalsPayload(payload: any): ArrivalItem[] {
  const list: any[] = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.data) ? payload.data
    : Array.isArray(payload?.buses) ? payload.buses
    : Array.isArray(payload?.llegadas) ? payload.llegadas
    : Array.isArray(payload?.vehiculos) ? payload.vehiculos
    : [];
  return list
    .filter((it) => it && typeof it === 'object')
    .map((it) => ({
      codigo: String(it.ruta_extraida ?? it.codigo ?? '').trim(),
      idRuta: String(it.ruta_sae ?? it.idRuta ?? '').trim(),
      destino: String(it.destino_limpio ?? it.destino ?? it.nombre ?? '').trim(),
      color: String(it.color_ruta ?? it.color ?? '').trim(),
      paradero: String(it.labelparadero ?? it.paradero ?? '').trim(),
      tiempo: String(it.labeltiempo ?? it.tiempo ?? it.time ?? '').trim(),
      distancia: String(it.distancia ?? '').trim(),
    }))
    .filter((it) => it.codigo || it.destino);
}

/** Real-time arrivals at a paradero. Never hard-fails — empty list on any outage
 *  (mirrors the server `/api/arrivals` contract, spec §5.8). */
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

/** Parse minutes out of a live ETA label ("5 min", "Llegando", "300 m"). */
function parseEtaMinutes(tiempo: string, distancia: string): { etaMinutes: number; distanceMeters: number } {
  const minMatch = /(\d+)\s*min/i.exec(tiempo);
  const mMatch = /(\d+)\s*m\b/i.exec(distancia || tiempo);
  const distanceMeters = mMatch ? Number(mMatch[1]) : 0;
  const etaMinutes = minMatch ? Number(minMatch[1]) : (/lleg/i.test(tiempo) ? 0 : 0);
  return { etaMinutes, distanceMeters };
}

/**
 * Native stop-arrivals. Without a server to run the full trace-projection
 * fan-out, the app relies on the official `/paradero/buses` imminent-arrivals
 * feed and adapts its ETA labels into the shared StopArrival shape. Estación
 * (TM…) codes aren't served by that endpoint, so they return empty on-device.
 */
async function getStopArrivals(code: string): Promise<StopArrivalsResponse> {
  const base = await getArrivals(code);
  const arrivals: StopArrival[] = (base.arrivals ?? []).map((it) => {
    const { etaMinutes, distanceMeters } = parseEtaMinutes(it.tiempo, it.distancia);
    return {
      codigo: it.codigo,
      destino: it.destino,
      color: it.color,
      type: 'zonal' as const,
      etaMinutes,
      distanceMeters,
      busCount: 1,
    };
  });
  return { success: true, count: arrivals.length, routesServing: arrivals.length, arrivals };
}

// ─── Card ledger (`/lectura_tarjeta`, spec §5.5.1a) ────────────────────────
function maskCardNumber(cardNumber: string): string {
  if (cardNumber.length <= 6) return cardNumber;
  return `${cardNumber.slice(0, 4)}...${cardNumber.slice(-4)}`;
}

function normalizeConsultar(value: 'true' | 'false'): 'true' | 'false' {
  return value === 'true' ? 'true' : 'false';
}

/** Mirrors card_balance.ts normalizeServerMovement — the server ledger row shape. */
function normalizeServerMovement(item: Record<string, unknown>, fallbackCardNumber: string): CardBalanceMovement {
  const upstreamCardNumber = String(item.numero_tarjeta ?? '').trim();
  return {
    source: 'server',
    numeroTarjeta: /^\d{8,20}$/.test(upstreamCardNumber) ? maskCardNumber(upstreamCardNumber) : fallbackCardNumber,
    type: String(item.tipo ?? ''),
    finalBalance: item.saldo_tarjeta == null ? undefined : String(item.saldo_tarjeta),
    occurredAt: item.ultima_transaccion == null ? undefined : String(item.ultima_transaccion),
  };
}

/**
 * Reads the server card ledger straight from the live host (spec §5.5.1a). On a
 * Colombian phone the geofence is satisfied natively — no proxy needed. Provenance
 * stays `source:"server"`; NFC chip reads remain `source:"card"` (nfc.ts, §5.5.1b).
 */
async function readCardBalance(numeroTarjeta: string, consultar: 'true' | 'false' = 'false'): Promise<CardBalanceResponse> {
  const card = String(numeroTarjeta ?? '').trim();
  if (!/^\d{8,20}$/.test(card)) {
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
    const rows = Array.isArray(payload) ? payload.filter(isRow) : [];
    const masked = maskCardNumber(card);
    const movements = rows.map((row) => normalizeServerMovement(row, masked));
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
          requestHeaders: { ...LIVE_JSON_HEADERS },
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
const WALK_SPEED_M_PER_MINUTE = 75; // must match server + router.ts
const BOGOTA_WALKING_BOUNDS = { west: -74.25, south: 4.4, east: -73.95, north: 4.85 };

function isWithinWalkingBounds([lng, lat]: [number, number]): boolean {
  return lng >= BOGOTA_WALKING_BOUNDS.west && lng <= BOGOTA_WALKING_BOUNDS.east &&
    lat >= BOGOTA_WALKING_BOUNDS.south && lat <= BOGOTA_WALKING_BOUNDS.north;
}

/**
 * Real pedestrian geometry from the public OSRM foot router (the same instance
 * the server proxies, spec §5.6). Time is derived from distance so totals match
 * the router's straight-line estimate before enrichment.
 */
async function getWalkingRoute(from: [number, number], to: [number, number]): Promise<WalkingRouteResponse> {
  if (!isWithinWalkingBounds(from) || !isWithinWalkingBounds(to)) {
    return { success: false, error: 'Walking route coordinates must be within Bogota bounds' };
  }
  const url =
    `https://routing.openstreetmap.de/routed-foot/route/v1/foot/${from[0]},${from[1]};${to[0]},${to[1]}` +
    '?overview=full&geometries=geojson';
  try {
    const res = await nativeHttpRequest({
      method: 'GET',
      url,
      headers: { Accept: 'application/json', 'User-Agent': 'TransMilenioExplorer/1.0' },
      timeoutMs: OSRM_TIMEOUT_MS,
    });
    if (res.status < 200 || res.status >= 300) throw new Error(`OSRM HTTP ${res.status}`);
    const data = parseJson(res.data);
    const route = data?.routes?.[0];
    const coordinates: number[][] | undefined = route?.geometry?.coordinates;
    if (data?.code !== 'Ok' || !route || !Array.isArray(coordinates) || coordinates.length < 2 || !Number.isFinite(route.distance)) {
      return { success: false, error: 'Walking route upstream returned no usable route' };
    }
    const normalized = coordinates.map(([lng, lat]) => [Number(lng), Number(lat)] as [number, number]);
    if (normalized.some(([lng, lat]) => !Number.isFinite(lng) || !Number.isFinite(lat))) {
      return { success: false, error: 'Walking route upstream returned invalid coordinates' };
    }
    const distance = Number(route.distance);
    return { success: true, data: { coordinates: normalized, distance, time: distance / WALK_SPEED_M_PER_MINUTE, source: 'osrm' } };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Walking route lookup failed' };
  }
}

export const officialApi = {
  getTroncalRoutes: () => arcgisResponse(ARCGIS_LAYERS.troncalRoutes),
  getTroncalCorridors: () => arcgisResponse(ARCGIS_LAYERS.troncalCorridors),
  getZonalRoutes: () => arcgisResponse(ARCGIS_LAYERS.zonalRoutes),
  getZonalStops: () => arcgisResponse(ARCGIS_LAYERS.zonalStops),
  getZonalStopRoutes: () => arcgisResponse(ARCGIS_LAYERS.zonalStopRoutes),
  getCableStations: () => arcgisResponse(ARCGIS_LAYERS.cableStations),
  getCableTrazado: () => arcgisResponse(ARCGIS_LAYERS.cableTraces),
  getArrivals,
  getStopArrivals,
  readCardBalance,
  getWalkingRoute,
};
