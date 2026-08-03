/** Global app state + a micro event bus. Views subscribe; data/nav mutate. */

import type { RouteListItem } from '@shared/types/transmilenio';
import type { MasterCatalog } from '@shared/types/catalog';
import type { CableStationInput } from '@shared/services/router';
import type { PointKind } from '@shared/data/pointKinds';

export interface StationRecord {
  code: string;
  name: string;
  direccion: string;
  coordinate: [number, number];
  wagonCount: number;
  // The shared vocabulary, not a copy of it: a local union silently disagreed
  // with `POINT_KINDS` the moment a kind was added there (spec §1.1 R2).
  kind: PointKind;
  hours?: string; // tullave POIs (weekday hours) / transmibici (capacity · occupancy)
}

/** Per-station mean weekday footfall (open Salidas dataset, spec §5.8). */
export interface DemandRecord {
  name: string;
  coordinate: [number, number];
  entradas: number;
  salidas: number;
  total: number;
  rank: number;
}

export interface HealthInfo {
  catalogStations?: number;
  catalogStale?: boolean;
  liveTrackingVersion?: string;
  liveCapable: boolean; // native/extension/relay in the path
  reachedAt?: number;
  ok: boolean;
}

export type TabId = 'inicio' | 'rutas' | 'planner' | 'mapa' | 'cerca' | 'saldo';

type Events = {
  'routes:ready': void;
  'stops:ready': void;
  'demand:ready': void;
  'cable:ready': void;
  'health': HealthInfo;
  'tab': TabId;
  'route:open': RouteListItem;
  'favorites:changed': void;
};

type Handler<T> = (payload: T) => void;

class Bus {
  private map = new Map<string, Set<Handler<any>>>();
  on<K extends keyof Events>(event: K, handler: Handler<Events[K]>): () => void {
    let set = this.map.get(event as string);
    if (!set) this.map.set(event as string, (set = new Set()));
    set.add(handler);
    return () => set!.delete(handler);
  }
  emit<K extends keyof Events>(event: K, payload: Events[K]): void {
    this.map.get(event as string)?.forEach((h) => {
      try {
        h(payload);
      } catch (err) {
        console.error(`[bus] handler for ${String(event)} threw`, err);
      }
    });
  }
}

export const bus = new Bus();

interface AppState {
  routes: RouteListItem[];
  routeById: Map<string, RouteListItem>;
  catalog: MasterCatalog;
  stations: StationRecord[];
  zonalStops: StationRecord[];
  rechargePoints: StationRecord[];
  /** tullave personalization counters (spec §5.8) — the recharge points' twin. */
  personalizacionPoints: StationRecord[];
  bikeParkings: StationRecord[];
  /** TransMiCable gondola stations (spec §5.3) — shown on the map + Cerca. */
  cableStations: StationRecord[];
  /** Raw ArcGIS cable trace features (LineStrings) for the map layer. */
  cableTraces: any[];
  /** Cable stations in the router's input shape, for journey planning over the cable line. */
  cableRouterStations: CableStationInput[];
  demand: DemandRecord[];
  // The code → zone index itself lives in `@shared/data/zones` (read via
  // `getZonalAreas`); only the presentation lists below are mirrored into state.
  /** Sorted list of SITP zone numbers actually present in the network. */
  zones: number[];
  /** Human hint per zone (most common landmark from its routes' endpoints). */
  zoneLabels: Map<number, string>;
  counts: { troncal: number; zonal: number; stations: number; stops: number; cable: number };
  health: HealthInfo | null;
  tab: TabId;
  native: boolean;
}

export const state: AppState = {
  routes: [],
  routeById: new Map(),
  catalog: { stations: {}, routes: {} },
  stations: [],
  zonalStops: [],
  rechargePoints: [],
  personalizacionPoints: [],
  bikeParkings: [],
  cableStations: [],
  cableTraces: [],
  cableRouterStations: [],
  demand: [],
  zones: [],
  zoneLabels: new Map(),
  counts: { troncal: 0, zonal: 0, stations: 0, stops: 0, cable: 0 },
  health: null,
  tab: 'inicio',
  native: Boolean((window as any).Capacitor?.isNativePlatform?.()),
};

export function setRoutes(routes: RouteListItem[]): void {
  state.routes = routes;
  state.routeById = new Map(routes.map((r) => [r.id, r]));
  bus.emit('routes:ready', undefined);
}

/** Every place record combined — stations, zonal stops, both tullave POI sets,
 *  bike parking and cable stations (for search / nearby). */
export function allPoints(): StationRecord[] {
  return state.stations.concat(
    state.zonalStops,
    state.rechargePoints,
    state.personalizacionPoints,
    state.bikeParkings,
    state.cableStations
  );
}
