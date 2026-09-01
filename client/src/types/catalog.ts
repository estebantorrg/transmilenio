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
  /** True when the official station register lists this node as an estación —
   *  stamped server-side (`station_registry.ts`, §5.5.6) because only the server
   *  holds the register. Read through `isStationStopCode`, never directly: a
   *  station that predates the stamp is still recognised by its `TM…` code. */
  estacion?: boolean;
  /** The official register's node id for this stop (`codigo_nodo_estacion`),
   *  when the registry pairs the two. It is what lets the map join an ArcGIS
   *  station point to its catalog stop where the names disagree — "Los Laureles"
   *  in the register is "Laureles" in the catalog (§5.5.6). */
  nodo?: string;
  /** The troncal corridor this station physically sits on, and the letter its
   *  route codes carry (`{ nombre: 'Autonorte', letra: 'B' }`). Answered
   *  server-side from the official station maps (`stationCorridor`, §5.5.6) —
   *  ArcGIS's own `troncal_estacion` is a station label that does not always
   *  name one corridor ("CR 7-10"), and the nearest centreline is wrong exactly
   *  where three of them meet. Absent for TransMiCable, which is not a troncal. */
  corridor?: {
    nombre: string;
    letra?: string;
    /** What riders call the corridor's two directions, so the drawn plan can put
     *  one along each edge the way the operator's own plano does (§5.5.4). */
    sentidos?: { positive: string; negative: string };
  };
  /** The station's drawn shape, where its platforms are not one segmented bar
   *  and the catalog's lettered wagons therefore cannot describe them — a
   *  staggered station, two platforms on opposite carriageways, offset, with the
   *  busway between (§5.5.4). Read off the plano and reconciled against the
   *  catalog server-side; absent for every station the bar describes correctly. */
  planoLayout?: {
    /** What physically separates the two platforms, where someone has checked —
     *  a busway, a ciclorruta or a caño. Absent means nobody has, and the
     *  drawing then separates them without naming what lies between. */
    divider?: 'busway' | 'ciclorruta' | 'cano' | 'tren';
    rows: Array<{
      /** Stagger, in vagón columns, for a platform that does not line up with
       *  the one above it. */
      offset: number;
      vagones: Array<{
        vagon: string;
        /** Códigos on each long edge, per vagón: one vagón can serve a single
         *  direction while its neighbour on the same platform serves both. */
        arriba?: string[];
        abajo?: string[];
        /** código → the destination whose variant boards this vagón, where the
         *  catalog files that código here more than once. */
        destinos?: Record<string, string>;
      }>;
    }>;
  };
  /** Wagon key → the number printed on that platform's sign ("Vagón 3"), for the
   *  platforms where the official plano's plate count backs the catalog's own
   *  A/B/C grouping. Resolved server-side in `printedVagonLabels` and shipped on
   *  the light catalog, so this popup and the prerendered estación page name a
   *  platform identically; a key absent here gets no number anywhere (§5.5.4). */
  vagonLabels?: Record<string, string>;
  /** Wagon key → the directions it serves, each listing the route **variant**
   *  ids that board it (`buildWagonPlan`, spec §5.5.4). Resolved server-side
   *  from the stop coordinates so this popup and the prerendered estación page
   *  face a platform the same way; the código alone cannot say which side a
   *  service boards from, since the same código runs both ways. */
  wagonPlan?: Record<string, CatalogPlanGroup[]>;
  wagons: CatalogWagons;
}

export interface CatalogPlanGroup {
  /** Cardinal these services leave towards, or null when it can't be derived. */
  sentido: string | null;
  /** These services END here — they arrive and are never boarded onward. */
  arrival?: boolean;
  ids: string[];
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
