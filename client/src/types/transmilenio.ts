/** Type definitions for Transmilenio ArcGIS API responses */

// ─── Troncal ──────────────────────────────────────────────

export interface TroncalRoute {
  objectid: number;
  route_name_ruta_troncal: string;
  nombre_ruta_troncal: string;
  servicio_unico_ruta_troncal: string;
  origen_ruta_troncal: string;
  destino_ruta_troncal: string;
  desc_tipo_ruta_troncal: string;
  tipo_operacion: string;
  desc_tipo_bus_ruta_troncal: string;
  horario_lunes_viernes: string;
  horario_sabado: string;
  horario_domingo_festivo: string;
  estado_ruta_troncal: string;
  longitud_comercial: number;
  longitud_ruta_troncal: number;
  Shape__Length?: number;
}

export interface TroncalRouteFeature {
  attributes: TroncalRoute;
  geometry: { paths: number[][][] };
}

export interface TroncalStation {
  objectid: number;
  numero_estacion: string;
  codigo_nodo_estacion?: string | number;
  nombre_estacion: string;
  ubicacion_estacion: string;
  troncal_estacion: string;
  numero_vagones_estacion: number;
  numero_accesos_estacion: number;
  biciestacion_estacion: string;
  capacidad_biciestacion_estacion: number;
  tipo_estacion: number;
  latitud_estacion: number;
  longitud_estacion: number;
  componente_wifi: string;
}

export interface TroncalStationFeature {
  attributes: TroncalStation;
  geometry: { x: number; y: number };
}

export interface TroncalWagonFeature {
  attributes: {
    objectid: number;
    tipo: string;
    troncal: string;
    estacion: string;
    secciontipo: string;
    idestacion: number;
    nombre: string;
    id_vagon: number;
    Shape__Area?: number;
    area_m2?: number;
  };
  geometry: {
    rings: number[][][];
  };
}

export interface TroncalCorridor {
  objectid: number;
  id_trazado: string;
  inicio_trazado: string;
  fin_trazado: string;
  tipo_trazado: string;
  letra_trazado_troncal: string;
  troncal: string;
  fase_trazado_troncal: string;
  Shape__Length?: number;
}

export interface TroncalCorridorFeature {
  attributes: TroncalCorridor;
  geometry: { paths: number[][][] };
}

// ─── API Response Wrapper ─────────────────────────────────

export interface ApiResponse<T> {
  success: boolean;
  count: number;
  features: T[];
  error?: string;
}

// ─── Unified route type for the sidebar list ──────────────

export interface RouteListItem {
  id: string;
  code: string;
  name: string;
  origin: string;
  destination: string;
  type: 'troncal' | 'zonal';
  subType?: string;
  source?: 'arcgis' | 'catalog';
  busType?: string;
  schedule?: string;
  operator?: string;
  length?: number;
  color?: string;
  geometry?: { paths: number[][][] };
  stops?: Array<{
    nombre: string;
    codigo: string;
    coordinate: [number, number];
    direccion?: string;
    kind?: 'station' | 'stop';
  }>;
  catalogNombre?: string;
  liveNameCandidates?: string[];
}
