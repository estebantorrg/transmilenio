/** Types for the master catalog served by the TransMi app API scraper */

export interface CatalogRoute {
  id?: string;
  codigo: string;
  nombre: string;
  color: string;
  horarios?: { data?: Array<{ convencion: string; hora_inicio: string; hora_fin: string }> };
  tipoServicio?: string;
  sistema?: string;
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
  /** Wagon key → the number printed on that platform's sign ("Vagón 3"), for the
   *  platforms where the official plano's plate count backs the catalog's own
   *  A/B/C grouping. Resolved server-side in `printedVagonLabels` and shipped on
   *  the light catalog, so this popup and the prerendered estación page name a
   *  platform identically; a key absent here gets no number anywhere (§5.5.4). */
  vagonLabels?: Record<string, string>;
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
  trazado?: number[][] | number[][][];
}

export interface MasterCatalog {
  stations: { [stationCode: string]: CatalogStation };
  routes: { [routeCode: string]: CatalogRouteDetail[] };
}

export interface MasterCatalogResponse {
  success: boolean;
  data: MasterCatalog;
  count: number;
  stale: boolean;
}
