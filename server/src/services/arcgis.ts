/**
 * ArcGIS FeatureServer query service.
 * Handles pagination (MaxRecordCount = 2000) automatically.
 */

const BASE_URL = 'https://gis.transmilenio.gov.co/arcgis/rest/services';
const ARCGIS_QUERY_TIMEOUT_MS = 15_000;
// A single transient blip on one page (socket reset, gateway 502, a page that
// overran the timeout while the box was busy) used to cost the whole layer for
// the lifetime of the cache entry — the caller got a hard error and the map
// rendered that layer empty. Pages are retried with backoff so only a sustained
// upstream outage can fail the query (spec §3.4, §4.1).
const ARCGIS_MAX_ATTEMPTS = 3;
const ARCGIS_RETRY_BASE_MS = 600; // 600ms, then 1200ms

interface ArcGISQueryOptions {
  folder: string;
  service: string;
  layerIndex?: number;
  where?: string;
  outFields?: string;
  outSR?: number;
  resultRecordCount?: number;
  returnGeometry?: boolean;
}

interface ArcGISResponse {
  features?: any[];
  exceededTransferLimit?: boolean;
  fields?: any[];
  geometryType?: string;
  error?: {
    code?: number;
    message?: string;
    details?: string[];
  };
}

/**
 * Raised when a layer could not be read after exhausting the page retries.
 * Routes translate it into a `503` so the client's backoff ladder engages
 * instead of treating the layer as permanently gone (spec §4.1).
 */
export class ArcGISUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ArcGISUnavailableError';
  }
}

/** Marks an ArcGIS failure the caller caused (bad field, bad layer): retrying it
 *  would only burn the request budget, so it fails on the first attempt. */
class ArcGISRequestError extends Error {}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchPage(url: string): Promise<ArcGISResponse> {
  const response = await fetch(url, { signal: AbortSignal.timeout(ARCGIS_QUERY_TIMEOUT_MS) });
  if (!response.ok) {
    const message = `ArcGIS returned ${response.status}: ${response.statusText}`;
    if (response.status >= 400 && response.status < 500) throw new ArcGISRequestError(message);
    throw new Error(message);
  }

  const data: ArcGISResponse = await response.json();
  if (data.error) {
    const details = data.error.details?.length ? ` ${data.error.details.join(' ')}` : '';
    const message = `${data.error.message ?? 'ArcGIS query failed'}${details}`;
    // ArcGIS answers HTTP 200 with an error envelope; its own `code` carries the
    // real class of failure (4xx = our query is wrong, 5xx = its box is busy).
    const code = data.error.code ?? 0;
    if (code >= 400 && code < 500) throw new ArcGISRequestError(message);
    throw new Error(message);
  }

  return data;
}

async function fetchPageWithRetry(url: string, label: string): Promise<ArcGISResponse> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= ARCGIS_MAX_ATTEMPTS; attempt++) {
    try {
      return await fetchPage(url);
    } catch (error) {
      lastError = error;
      if (error instanceof ArcGISRequestError || attempt === ARCGIS_MAX_ATTEMPTS) break;
      const delay = ARCGIS_RETRY_BASE_MS * 2 ** (attempt - 1);
      console.warn(
        `[ArcGIS] ${label} page failed (attempt ${attempt}/${ARCGIS_MAX_ATTEMPTS}), retrying in ${delay}ms:`,
        error
      );
      await sleep(delay);
    }
  }

  const detail = lastError instanceof Error ? lastError.message : String(lastError);
  throw new ArcGISUnavailableError(`${label}: ${detail}`, { cause: lastError });
}

export async function queryFeatureLayer(options: ArcGISQueryOptions): Promise<any[]> {
  const {
    folder,
    service,
    layerIndex = 0,
    where = '1=1',
    outFields = '*',
    outSR = 4326,
    resultRecordCount = 2000,
    returnGeometry = true,
  } = options;

  const label = `${folder}/${service}`;
  const baseUrl = `${BASE_URL}/${folder}/${service}/FeatureServer/${layerIndex}/query`;
  let allFeatures: any[] = [];
  let offset = 0;
  let hasMore = true;

  while (hasMore) {
    const params = new URLSearchParams({
      where,
      outFields,
      outSR: outSR.toString(),
      f: 'json',
      resultRecordCount: resultRecordCount.toString(),
      resultOffset: offset.toString(),
      returnGeometry: returnGeometry.toString(),
    });

    const url = `${baseUrl}?${params.toString()}`;
    console.log(`[ArcGIS] Fetching ${label}: offset=${offset}, limit=${resultRecordCount}`);

    try {
      const data = await fetchPageWithRetry(url, label);
      const features = data.features ?? [];
      if (features.length > 0) {
        allFeatures = allFeatures.concat(features);
        offset += features.length;
      }

      hasMore = data.exceededTransferLimit === true && features.length > 0;
    } catch (error) {
      console.error(`[ArcGIS] Error fetching ${label}:`, error);
      throw error;
    }
  }

  console.log(`[ArcGIS] ${label}: Fetched ${allFeatures.length} features total`);
  return allFeatures;
}

/** Pre-configured queries for Transmilenio data */
export const queries = {
  troncalRoutes: () =>
    queryFeatureLayer({
      folder: 'Troncal',
      service: 'consulta_rutas_troncales',
    }),

  troncalStations: () =>
    queryFeatureLayer({
      folder: 'Troncal',
      service: 'consulta_estaciones_troncales',
    }),

  troncalWagons: () =>
    queryFeatureLayer({
      folder: 'Troncal',
      service: 'consulta_esquemas_estaciones',
      where: "secciontipo IN ('Vagon', 'Conexion', 'Transicion')",
    }),

  troncalCorridors: () =>
    queryFeatureLayer({
      folder: 'Troncal',
      service: 'consulta_trazados_troncales',
    }),

  // Attributes only (no geometry): the huge zonal route geometries are never
  // used (zonal lines come from catalog trazado), and returning them made this
  // endpoint time out (502/503). Only the zona fields are needed — for the app's
  // "Zonas SITP" browse (spec §5.4.2 / §5.5.1).
  zonalRoutes: () =>
    queryFeatureLayer({
      folder: 'Zonal',
      service: 'consulta_rutas_zonales',
      outFields: 'route_name_ruta_zonal,codigo_definitivo_ruta_zonal,zona_origen_ruta_zonal,zona_destino_ruta_zonal',
      returnGeometry: false,
    }),

  zonalStops: () =>
    queryFeatureLayer({
      folder: 'Zonal',
      service: 'consulta_paraderos_zonales',
    }),

  zonalStopRoutes: () =>
    queryFeatureLayer({
      folder: 'Zonal',
      service: 'consulta_paraderos_rutas',
      // `orden` (e.g. "CBO012"/"NOR045") carries the riding sequence per
      // direction — without it a route's stops arrive in objectid order and the
      // planner graph would chain them arbitrarily.
      outFields: 'cenefa,ruta,orden',
      returnGeometry: false,
    }),

  cableStations: () =>
    queryFeatureLayer({
      folder: 'ConsultaSubgerenciaPlanificacionSITP',
      service: 'Consulta_Planificacion_SITP',
      layerIndex: 11,
    }),

  cableTraces: () =>
    queryFeatureLayer({
      folder: 'ConsultaSubgerenciaPlanificacionSITP',
      service: 'Consulta_Planificacion_SITP',
      layerIndex: 14,
    }),
};
