/**
 * ArcGIS FeatureServer query service.
 * Handles pagination (MaxRecordCount = 2000) automatically.
 */

const BASE_URL = 'https://gis.transmilenio.gov.co/arcgis/rest/services';
const ARCGIS_QUERY_TIMEOUT_MS = 15_000;

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
    message?: string;
    details?: string[];
  };
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
    console.log(`[ArcGIS] Fetching: offset=${offset}, limit=${resultRecordCount}`);

    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(ARCGIS_QUERY_TIMEOUT_MS) });
      if (!response.ok) {
        throw new Error(`ArcGIS returned ${response.status}: ${response.statusText}`);
      }

      const data: ArcGISResponse = await response.json();
      if (data.error) {
        const details = data.error.details?.length ? ` ${data.error.details.join(' ')}` : '';
        throw new Error(`${data.error.message ?? 'ArcGIS query failed'}${details}`);
      }

      const features = data.features ?? [];
      if (features.length > 0) {
        allFeatures = allFeatures.concat(features);
        offset += features.length;
      }

      hasMore = data.exceededTransferLimit === true && features.length > 0;
    } catch (error) {
      console.error(`[ArcGIS] Error fetching ${folder}/${service}:`, error);
      throw error;
    }
  }

  console.log(`[ArcGIS] ${folder}/${service}: Fetched ${allFeatures.length} features total`);
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

  zonalRoutes: () =>
    queryFeatureLayer({
      folder: 'Zonal',
      service: 'consulta_rutas_zonales',
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
      outFields: 'cenefa,ruta',
      returnGeometry: false,
    }),
};
