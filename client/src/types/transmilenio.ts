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

// ─── Zonal ────────────────────────────────────────────────

export interface ZonalRoute {
  objectid: number;
  codigo_definitivo_ruta_zonal: string;
  denominacion_ruta_zonal: string;
  origen_ruta_zonal: string;
  destino_ruta_zonal: string;
  operador_ruta_zonal: string;
  route_name_ruta_zonal: string;
  tipo_operacion: string;
  tipo_ruta_zonal: number;
  longitud_ruta_zonal: number;
  zona_origen_ruta_zonal: number;
  zona_destino_ruta_zonal: number;
}

export interface ZonalRouteFeature {
  attributes: ZonalRoute;
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
  busType?: string;
  schedule?: string;
  operator?: string;
  length?: number;
  color?: string;
}
