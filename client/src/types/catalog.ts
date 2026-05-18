/** Types for the master catalog served by the TransMi app API scraper */

export interface CatalogRoute {
  codigo: string;
  nombre: string;
  color: string;
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
  wagons: CatalogWagons;
}

export interface MasterCatalog {
  [stationCode: string]: CatalogStation;
}

export interface MasterCatalogResponse {
  success: boolean;
  data: MasterCatalog;
  count: number;
  stale: boolean;
}
