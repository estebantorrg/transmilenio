/** Type definitions for Transmilenio ArcGIS API responses */

import type { ServiceSpan } from '../services/schedule';

// ─── Troncal ──────────────────────────────────────────────

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

/** A trazado of ArcGIS `Consulta_Planificacion_SITP` layer 5; only the letter is
 *  read, and the catalog-built stand-ins (`routes.ts`) fill no more than that. */
export interface TroncalCorridor {
  objectid: number;
  id_trazado: string;
  le_troncal: string;
  nom_tronc: string;
  nom_traz?: string;
  ori_traz?: string;
  fin_traz?: string;
  fase_tronc?: string;
  /** 1 exclusivo, 2 mixto. */
  tipo_tra?: number;
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
  /** Raw catalog schedule text, kept for display fallback. */
  schedule?: string;
  /** Parsed operating windows (§5.6.2). Absent = unknown → always operating. */
  serviceSpans?: ServiceSpan[];
  operator?: string;
  /** Kilometres along the route's own trace (`traceKm`). */
  length?: number;
  color?: string;
  geometry?: { paths: number[][][] };
  stops?: Array<{
    nombre: string;
    codigo: string;
    sourceCode?: string;
    coordinate: [number, number];
    direccion?: string;
    kind?: 'station' | 'stop';
    /** Planner nodes for a stop the catalog merges out of two stations (Av.
     *  Jiménez, Ricaurte): the platform(s) THIS route calls at, in travel order
     *  (`platformNodes`, routeCatalog.ts). Every other surface keeps the stop. */
    platforms?: Array<{
      nombre: string;
      codigo: string;
      sourceCode: string;
      coordinate: [number, number];
      kind: 'station';
    }>;
  }>;
  catalogNombre?: string;
  liveNameCandidates?: string[];
}
