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
  stops: Array<{
    nombre: string;
    codigo: string;
    coordenada: string;
    posicion: number;
  }>;
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
