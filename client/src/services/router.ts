import {
  MINUTES_PER_DAY,
  bogotaNow,
  boardingWaitAt,
  closingAfter,
  createServiceClock,
  serviceIntervals,
  serviceMinutesOnPlanDay,
  type PlanTime,
  type ServiceClock,
  type ServiceSpan,
} from './schedule';
import type { RouteListItem } from '../types/transmilenio';

export interface GraphEdge {
  to: string;
  toIdx: number;      // dense node index of `to` (search hot path)
  routeCode: string;
  routeId: string;
  routeIdx: number;   // dense route index (WALKING_ROUTE_IDX for walks)
  type: 'troncal' | 'zonal' | 'walking' | 'cable';
  distance: number;
  time: number;
}

export interface RouteStop {
  nombre: string;
  codigo: string;
  sourceCode?: string;
  coordinate: [number, number];
  kind: 'station' | 'stop' | 'cable';
  direccion?: string;
}

/** Minimal cable-station shape fed to the router from the ArcGIS cable layer. */
export interface CableStationInput {
  codigo: string;
  nombre: string;
  coordinate: [number, number];
  orden: number; // num_est — line order (Tunal = lowest)
}

export interface JourneyStep {
  type: 'walk' | 'ride';
  fromName: string;
  fromCode: string;
  toName: string;
  toCode: string;
  routeCode?: string;
  routeId?: string; // ride steps: the route VARIANT ridden (schedule lookups)
  routeType?: 'troncal' | 'zonal' | 'cable';
  distance: number; // in meters
  time: number; // in minutes (ride steps include the expected boarding wait)
  stopCount?: number;
  stops?: string[]; // Intermediate stop names (excluding boarding/alighting)
  path?: [number, number][]; // Coordinates for this leg
  isTunnel?: boolean;
  // ── Schedule annotations (§5.6.2). Present only on schedule-aware searches;
  // minutes are counted from the plan day's midnight in Bogotá, so a value
  // above 1440 means the step happens after midnight.
  startMinute?: number;
  /** Ride steps: when the bus is expected to be boarded (service + headway wait). */
  boardMinute?: number;
  /** Ride steps: minutes spent waiting for the service window to open. */
  serviceWait?: number;
  /** Ride steps: last service of the window in effect. */
  serviceEndMinute?: number;
  /** Ride steps: the route does not operate at `boardMinute`. */
  outsideService?: boolean;
  /** Ride steps: minutes of the plan day this route operates (ranking input). */
  serviceDayMinutes?: number;
}

export interface JourneyPlan {
  totalTime: number; // in minutes
  walkDistance: number; // in meters
  transfers: number;
  steps: JourneyStep[];
  // ── Schedule summary (§5.6.2), present on schedule-aware searches.
  departMinute?: number;
  arriveMinute?: number;
  /** Total minutes waited for a service to open (already inside `totalTime`). */
  serviceWait?: number;
  /** True when the plan rides routes that are NOT running at the chosen time. */
  outsideService?: boolean;
  /** True when a boarding lands close to that route's last service. */
  lastServiceRisk?: boolean;
  /**
   * Ranking penalty (minutes) for riding services with short daily operation —
   * the exact term the search charged. Added to the time criterion when ranking,
   * never to `totalTime`: it changes which itinerary wins, not how long it takes.
   */
  servicePenalty?: number;
  /** True when some ride runs only a short part of the day (`SHORT_SERVICE_DAY_MINUTES`). */
  shortService?: boolean;
}

export interface RouteSearchParams {
  origin: [number, number];      // [lng, lat]
  destination: [number, number]; // [lng, lat]
  originStopCode?: string;
  destStopCode?: string;
  mode: 'mix' | 'troncal' | 'zonal';
  minWalk: boolean;
  sortBy?: 'transfers' | 'time' | 'walk';
  /** Departure moment in Bogotá wall-clock. Defaults to now. */
  departAt?: PlanTime;
  /**
   * Drop boardings whose route is not running at that moment. **Off by default**
   * (§5.6.2): schedules inform the itinerary — clock times, waits, out-of-service
   * tags, and the ranking preference for long-running services — but they do not
   * hide connections unless the rider explicitly asks for "only in service".
   */
  enforceSchedules?: boolean;
}

// Global router state. The search runs on dense numeric indexes (node idx ×
// route idx) — string keys in the hot loop cost more than the graph math.
let uniqueStops = new Map<string, RouteStop>();
let stopList: RouteStop[] = [];
let stopIndexByCode = new Map<string, number>();
let adjacency: GraphEdge[][] = [];
let routeKeySpan = 0;      // routeIdx values: 0..routes-1, then walking, then start
let walkingRouteIdx = 0;
let startRouteIdx = 0;
let routesById = new Map<string, RouteListItem>();
let routeIndexById = new Map<string, number>();
let rawRoutesList: RouteListItem[] = [];
let rawCableStations: CableStationInput[] = [];
// Operating windows per dense route index (undefined = unknown → always runs).
let routeSpansByIdx: Array<ServiceSpan[] | undefined> = [];

// TransMiCable: a single line of gondola stations. It connects to the rest of
// the network ONLY at Tunal ↔ Portal Tunal (the portal complex). Every other
// cable station is isolated — no walking transfers (rider must ride the cable).
const CABLE_ROUTE_CODE = 'Cable';
const CABLE_ROUTE_ID = 'cable-tmc';
const CABLE_TUNAL_CODE = '40000'; // cod_nodo of the Tunal cable station
const PORTAL_TUNAL_STATION_CODE = 'TM0119'; // troncal Portal Tunal node
// Gondola line speed + station dwell, calibrated to the real ~13–14 min
// Tunal → Mirador del Paraíso end-to-end run over the 3.4 km line.
const CABLE_SPEED_M_PER_MINUTE = 300; // 18 km/h
const CABLE_DWELL_MINUTES = 0.4;

// In-motion cruise speeds + per-stop dwell, calibrated so effective door-to-door
// speeds land on the published figures: troncal ≈ 26–27 km/h commercial speed,
// SITP zonal ≈ 13–15 km/h in mixed traffic.
const TRONCAL_SPEED_M_PER_MINUTE = 533; // 32 km/h between stations
const TRONCAL_DWELL_MINUTES = 0.5;
const ZONAL_SPEED_M_PER_MINUTE = 300;   // 18 km/h between stops
const ZONAL_DWELL_MINUTES = 0.35;

// Expected wait when boarding a service (≈ half a typical route headway).
// Charged in BOTH time and cost on every boarding — first ride and transfers —
// so itineraries with fewer/higher-frequency boardings win realistically and
// the displayed total is an honest door-to-door estimate, not a fantasy where
// every bus is already at the platform.
const BOARD_WAIT_MINUTES: Record<'troncal' | 'zonal' | 'cable', number> = {
  troncal: 3,
  zonal: 6,
  cable: 1,
};

// ─── Service schedules (§5.6.2) ─────────────────────────────────────────────
// Not every route runs at every hour. Schedules always shape the itinerary —
// clock times, opening waits, out-of-service tags and the ranking below — but by
// default they do NOT delete connections: `enforceSchedules` is opt-in, because
// a rider planning ahead (or reading a published timetable we parsed wrong) is
// better served by a labelled option than by an empty panel.
// Arriving a few minutes before the first bus is normal, so a short wait for the
// window to open is allowed and charged as real waiting time; anything longer is
// not a trip a human would make — the boarding is then tagged out of service,
// and dropped outright only when the rider asked for enforcement.
const SCHEDULE_OPENING_WAIT_MAX_MINUTES = 30;
// A boarding this close to the route's last service is flagged for the UI: the
// itinerary is valid but the rider should know they are on the final buses.
const LAST_SERVICE_WARNING_MINUTES = 20;

// Service coverage — the counterweight to optional enforcement. Two routes that
// are both open right now are not equally useful: one running 4:30 a.m.–11 p.m.
// still exists if the rider is slow, misses a bus, or comes back later, while a
// 3 h peak-only shuttle is a trap. So every boarding pays a bounded penalty in
// COST (never in the reported time) for how little of the day its route runs.
// Bounded and secondary by construction: the maximum a full 4-boarding itinerary
// can accrue is 32 min of cost, far below the transfer/walk primary scales, so
// the lexicographic optima of §5.6.1 are preserved — it only decides which of
// two otherwise comparable itineraries is offered first.
const FULL_SERVICE_DAY_MINUTES = 1080; // 18 h — "runs all day", no penalty
const SERVICE_COVERAGE_PENALTY_MINUTES = 8; // max penalty for a boarding
// At or below this the UI calls the service limited, so the rider can see WHY a
// slightly slower itinerary was ranked first. Exported so both front-ends label
// the same rides the search penalised (spec §1.1 R2 — one source of truth).
export const SHORT_SERVICE_DAY_MINUTES = 600; // 10 h

/** Ranking penalty for a route that operates `minutes` of the plan day. */
function coveragePenalty(minutes: number): number {
  if (minutes >= FULL_SERVICE_DAY_MINUTES) return 0;
  return SERVICE_COVERAGE_PENALTY_MINUTES * (1 - Math.max(minutes, 0) / FULL_SERVICE_DAY_MINUTES);
}

const WALK_SPEED_M_PER_MINUTE = 75;
const WALK_TRANSFER_THRESHOLD_M = 500;
const MAX_WALK_NEIGHBORS = 6;
const ACCESS_SEARCH_RADIUS_M = 1500;
const ACCESS_CANDIDATE_LIMIT = 12;
// Stations guaranteed as access candidates in mixed mode even when paraderos
// crowd them out of the nearest-N list (a slightly longer walk to a troncal
// station is often the far better trip).
const ACCESS_STATION_RADIUS_M = 1200;
const ACCESS_STATION_LIMIT = 4;
const MAX_TRANSFERS = 3;
// Above this straight-line distance a walking-only itinerary is not realistic;
// prefer the "no routes found" state over an absurd multi-km walk suggestion.
const WALK_ONLY_FALLBACK_MAX_M = 2500;

/**
 * Preference = the EXACT optimization criterion, enforced lexicographically:
 *
 *   - 'transfers': cost = transfers·10⁶ + door-to-door minutes. The optimum is
 *     the mathematically minimum number of transbordos reachable in the graph;
 *     among equal-transfer routes the fastest wins.
 *   - 'time': cost = door-to-door expected minutes (walks at real pace, boarding
 *     waits included, no artificial penalties). The optimum is the fastest trip.
 *   - 'walk': cost = walked meters·10³ + door-to-door minutes. The optimum walks
 *     the fewest meters (access + transfers + egress); time breaks ties.
 *
 * Every criterion additionally charges each boarding the bounded service-coverage
 * penalty (§5.6.2): a route that runs a short part of the day is a worse answer
 * than one that runs all day. It is part of the cost, not of the reported time,
 * and is small enough to stay strictly inside the secondary term.
 *
 * Dijkstra/A* stays exact on these scalarizations (non-negative edges, optimal
 * substructure), so the top result is provably optimal for its criterion within
 * the network model and the access radius — not a weighted approximation.
 */
type SearchPreference = 'transfers' | 'time' | 'walk';

function getSearchPreference(sortBy: 'transfers' | 'time' | 'walk' | undefined, minWalk: boolean): SearchPreference {
  if (sortBy === 'time') return 'time';
  if (sortBy === 'walk' || minWalk) return 'walk';
  return 'transfers';
}

// Lexicographic scales: one primary unit outweighs any achievable secondary
// (door-to-door minutes are bounded far below both).
const TRANSFER_PRIMARY_SCALE = 1e6;
const WALK_PRIMARY_SCALE = 1e3; // per walked meter

const STATION_TUNNEL_CONNECTIONS = new Set([
  tunnelKey('07111', '12003'),
  tunnelKey('14005', '06111'),
  tunnelKey('TM0121', 'TM0122'),
]);

const TUNNEL_PATHS: { [key: string]: [number, number][] } = {
  [tunnelKey('07111', '12003')]: [
    [-74.09048002, 4.61301485],
    [-74.091827, 4.614198],
    [-74.09386888, 4.6116862],
  ],
  [tunnelKey('TM0121', 'TM0122')]: [
    [-74.0684003997693, 4.602459798238067],
    [-74.0671115606689, 4.6048826151965505],
  ],
  [tunnelKey('14005', '06111')]: [
    [-74.06840143, 4.60257975],
    [-74.06730954, 4.60464286],
  ]
};

function tunnelKey(a: string, b: string): string {
  return [a, b].sort().join('|');
}

function hasTunnelConnection(a: RouteStop, b: RouteStop): boolean {
  return STATION_TUNNEL_CONNECTIONS.has(tunnelKey(a.codigo, b.codigo));
}

function canCreateWalkingTransfer(fromStop: RouteStop, toStop: RouteStop): boolean {
  // Cable stations never get proximity walking transfers — the only link to the
  // network is the explicit Tunal ↔ Portal Tunal connector added separately.
  if (fromStop.kind === 'cable' || toStop.kind === 'cable') return false;
  if (fromStop.kind === 'station' && toStop.kind === 'station') {
    return hasTunnelConnection(fromStop, toStop);
  }
  return true;
}

/**
 * Calculates geographic distance in meters between two coordinates using the Haversine formula.
 */
export function getDistance(coord1: [number, number], coord2: [number, number]): number {
  const [lon1, lat1] = coord1;
  const [lon2, lat2] = coord2;
  const R = 6371e3; // Earth radius in meters
  const phi1 = (lat1 * Math.PI) / 180;
  const phi2 = (lat2 * Math.PI) / 180;
  const deltaPhi = ((lat2 - lat1) * Math.PI) / 180;
  const deltaLon = ((lon2 - lon1) * Math.PI) / 180;

  const a =
    Math.sin(deltaPhi / 2) * Math.sin(deltaPhi / 2) +
    Math.cos(phi1) * Math.cos(phi2) * Math.sin(deltaLon / 2) * Math.sin(deltaLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return R * c;
}

// ── Spatial grid ────────────────────────────────────────────────────────────
// Uniform lat/lng grid over all stops so neighbor lookups (walk transfers,
// access-node search) are O(cell) instead of O(all stops). ~550 m cells.
const GRID_CELL_DEG = 0.005;
let spatialGrid = new Map<string, RouteStop[]>();

function gridKey(cx: number, cy: number): string {
  return `${cx}|${cy}`;
}

function buildSpatialGrid(): void {
  spatialGrid = new Map();
  for (const stop of uniqueStops.values()) {
    const key = gridKey(Math.floor(stop.coordinate[0] / GRID_CELL_DEG), Math.floor(stop.coordinate[1] / GRID_CELL_DEG));
    const bucket = spatialGrid.get(key);
    if (bucket) bucket.push(stop);
    else spatialGrid.set(key, [stop]);
  }
}

/** All stops within `radiusM` of `coordinate`, with distances, unsorted. */
function stopsWithinRadius(coordinate: [number, number], radiusM: number): { stop: RouteStop; distance: number }[] {
  const cellSpan = Math.ceil(radiusM / 111320 / GRID_CELL_DEG) + 1;
  const cx = Math.floor(coordinate[0] / GRID_CELL_DEG);
  const cy = Math.floor(coordinate[1] / GRID_CELL_DEG);
  const found: { stop: RouteStop; distance: number }[] = [];
  for (let dx = -cellSpan; dx <= cellSpan; dx++) {
    for (let dy = -cellSpan; dy <= cellSpan; dy++) {
      const bucket = spatialGrid.get(gridKey(cx + dx, cy + dy));
      if (!bucket) continue;
      for (const stop of bucket) {
        const distance = getDistance(coordinate, stop.coordinate);
        if (distance <= radiusM) found.push({ stop, distance });
      }
    }
  }
  return found;
}

/**
 * Initializes the routing graph from the loaded route list.
 */
export function initRouter(routes: RouteListItem[], cableStations?: CableStationInput[]): void {
  rawRoutesList = routes;
  if (cableStations) rawCableStations = cableStations;
  uniqueStops.clear();
  routesById = new Map(routes.map((route) => [route.id, route]));
  routeIndexById = new Map(routes.map((route, index) => [route.id, index]));
  // Cable / walking / start indexes stay `undefined` — the gondola publishes no
  // catalog schedule, so it is treated as unknown (always available) rather than
  // guessed at (spec §1 certainty).
  routeSpansByIdx = routes.map((route) => route.serviceSpans);
  const cableRouteIdx = routes.length;
  routeIndexById.set(CABLE_ROUTE_ID, cableRouteIdx);
  walkingRouteIdx = routes.length + 1;
  startRouteIdx = routes.length + 2;
  routeKeySpan = routes.length + 3;

  const startedAt = Date.now();

  // 1. Identify all unique stops/stations
  for (const route of routes) {
    if (!route.stops) continue;
    for (const stop of route.stops) {
      if (!stop.codigo) continue;

      const existing = uniqueStops.get(stop.codigo);
      if (!existing) {
        uniqueStops.set(stop.codigo, {
          nombre: stop.nombre,
          codigo: stop.codigo,
          sourceCode: stop.sourceCode,
          coordinate: stop.coordinate,
          kind: stop.kind || 'stop',
          direccion: stop.direccion,
        });
      } else {
        // Enrich existing stop if needed
        if (stop.kind === 'station' && existing.kind !== 'station') {
          existing.kind = 'station';
        }
        if (stop.direccion && !existing.direccion) {
          existing.direccion = stop.direccion;
        }
        if (stop.sourceCode && !existing.sourceCode) {
          existing.sourceCode = stop.sourceCode;
        }
      }
    }
  }

  // 1b. Register TransMiCable stations as graph nodes (kind 'cable').
  const cableLine = [...rawCableStations]
    .filter((s) => s.codigo && Number.isFinite(s.coordinate[0]) && Number.isFinite(s.coordinate[1]))
    .sort((a, b) => a.orden - b.orden);
  for (const station of cableLine) {
    if (uniqueStops.has(station.codigo)) continue;
    uniqueStops.set(station.codigo, {
      nombre: station.nombre,
      codigo: station.codigo,
      coordinate: station.coordinate,
      kind: 'cable',
    });
  }

  // Dense node indexes + adjacency lists
  stopList = Array.from(uniqueStops.values());
  stopIndexByCode = new Map(stopList.map((stop, index) => [stop.codigo, index]));
  adjacency = stopList.map(() => []);

  // 2. Add Transit edges (A -> B for successive stops in routes)
  let transitEdgesCount = 0;
  for (const route of routes) {
    if (!route.stops || route.stops.length < 2) continue;

    const speed = route.type === 'troncal' ? TRONCAL_SPEED_M_PER_MINUTE : ZONAL_SPEED_M_PER_MINUTE;
    const dwell = route.type === 'troncal' ? TRONCAL_DWELL_MINUTES : ZONAL_DWELL_MINUTES;
    const routeIdx = routeIndexById.get(route.id)!;

    for (let i = 0; i < route.stops.length - 1; i++) {
      const fromStop = route.stops[i];
      const toStop = route.stops[i + 1];
      if (!fromStop.codigo || !toStop.codigo) continue;

      const distance = getDistance(fromStop.coordinate, toStop.coordinate);
      const time = (distance / speed) + dwell;

      adjacency[stopIndexByCode.get(fromStop.codigo)!].push({
        to: toStop.codigo,
        toIdx: stopIndexByCode.get(toStop.codigo)!,
        routeCode: route.code,
        routeId: route.id,
        routeIdx,
        type: route.type,
        distance,
        time,
      });
      transitEdgesCount++;
    }
  }

  // 2b. Add TransMiCable ride edges between consecutive stations (both ways).
  // Boarding the cable after any bus counts as a transbordo (route id changes).
  for (let i = 0; i < cableLine.length - 1; i++) {
    const a = cableLine[i];
    const b = cableLine[i + 1];
    const distance = getDistance(a.coordinate, b.coordinate);
    const time = distance / CABLE_SPEED_M_PER_MINUTE + CABLE_DWELL_MINUTES;
    const edge = (from: string, to: string) => {
      adjacency[stopIndexByCode.get(from)!].push({
        to,
        toIdx: stopIndexByCode.get(to)!,
        routeCode: CABLE_ROUTE_CODE,
        routeId: CABLE_ROUTE_ID,
        routeIdx: cableRouteIdx,
        type: 'cable',
        distance,
        time,
      });
      transitEdgesCount++;
    };
    edge(a.codigo, b.codigo);
    edge(b.codigo, a.codigo);
  }

  // 3. Add short transfer walks. Station-to-station links are only verified tunnels.
  let walkingEdgesCount = 0;

  const addWalkingEdge = (fromCode: string, toCode: string, distance: number): void => {
    const fromIdx = stopIndexByCode.get(fromCode);
    const toIdx = stopIndexByCode.get(toCode);
    if (fromIdx === undefined || toIdx === undefined) return;
    const edges = adjacency[fromIdx];
    if (edges.some((edge) => edge.type === 'walking' && edge.toIdx === toIdx)) return;
    edges.push({
      to: toCode,
      toIdx,
      routeCode: 'walking',
      routeId: 'walking',
      routeIdx: walkingRouteIdx,
      type: 'walking',
      distance,
      time: distance / WALK_SPEED_M_PER_MINUTE,
    });
    walkingEdgesCount++;
  };

  for (const key of STATION_TUNNEL_CONNECTIONS) {
    const [fromCode, toCode] = key.split('|');
    const fromStop = uniqueStops.get(fromCode);
    const toStop = uniqueStops.get(toCode);
    if (!fromStop || !toStop) continue;

    let distance = getDistance(fromStop.coordinate, toStop.coordinate);
    if (TUNNEL_PATHS[key]) {
      const coords = TUNNEL_PATHS[key];
      let pathDist = 0;
      for (let idx = 0; idx < coords.length - 1; idx++) {
        pathDist += getDistance(coords[idx], coords[idx + 1]);
      }
      distance = pathDist;
    }

    addWalkingEdge(fromCode, toCode, distance);
    addWalkingEdge(toCode, fromCode, distance);
  }

  // 3b. The single TransMiCable interchange: Portal Tunal (troncal) ↔ Tunal
  // cable station. This is the ONLY way to step between the cable and the rest
  // of the network. canCreateWalkingTransfer() blocks every other cable link,
  // so this explicit connector is added by hand.
  const portalTunal = uniqueStops.get(PORTAL_TUNAL_STATION_CODE);
  const cableTunal = uniqueStops.get(CABLE_TUNAL_CODE);
  if (portalTunal && cableTunal) {
    const dist = getDistance(portalTunal.coordinate, cableTunal.coordinate);
    addWalkingEdge(PORTAL_TUNAL_STATION_CODE, CABLE_TUNAL_CODE, dist);
    addWalkingEdge(CABLE_TUNAL_CODE, PORTAL_TUNAL_STATION_CODE, dist);
  }

  // 3c. Proximity transfer walks via the spatial grid (O(stops × neighborhood)
  // instead of the old all-pairs scan).
  buildSpatialGrid();
  for (const fromStop of uniqueStops.values()) {
    if (fromStop.kind === 'cable') continue;
    const neighbors: { stopCode: string; distance: number }[] = [];
    for (const { stop: toStop, distance } of stopsWithinRadius(fromStop.coordinate, WALK_TRANSFER_THRESHOLD_M)) {
      if (toStop.codigo === fromStop.codigo) continue;
      if (!canCreateWalkingTransfer(fromStop, toStop)) continue;
      neighbors.push({ stopCode: toStop.codigo, distance });
    }
    // Sort neighbors by distance and take nearest few to keep transfers sane.
    neighbors.sort((a, b) => a.distance - b.distance);
    neighbors.slice(0, MAX_WALK_NEIGHBORS).forEach((n) => addWalkingEdge(fromStop.codigo, n.stopCode, n.distance));
  }

  console.log(
    `[Router] Graph ready in ${Date.now() - startedAt}ms. Vertices: ${uniqueStops.size}, Transit Edges: ${transitEdgesCount}, Walking Edges: ${walkingEdgesCount}`
  );
}

/**
 * Min-Heap implementation for Dijkstra priority queue.
 */
class MinHeap<T> {
  private heap: { element: T; priority: number }[] = [];

  push(element: T, priority: number) {
    this.heap.push({ element, priority });
    this.bubbleUp(this.heap.length - 1);
  }

  pop(): T | undefined {
    if (this.heap.length === 0) return undefined;
    const top = this.heap[0].element;
    const bottom = this.heap.pop()!;
    if (this.heap.length > 0) {
      this.heap[0] = bottom;
      this.sinkDown(0);
    }
    return top;
  }

  isEmpty(): boolean {
    return this.heap.length === 0;
  }

  private bubbleUp(index: number) {
    const node = this.heap[index];
    while (index > 0) {
      const parentIndex = Math.floor((index - 1) / 2);
      const parent = this.heap[parentIndex];
      if (node.priority >= parent.priority) break;
      this.heap[index] = parent;
      index = parentIndex;
    }
    this.heap[index] = node;
  }

  private sinkDown(index: number) {
    const length = this.heap.length;
    const node = this.heap[index];
    while (true) {
      const leftChildIndex = 2 * index + 1;
      const rightChildIndex = 2 * index + 2;
      let swap = -1;
      let leftChild, rightChild;

      if (leftChildIndex < length) {
        leftChild = this.heap[leftChildIndex];
        if (leftChild.priority < node.priority) {
          swap = leftChildIndex;
        }
      }

      if (rightChildIndex < length) {
        rightChild = this.heap[rightChildIndex];
        if (
          (swap === -1 && rightChild.priority < node.priority) ||
          (swap !== -1 && rightChild.priority < leftChild!.priority)
        ) {
          swap = rightChildIndex;
        }
      }

      if (swap === -1) break;
      this.heap[index] = this.heap[swap];
      index = swap;
    }
    this.heap[index] = node;
  }
}

interface DijkstraState {
  nodeIdx: number;   // dense stop index (stopList)
  routeIdx: number;  // dense index of the route we arrived on (walking/start included)
  routeCode: string; // label of that route ("walking", "start", or transit route code)
  routeId: string;
  cost: number;
  time: number;
  walkDistance: number;
  transfers: number;
  parentKey: number | null;
  hasRidden: boolean;
}

interface RawLeg {
  fromNode: string;
  toNode: string;
  routeCode: string;
  routeId: string;
  type: 'troncal' | 'zonal' | 'walking' | 'cable';
  distance: number;
  time: number;
}

function getStop(code: string, virtualStops?: Map<string, RouteStop>): RouteStop | undefined {
  return virtualStops?.get(code) ?? uniqueStops.get(code);
}

/**
 * Per-search schedule state: the calendar context plus each route's concrete
 * operating intervals, resolved lazily the first time the search touches that
 * route (a full pass over ~1000 routes would cost more than the search itself).
 */
interface ScheduleContext {
  clock: ServiceClock;
  /** routeIdx → intervals, or `null` for "unknown schedule / always open". */
  intervals: Array<number[] | null | undefined>;
  /**
   * routeIdx → 1 when the route is already running at departure AND stays open
   * for the whole planning horizon. The search then needs no interval scan at
   * all for that route, which is the common case in the middle of the day and
   * what keeps the added check off the sub-100 ms search budget (spec §1).
   */
  openThroughHorizon: Uint8Array;
  /**
   * routeIdx → minutes of the plan day the route operates (`NaN` = not resolved
   * yet). Drives the long-service ranking preference; an unknown schedule counts
   * as a full day, so a parse gap can never demote a route (spec §1 certainty).
   */
  coverage: Float64Array;
  /** routeIdx → `coveragePenalty(coverage)`, precomputed so the hot loop reads it. */
  coveragePenalties: Float64Array;
  /**
   * `true` = a boarding outside its window does not exist (the rider asked for
   * "only routes in service"). `false` (the default) = the boarding is still
   * offered, annotated and tagged. Filtering only; annotations are identical in
   * both modes, so a card can never show numbers the search did not charge.
   */
  enforce: boolean;
}

// Horizon of that fast path (2 h 30 — comfortably longer than a Bogotá
// cross-city itinerary). A boarding further than this into the trip is always
// re-checked exactly, so the shortcut can never wave a rider onto a bus after
// its last service. Measured on the committed catalog: with it, enforcing
// schedules costs single-digit-to-~15 ms over an unconstrained search; without
// it, the same searches paid 20–30 ms of pure interval scanning.
const SCHEDULE_FAST_PATH_HORIZON_MINUTES = 150;

function createScheduleContext(departAt: PlanTime, enforce: boolean): ScheduleContext {
  return {
    clock: createServiceClock(departAt),
    intervals: new Array(routeKeySpan),
    openThroughHorizon: new Uint8Array(routeKeySpan),
    coverage: new Float64Array(routeKeySpan).fill(NaN),
    coveragePenalties: new Float64Array(routeKeySpan).fill(NaN),
    enforce,
  };
}

function intervalsFor(schedule: ScheduleContext, routeIdx: number): number[] | null {
  const cached = schedule.intervals[routeIdx];
  if (cached !== undefined) return cached;

  const spans = routeSpansByIdx[routeIdx];
  const resolved = spans && spans.length > 0 ? serviceIntervals(spans, schedule.clock) : null;
  schedule.intervals[routeIdx] = resolved;

  const depart = schedule.clock.departMinute;
  const closes = resolved ? closingAfter(resolved, depart) : null;
  if (!resolved || (closes !== null && closes >= depart + SCHEDULE_FAST_PATH_HORIZON_MINUTES)) {
    schedule.openThroughHorizon[routeIdx] = 1;
  }
  return resolved;
}

/**
 * Minutes to wait at the stop before `routeIdx` can be boarded `atTime` minutes
 * into the trip, or `null` when that route simply is not running then.
 */
function scheduleWait(schedule: ScheduleContext, routeIdx: number, atTime: number): number | null {
  const withinHorizon = atTime <= SCHEDULE_FAST_PATH_HORIZON_MINUTES;
  // Hot path: a route already known to run through the horizon needs no scan.
  if (withinHorizon && schedule.openThroughHorizon[routeIdx] === 1) return 0;
  const intervals = intervalsFor(schedule, routeIdx);
  if (!intervals) return 0;
  // The line above may have just classified it — take the shortcut then too.
  if (withinHorizon && schedule.openThroughHorizon[routeIdx] === 1) return 0;
  return boardingWaitAt(intervals, schedule.clock.departMinute + atTime, SCHEDULE_OPENING_WAIT_MAX_MINUTES);
}

/**
 * Minutes of the plan day `routeIdx` operates — resolved once per route and
 * memoised, so the ranking term costs one array read per boarding.
 */
function serviceCoverage(schedule: ScheduleContext, routeIdx: number): number {
  const cached = schedule.coverage[routeIdx];
  if (!Number.isNaN(cached)) return cached;
  const intervals = intervalsFor(schedule, routeIdx);
  // Unknown schedule = always operating, so it covers the whole day (penalty 0).
  const minutes = intervals ? serviceMinutesOnPlanDay(intervals) : MINUTES_PER_DAY;
  schedule.coverage[routeIdx] = minutes;
  schedule.coveragePenalties[routeIdx] = coveragePenalty(minutes);
  return minutes;
}

/** The boarding penalty of `routeIdx` — one array read once the route is known. */
function boardingPenalty(schedule: ScheduleContext, routeIdx: number): number {
  const cached = schedule.coveragePenalties[routeIdx];
  if (!Number.isNaN(cached)) return cached;
  serviceCoverage(schedule, routeIdx);
  return schedule.coveragePenalties[routeIdx];
}

/** Public schedule of a route variant, for the UIs' service labels. */
export function getRouteServiceSpans(routeId: string | undefined): ServiceSpan[] | undefined {
  if (!routeId) return undefined;
  return routesById.get(routeId)?.serviceSpans;
}

/**
 * Writes the service annotations of one boarding onto a ride step (start/board
 * clock, wait for the window to open, last service of that window, or the
 * out-of-service flag) and returns the wait that belongs inside the step time.
 * Shared by the initial build and the post-enrichment refresh so the numbers on
 * screen can never disagree with the numbers the search charged.
 */
function annotateRideBoarding(step: JourneyStep, cursor: number, schedule: ScheduleContext): number {
  const type = step.routeType ?? 'zonal';
  const routeIdx = step.routeId === undefined ? undefined : routeIndexById.get(step.routeId);
  const intervals = routeIdx === undefined ? null : intervalsFor(schedule, routeIdx);

  step.startMinute = cursor;
  step.serviceWait = undefined;
  step.serviceEndMinute = undefined;
  step.outsideService = undefined;
  step.serviceDayMinutes = routeIdx === undefined ? undefined : serviceCoverage(schedule, routeIdx);

  // Unknown schedule (the gondola, or hours we could not parse) → always boardable.
  if (!intervals) {
    step.boardMinute = cursor + BOARD_WAIT_MINUTES[type];
    return 0;
  }

  // Identical in both modes: enforcement decides whether the boarding is offered
  // at all, never what the rider is told about it.
  const wait = boardingWaitAt(intervals, cursor, SCHEDULE_OPENING_WAIT_MAX_MINUTES);
  if (wait === null) {
    // Not running when the rider gets there, and not opening soon enough to wait
    // it out — surfaced to the rider, never hidden.
    step.boardMinute = cursor + BOARD_WAIT_MINUTES[type];
    step.outsideService = true;
    return 0;
  }

  const readyMinute = cursor + wait;
  step.boardMinute = readyMinute + BOARD_WAIT_MINUTES[type];
  if (wait > 0) step.serviceWait = wait;

  const closes = closingAfter(intervals, readyMinute);
  if (closes !== null) step.serviceEndMinute = closes;
  return wait;
}

/**
 * Slice coordinates of a route variant between two stops. `fallback` is the
 * stop-to-stop chain of the ride (boarding, intermediates, alighting) — used
 * whenever the variant has no usable geometry or the slice snaps wrong.
 */
function sliceRouteGeometry(
  routeId: string,
  fromStopCode: string,
  toStopCode: string,
  fallback: [number, number][]
): [number, number][] {
  const route = routesById.get(routeId);
  const fromStop = uniqueStops.get(fromStopCode);
  const toStop = uniqueStops.get(toStopCode);

  if (!fromStop || !toStop) return fallback;
  if (!route || !route.geometry || !route.geometry.paths || route.geometry.paths.length === 0) {
    return fallback;
  }

  let bestPath: [number, number][] | null = null;
  let bestScore = Infinity;
  let bestIdxA = 0;
  let bestIdxB = 0;

  for (const path of route.geometry.paths) {
    const coords = path as [number, number][];
    if (coords.length === 0) continue;

    let idxA = 0;
    let idxB = 0;
    let minDistA = Infinity;
    let minDistB = Infinity;

    for (let i = 0; i < coords.length; i++) {
      const coord = coords[i];
      const distA = getDistance(coord, fromStop.coordinate);
      const distB = getDistance(coord, toStop.coordinate);

      if (distA < minDistA) {
        minDistA = distA;
        idxA = i;
      }
      if (distB < minDistB) {
        minDistB = distB;
        idxB = i;
      }
    }

    const score = minDistA + minDistB;
    if (score < bestScore) {
      bestScore = score;
      bestPath = coords;
      bestIdxA = idxA;
      bestIdxB = idxB;
    }
  }

  if (!bestPath) return fallback;

  let sliced: [number, number][];
  if (bestIdxA <= bestIdxB) {
    sliced = bestPath.slice(bestIdxA, bestIdxB + 1);
  } else {
    sliced = bestPath.slice(bestIdxB, bestIdxA + 1).reverse();
  }

  if (sliced.length < 2) return fallback;

  // Sanity check: if the sliced path is unreasonably long compared to
  // straight-line distance, the geometry snapped to the wrong segment.
  const straightDist = getDistance(fromStop.coordinate, toStop.coordinate);
  let slicedDist = 0;
  for (let k = 0; k < sliced.length - 1; k++) {
    slicedDist += getDistance(sliced[k], sliced[k + 1]);
  }
  // Allow up to 8x straight distance for winding routes (or ignore if straight distance is small)
  if (straightDist > 100 && slicedDist > straightDist * 8) return fallback;

  return sliced;
}

/**
 * Collapses successive graph legs on the same route VARIANT into a single Ride
 * step. Grouping is by routeId (not code) so the two directions of a same-coded
 * route can never fuse into one impossible U-turn ride. Ride step times include
 * the expected boarding wait; geometry is sliced once per committed step.
 */
function buildJourneySteps(
  legs: RawLeg[],
  virtualStops?: Map<string, RouteStop>,
  schedule?: ScheduleContext
): JourneyStep[] {
  const steps: JourneyStep[] = [];
  if (legs.length === 0) return steps;

  let currentStep: JourneyStep | null = null;
  let currentRouteId: string | null = null;
  let currentChain: [number, number][] = [];
  // Wall-clock cursor: the moment the step being built starts. Advanced only on
  // commit, so a ride's boarding annotations use the same cumulative time the
  // search charged for that path.
  let cursor = schedule ? schedule.clock.departMinute : 0;

  const commitCurrent = (): void => {
    if (!currentStep) return;
    currentStep.path = sliceRouteGeometry(currentRouteId!, currentStep.fromCode, currentStep.toCode, currentChain);
    cursor += currentStep.time;
    steps.push(currentStep);
    currentStep = null;
    currentRouteId = null;
    currentChain = [];
  };

  for (const leg of legs) {
    const fromStop = getStop(leg.fromNode, virtualStops);
    const toStop = getStop(leg.toNode, virtualStops);
    if (!fromStop || !toStop) continue;

    if (leg.type === 'walking') {
      commitCurrent();

      const key = tunnelKey(fromStop.codigo, toStop.codigo);
      let walkPath = [fromStop.coordinate, toStop.coordinate];
      let distance = leg.distance;
      let time = leg.time;

      if (TUNNEL_PATHS[key]) {
        const coords = TUNNEL_PATHS[key];
        const isReversed = getDistance(fromStop.coordinate, coords[0]) > getDistance(fromStop.coordinate, coords[coords.length - 1]);
        walkPath = isReversed ? [...coords].reverse() : coords;

        let pathDist = 0;
        for (let idx = 0; idx < walkPath.length - 1; idx++) {
          pathDist += getDistance(walkPath[idx], walkPath[idx + 1]);
        }
        distance = pathDist;
        time = pathDist / WALK_SPEED_M_PER_MINUTE;
      }

      // Add Walk step
      const isTunnel = hasTunnelConnection(fromStop, toStop);
      steps.push({
        type: 'walk',
        fromName: fromStop.nombre,
        fromCode: fromStop.codigo,
        toName: toStop.nombre,
        toCode: toStop.codigo,
        distance,
        time,
        path: walkPath,
        isTunnel,
        ...(schedule ? { startMinute: cursor } : {}),
      });
      cursor += time;
    } else if (currentStep && currentRouteId === leg.routeId) {
      // Extend existing ride step
      if (currentStep.stops && fromStop.codigo !== currentStep.fromCode) {
        const lastStop = currentStep.stops[currentStep.stops.length - 1];
        if (lastStop !== fromStop.nombre) currentStep.stops.push(fromStop.nombre);
      }
      currentStep.toName = toStop.nombre;
      currentStep.toCode = toStop.codigo;
      currentStep.distance += leg.distance;
      currentStep.time += leg.time;
      if (currentStep.stopCount !== undefined) currentStep.stopCount++;
      currentChain.push(toStop.coordinate);
    } else {
      // New ride step (first boarding or a transfer)
      commitCurrent();
      const rideStep: JourneyStep = {
        type: 'ride',
        fromName: fromStop.nombre,
        fromCode: fromStop.codigo,
        toName: toStop.nombre,
        toCode: toStop.codigo,
        routeCode: leg.routeCode,
        routeId: leg.routeId,
        routeType: leg.type,
        distance: leg.distance,
        time: leg.time + BOARD_WAIT_MINUTES[leg.type],
        stopCount: 1,
        stops: [], // Will populate if multiple stops are traversed
      };
      // Waiting for the window to open is real trip time, exactly as the search
      // charged it, so it belongs inside the step duration.
      if (schedule) rideStep.time += annotateRideBoarding(rideStep, cursor, schedule);
      currentStep = rideStep;
      currentRouteId = leg.routeId;
      currentChain = [fromStop.coordinate, toStop.coordinate];
    }
  }

  commitCurrent();
  return steps;
}

/**
 * Resolves routes using Dijkstra's algorithm.
 */
function isStopCompatible(stop: RouteStop, mode: 'mix' | 'troncal' | 'zonal'): boolean {
  if (mode === 'troncal') {
    return stop.kind === 'station';
  }
  if (mode === 'zonal') {
    return stop.kind === 'stop';
  }
  return true;
}

function findAccessNodes(
  coordinate: [number, number],
  mode: 'mix' | 'troncal' | 'zonal',
  selectedStopCode?: string,
  minWalk: boolean = false
): { nodeCode: string; distance: number }[] {
  const selectedCode = String(selectedStopCode || '').trim();
  const candidates: { nodeCode: string; distance: number }[] = [];
  const seenCodes = new Set<string>();

  if (selectedCode) {
    const exact = uniqueStops.get(selectedCode);
    if (exact && isStopCompatible(exact, mode)) {
      candidates.push({ nodeCode: exact.codigo, distance: 0 });
      seenCodes.add(exact.codigo);
    }

    // Selected codes can be source codes shared by split platforms — pull the
    // platforms from the local neighborhood instead of scanning every stop.
    for (const { stop, distance } of stopsWithinRadius(coordinate, ACCESS_SEARCH_RADIUS_M)) {
      if (stop.sourceCode === selectedCode && isStopCompatible(stop, mode) && !seenCodes.has(stop.codigo)) {
        candidates.push({ nodeCode: stop.codigo, distance });
        seenCodes.add(stop.codigo);
      }
    }
  }

  // If the user does NOT want to minimize walking, we allow walking up to 400m
  // to alternative stops/stations. This opens up direct or fewer-transfer routes.
  const searchRadius = selectedCode ? (minWalk ? 0 : 400) : ACCESS_SEARCH_RADIUS_M;
  const limit = selectedCode ? 6 : ACCESS_CANDIDATE_LIMIT;

  if (searchRadius > 0) {
    const inRadius = stopsWithinRadius(coordinate, searchRadius)
      .filter(({ stop }) => isStopCompatible(stop, mode) && !seenCodes.has(stop.codigo))
      .sort((a, b) => a.distance - b.distance);

    for (const { stop, distance } of inRadius.slice(0, limit)) {
      candidates.push({ nodeCode: stop.codigo, distance });
      seenCodes.add(stop.codigo);
    }

    // In mixed mode paraderos are dense enough to crowd every station out of
    // the nearest-N list; guarantee the closest stations as candidates too.
    if (mode === 'mix' && !selectedCode) {
      const stations = inRadius
        .filter(({ stop, distance }) => stop.kind === 'station' && distance <= ACCESS_STATION_RADIUS_M && !seenCodes.has(stop.codigo))
        .slice(0, ACCESS_STATION_LIMIT);
      for (const { stop, distance } of stations) {
        candidates.push({ nodeCode: stop.codigo, distance });
        seenCodes.add(stop.codigo);
      }
    }
  }

  if (candidates.length > 0) {
    return candidates.sort((a, b) => a.distance - b.distance);
  }

  // Fallback: widen the search ring until something compatible appears.
  for (let radius = ACCESS_SEARCH_RADIUS_M * 2; radius <= ACCESS_SEARCH_RADIUS_M * 8; radius *= 2) {
    const widened = stopsWithinRadius(coordinate, radius)
      .filter(({ stop }) => isStopCompatible(stop, mode))
      .sort((a, b) => a.distance - b.distance)
      .slice(0, 5);
    if (widened.length > 0) {
      return widened.map(({ stop, distance }) => ({ nodeCode: stop.codigo, distance }));
    }
  }
  return [];
}

/**
 * Ranks journey plans in place by the chosen preference. Each criterion uses the
 * others as deterministic tie-breakers so the ordering is stable. Exported so the
 * async walking-geometry enrichment can re-rank with accurate distances/times
 * (the initial search ranks on straight-line estimates).
 */
export function sortJourneyPlans(plans: JourneyPlan[], sortBy?: 'transfers' | 'time' | 'walk'): void {
  const sortCriteria = sortBy || 'transfers';
  // Ranked minutes = the search's own time criterion: door-to-door time plus the
  // long-service preference the search charged in cost (§5.6.2). Ranking on the
  // raw total here would silently undo that preference on every re-rank.
  const ranked = (plan: JourneyPlan): number => plan.totalTime + (plan.servicePenalty ?? 0);
  plans.sort((a, b) => {
    if (sortCriteria === 'transfers') {
      return a.transfers - b.transfers || ranked(a) - ranked(b) || a.walkDistance - b.walkDistance;
    } else if (sortCriteria === 'time') {
      return ranked(a) - ranked(b) || a.transfers - b.transfers || a.walkDistance - b.walkDistance;
    }
    // 'walk'
    return a.walkDistance - b.walkDistance || ranked(a) - ranked(b) || a.transfers - b.transfers;
  });
}

// The search keeps collecting arrivals a bit past the best complete journey so
// the user gets genuine alternatives, not just the single optimum: 15 extra
// minutes within the same primary tier, plus one primary step for 'transfers'
// (show the +1-transbordo faster option) and ~120 m for 'walk'.
const SECONDARY_SLACK_MINUTES = 15;
function diversitySlack(preference: SearchPreference): number {
  if (preference === 'transfers') return TRANSFER_PRIMARY_SCALE + SECONDARY_SLACK_MINUTES;
  if (preference === 'walk') return 120 * WALK_PRIMARY_SCALE + SECONDARY_SLACK_MINUTES;
  return SECONDARY_SLACK_MINUTES;
}
const TERMINAL_CANDIDATE_CAP = 24;
// Absolute bound on reconstructed candidates (guards reconstruction cost).
const TERMINAL_HARD_CAP = 64;
// Hard ceiling on node expansions so a pathological graph can never blow past
// the sub-100ms search budget (spec §1 perf). With the end-cost bound below the
// search normally terminates far earlier.
const MAX_NODE_POPS = 60000;

function findRoutesCore(params: RouteSearchParams): JourneyPlan[] {
  const { origin, destination, originStopCode, destStopCode, mode, minWalk, sortBy } = params;
  const preference = getSearchPreference(sortBy, minWalk);
  // Departure clock: every boarding is timed against the route's own window
  // (§5.6.2) — it is always annotated and always ranked by how much of the day
  // the route runs; `enforceSchedules` additionally drops the ones not running.
  const schedule = createScheduleContext(params.departAt ?? bogotaNow(), params.enforceSchedules === true);
  const walkPrimary = preference === 'walk' ? WALK_PRIMARY_SCALE : 0;
  const slack = diversitySlack(preference);

  // 1. Identify starting nodes
  const startNodes = findAccessNodes(origin, mode, originStopCode, minWalk);
  if (startNodes.length === 0) return [];

  // 2. Identify destination nodes
  const destNodes = new Map<string, number>(); // nodeCode -> walkDistance
  findAccessNodes(destination, mode, destStopCode, minWalk).forEach((node) => destNodes.set(node.nodeCode, node.distance));
  if (destNodes.size === 0) return [];

  // 3. A* over (node, arriving route) states, ordered by cost + an admissible
  // remaining-cost bound (straight-line distance at the fastest speed the mode
  // allows — cost can never undercut time, and time can never undercut that).
  // The egress walk is added the moment a destination node is popped, and the
  // frontier is monotone in bound, so once the cheapest complete journey is
  // known everything bounded above it (+ slack for alternatives) is cut off —
  // this is both the correctness fix (a longer ride that alights closer can
  // win) and the main speed win (no full-graph drain hunting arrivals).
  const queue = new MinHeap<DijkstraState>();
  const bestCosts = new Map<number, number>();
  const stateRegistry = new Map<number, DijkstraState>();
  const makeKey = (nodeIdx: number, routeIdx: number) => nodeIdx * routeKeySpan + routeIdx;

  // Destination nodes keyed by dense index
  const destByIdx = new Map<number, number>(); // nodeIdx -> egress walk distance
  for (const [code, distance] of destNodes) {
    const idx = stopIndexByCode.get(code);
    if (idx !== undefined) destByIdx.set(idx, distance);
  }

  // Admissible remaining-cost bound: straight-line time at the fastest speed the
  // mode allows; in walk-primary mode every completion additionally walks at
  // least the smallest egress of any destination candidate.
  // Every destination candidate resolved to a code with no dense index — nothing
  // in the graph can be an arrival, so bail out instead of letting the bound
  // below become `Infinity` (Math.min of nothing) and silently cutting the very
  // first frontier expansion, which returned "no routes" with no explanation.
  if (destByIdx.size === 0) return [];

  const heuristicSpeed = mode === 'zonal' ? ZONAL_SPEED_M_PER_MINUTE : TRONCAL_SPEED_M_PER_MINUTE;
  const minEgressPrimary = walkPrimary > 0 ? Math.min(...destByIdx.values()) * walkPrimary : 0;
  const heuristicCache = new Float64Array(stopList.length).fill(NaN);
  const remainingBound = (nodeIdx: number): number => {
    let bound = heuristicCache[nodeIdx];
    if (Number.isNaN(bound)) {
      bound = getDistance(stopList[nodeIdx].coordinate, destination) / heuristicSpeed + minEgressPrimary;
      heuristicCache[nodeIdx] = bound;
    }
    return bound;
  };

  // Push starting states
  for (const start of startNodes) {
    const nodeIdx = stopIndexByCode.get(start.nodeCode);
    if (nodeIdx === undefined) continue;
    const walkTime = start.distance / WALK_SPEED_M_PER_MINUTE;
    const cost = walkTime + start.distance * walkPrimary;
    const state: DijkstraState = {
      nodeIdx,
      routeIdx: startRouteIdx,
      routeCode: 'start',
      routeId: 'start',
      cost,
      time: walkTime,
      walkDistance: start.distance,
      transfers: 0,
      parentKey: null,
      hasRidden: false,
    };

    const key = makeKey(nodeIdx, startRouteIdx);
    bestCosts.set(key, cost);
    stateRegistry.set(key, state);
    queue.push(state, cost + remainingBound(nodeIdx));
  }

  const results: { state: DijkstraState; egressDistance: number }[] = [];
  let bestEndCost = Infinity;
  let nodePops = 0;

  while (!queue.isEmpty()) {
    if (++nodePops > MAX_NODE_POPS) break;
    const current = queue.pop()!;
    const frontierBound = current.cost + remainingBound(current.nodeIdx);
    // The frontier is monotone in bound, so past bestEndCost nothing can improve
    // the optimum — stop there once enough alternatives are gathered, and stop
    // unconditionally past the diversity band.
    if (frontierBound > bestEndCost + slack) break;
    if (results.length >= TERMINAL_CANDIDATE_CAP && frontierBound > bestEndCost) break;

    const currentKey = makeKey(current.nodeIdx, current.routeIdx);
    const bestCost = bestCosts.get(currentKey);
    if (bestCost !== undefined && current.cost > bestCost) continue;

    const egressDistance = destByIdx.get(current.nodeIdx);
    // A journey candidate must contain at least one ride (pure walking is the
    // explicit fallback plan). An arrival straight off a transfer walk whose
    // alighting node is itself a destination candidate is dominated by ending
    // there (straight-line egress obeys the triangle inequality) — skip it.
    const walkArrivalParent = current.routeIdx === walkingRouteIdx && current.parentKey !== null
      ? stateRegistry.get(current.parentKey)?.nodeIdx
      : undefined;
    const dominatedWalkArrival = walkArrivalParent !== undefined && destByIdx.has(walkArrivalParent);
    if (egressDistance !== undefined && current.hasRidden && !dominatedWalkArrival) {
      const endCost = current.cost + egressDistance / WALK_SPEED_M_PER_MINUTE + egressDistance * walkPrimary;
      if (endCost < bestEndCost) bestEndCost = endCost;
      results.push({ state: current, egressDistance });
      if (results.length >= TERMINAL_HARD_CAP) break;
    }

    const currentStop = stopList[current.nodeIdx];
    const edges = adjacency[current.nodeIdx];
    for (const edge of edges) {
      if (edge.type === 'troncal' && mode === 'zonal') continue;
      if (edge.type === 'zonal' && mode === 'troncal') continue;
      // TransMiCable is its own system — only offered in the mixed mode.
      if (edge.type === 'cable' && mode !== 'mix') continue;

      // CRITICAL: Troncal routes can ONLY be boarded/alighted at stations.
      // A paradero (zonal stop) cannot physically serve troncal buses.
      if (edge.type === 'troncal') {
        if (currentStop.kind !== 'station') continue;
        if (stopList[edge.toIdx].kind !== 'station') continue;
      }

      let edgeTime = edge.time;
      let edgeCost;
      let isTransfer = false;

      if (edge.type === 'walking') {
        const toStop = stopList[edge.toIdx];
        const isTunnel = currentStop.kind === 'station' && toStop.kind === 'station' && hasTunnelConnection(currentStop, toStop);

        if (!isTunnel && (current.routeIdx === startRouteIdx || current.routeIdx === walkingRouteIdx)) {
          continue;
        }

        edgeCost = edgeTime + edge.distance * walkPrimary;
      } else {
        // Boarding = first ride, or any change of route VARIANT (routeIdx, so a
        // same-coded opposite-direction variant is a real transfer, never a
        // free "continuation" through a U-turn).
        const isBoarding = !current.hasRidden || current.routeIdx !== edge.routeIdx;
        let penalty = 0;
        if (isBoarding) {
          // A short wait for the first bus is allowed and paid for. A boarding
          // the route cannot serve at all only *disappears* when the rider asked
          // for enforcement; otherwise it stays, tagged, and pays the full
          // coverage penalty below (a route closed all day covers 0 minutes).
          const wait = scheduleWait(schedule, edge.routeIdx, current.time);
          if (wait === null) {
            if (schedule.enforce) continue;
          } else {
            edgeTime += wait;
          }
          edgeTime += BOARD_WAIT_MINUTES[edge.type];
          penalty = boardingPenalty(schedule, edge.routeIdx);
        }
        edgeCost = edgeTime + penalty;
        if (isBoarding && current.hasRidden) {
          // Hard cap on transfers — prevent absurd multi-transfer routes
          if (current.transfers >= MAX_TRANSFERS) continue;
          if (preference === 'transfers') edgeCost += TRANSFER_PRIMARY_SCALE;
          isTransfer = true;
        }
      }

      const nextCost = current.cost + edgeCost;
      if (nextCost + remainingBound(edge.toIdx) > bestEndCost + slack) continue;

      const nextKey = makeKey(edge.toIdx, edge.routeIdx);
      const prevBest = bestCosts.get(nextKey);

      if (prevBest === undefined || nextCost < prevBest) {
        bestCosts.set(nextKey, nextCost);
        const nextState: DijkstraState = {
          nodeIdx: edge.toIdx,
          routeIdx: edge.routeIdx,
          routeCode: edge.type === 'walking' ? 'walking' : edge.routeCode,
          routeId: edge.type === 'walking' ? 'walking' : edge.routeId,
          cost: nextCost,
          time: current.time + edgeTime,
          walkDistance: current.walkDistance + (edge.type === 'walking' ? edge.distance : 0),
          transfers: current.transfers + (isTransfer ? 1 : 0),
          parentKey: currentKey,
          hasRidden: current.hasRidden || (edge.type !== 'walking'),
        };
        stateRegistry.set(nextKey, nextState);
        queue.push(nextState, nextCost + remainingBound(edge.toIdx));
      }
    }
  }

  // 4. Reconstruct paths and map to JourneyPlan structures
  const plans: JourneyPlan[] = [];

  for (const { state: targetState, egressDistance } of results) {
    const legs: RawLeg[] = [];
    const virtualStops = new Map<string, RouteStop>();
    let state = targetState;

    if (egressDistance > 0) {
      legs.push({
        fromNode: stopList[state.nodeIdx].codigo,
        toNode: 'END',
        routeCode: 'walking',
        routeId: 'walking',
        type: 'walking',
        distance: egressDistance,
        time: egressDistance / WALK_SPEED_M_PER_MINUTE,
      });

      virtualStops.set('END', {
        nombre: 'Destino',
        codigo: 'END',
        coordinate: destination,
        kind: 'stop',
      });
    }

    while (state.parentKey !== null) {
      const parent = stateRegistry.get(state.parentKey);
      if (!parent) break;

      const edges = adjacency[parent.nodeIdx];
      let edge = edges.find((e) => e.toIdx === state.nodeIdx && e.routeIdx === state.routeIdx);
      if (!edge && edges.length > 0) {
        edge = edges.find((e) => e.toIdx === state.nodeIdx);
      }

      if (edge) {
        legs.unshift({
          fromNode: stopList[parent.nodeIdx].codigo,
          toNode: stopList[state.nodeIdx].codigo,
          routeCode: edge.routeCode,
          routeId: edge.routeId,
          type: edge.type,
          distance: edge.distance,
          time: edge.time,
        });
      }

      state = parent;
    }

    const startNodeCode = stopList[state.nodeIdx].codigo;
    const startStop = uniqueStops.get(startNodeCode);
    const startWalk = startNodes.find((s) => s.nodeCode === startNodeCode);

    if (startStop && startWalk && startWalk.distance > 0) {
      legs.unshift({
        fromNode: 'START',
        toNode: startNodeCode,
        routeCode: 'walking',
        routeId: 'walking',
        type: 'walking',
        distance: startWalk.distance,
        time: startWalk.distance / WALK_SPEED_M_PER_MINUTE,
      });

      virtualStops.set('START', {
        nombre: 'Origen',
        codigo: 'START',
        coordinate: origin,
        kind: 'stop',
      });
    }

    const journeySteps = buildJourneySteps(legs, virtualStops, schedule);
    // Totals from the built steps: ride steps carry their boarding wait, so the
    // displayed time is door-to-door (walks + waits + rides), matching what the
    // async walking enrichment recomputes later.
    const totalTime = journeySteps.reduce((sum, s) => sum + s.time, 0);
    const totalWalkDistance = journeySteps.reduce((sum, s) => sum + (s.type === 'walk' ? s.distance : 0), 0);

    const plan: JourneyPlan = {
      totalTime: Math.round(totalTime),
      walkDistance: Math.round(totalWalkDistance),
      transfers: targetState.transfers,
      steps: journeySteps,
    };
    summarizeSchedule(plan, schedule.clock);
    plans.push(plan);
  }

  // Deduplicate, validate, and filter plans
  const finalPlans: JourneyPlan[] = [];
  const seenRouteKeys = new Set<string>();

  for (const plan of plans) {
    // Reject plans demanding more total walking than we'd ever suggest as a
    // walk — they only appear when the mode filter leaves no sane option (e.g.
    // troncal-only to a neighborhood without stations) and no human would
    // follow them; "no routes" is the honest answer there.
    if (plan.walkDistance > WALK_ONLY_FALLBACK_MAX_M) continue;

    // Validate: reject plans where troncal rides start/end at non-station nodes
    const hasInvalidTroncalBoarding = plan.steps.some((step) => {
      if (step.type !== 'ride' || step.routeType !== 'troncal') return false;
      const fromNode = uniqueStops.get(step.fromCode);
      const toNode = uniqueStops.get(step.toCode);
      return (fromNode && fromNode.kind !== 'station') || (toNode && toNode.kind !== 'station');
    });
    if (hasInvalidTroncalBoarding) continue;

    const routeKey = plan.steps
      .filter((s) => s.type === 'ride')
      .map((s) => `${s.routeCode}|${s.fromCode}|${s.toCode}`)
      .join(' -> ');

    if (!seenRouteKeys.has(routeKey) && plan.steps.length > 0) {
      seenRouteKeys.add(routeKey);
      finalPlans.push(plan);
    }
  }

  sortJourneyPlans(finalPlans, sortBy);

  // Show at most 4 distinct options (we over-collected terminals for ranking).
  return finalPlans.slice(0, 4);
}

/**
 * Rolls the per-step schedule annotations up onto the plan: clock departure and
 * arrival, total waiting for service to open, whether any ride is out of service
 * and whether any boarding lands on that route's last buses.
 */
function summarizeSchedule(plan: JourneyPlan, clock: ServiceClock): void {
  plan.departMinute = clock.departMinute;
  plan.arriveMinute = clock.departMinute + plan.totalTime;

  let serviceWait = 0;
  let outsideService = false;
  let lastServiceRisk = false;
  let servicePenalty = 0;
  let shortService = false;

  for (const step of plan.steps) {
    if (step.serviceWait) serviceWait += step.serviceWait;
    if (step.outsideService) outsideService = true;
    if (step.type === 'ride' && step.serviceDayMinutes !== undefined) {
      servicePenalty += coveragePenalty(step.serviceDayMinutes);
      if (step.serviceDayMinutes <= SHORT_SERVICE_DAY_MINUTES) shortService = true;
    }
    if (
      step.serviceEndMinute !== undefined &&
      step.boardMinute !== undefined &&
      step.serviceEndMinute - step.boardMinute <= LAST_SERVICE_WARNING_MINUTES
    ) {
      lastServiceRisk = true;
    }
  }

  // Assigned unconditionally (not only when set) so a re-annotation after the
  // walking pass cannot leave a stale warning behind.
  plan.serviceWait = serviceWait > 0 ? Math.round(serviceWait) : undefined;
  plan.outsideService = outsideService || undefined;
  plan.lastServiceRisk = lastServiceRisk || undefined;
  plan.servicePenalty = servicePenalty > 0 ? servicePenalty : undefined;
  plan.shortService = shortService || undefined;
}

function createWalkingFallbackPlan(
  origin: [number, number],
  destination: [number, number],
  departMinute: number
): JourneyPlan {
  const distance = getDistance(origin, destination);
  const time = distance / WALK_SPEED_M_PER_MINUTE;
  return {
    totalTime: Math.round(time),
    walkDistance: Math.round(distance),
    transfers: 0,
    departMinute,
    arriveMinute: departMinute + Math.round(time),
    steps: [
      {
        type: 'walk',
        fromName: 'Origen',
        fromCode: 'START',
        toName: 'Destino',
        toCode: 'END',
        distance: distance,
        time: time,
        path: [origin, destination],
        startMinute: departMinute,
      },
    ],
  };
}

export function findRoutes(params: RouteSearchParams): JourneyPlan[] {
  const { origin, destination, mode } = params;

  if (uniqueStops.size === 0) {
    console.warn('[Router] Graph is empty. Initializing router with rawRoutesList.');
    initRouter(rawRoutesList, rawCableStations);
  }

  // Resolve the departure clock once so the search, the walking fallback and the
  // out-of-service retry all reason about the same moment.
  const departAt = params.departAt ?? bogotaNow();
  const search: RouteSearchParams = { ...params, departAt };

  console.log(`[Router] Routing request. Mode: ${mode}`);

  // 1. Primary search — schedule-filtered only if the caller asked for it.
  let plans = findRoutesCore(search);

  // 1b. Nothing operates at that hour: a dead end is the worst possible answer,
  // so an enforced search that found nothing re-plans without the filter. Those
  // itineraries come back tagged (`plan.outsideService`, per-step windows) so the
  // UI can show WHAT exists and WHEN it starts instead of "sin rutas" (spec §4.2
  // graceful degradation). The default search never needs this — it never
  // filtered in the first place.
  if (plans.length === 0 && search.enforceSchedules === true) {
    const relaxed = findRoutesCore({ ...search, enforceSchedules: false });
    if (relaxed.length > 0) {
      console.log('[Router] No routes in service at that time. Returning out-of-service options.');
      plans = relaxed;
    }
  }

  // 2. Walking-only plan: the sole option when no transit exists under the
  // selected filter, and a competing option whenever plain walking would beat
  // every transit plan door-to-door (common on sub-km trips once waits are
  // modeled). Beyond walkable range a straight "walk 8 km / 100 min" plan is
  // misleading, so an empty result stays empty ("no routes" state).
  const directWalk = getDistance(origin, destination);
  if (directWalk <= WALK_ONLY_FALLBACK_MAX_M) {
    const walkPlan = createWalkingFallbackPlan(origin, destination, departAt.minute);
    if (plans.length === 0) {
      console.log('[Router] No transit routes found. Falling back to walking-only plan.');
      plans.push(walkPlan);
    } else if (walkPlan.totalTime <= Math.min(...plans.map((p) => p.totalTime))) {
      plans.push(walkPlan);
      sortJourneyPlans(plans, params.sortBy);
      plans.splice(4);
    }
  } else if (plans.length === 0) {
    console.log('[Router] No transit routes found and destination too far to walk.');
  }

  return plans;
}

export interface WalkingPathResult {
  coordinates: [number, number][];
  distance: number;
  time: number;
}

const walkingCache = new Map<string, WalkingPathResult>();

export async function fetchWalkingPath(from: [number, number], to: [number, number]): Promise<WalkingPathResult> {
  const key = `${from[0].toFixed(5)},${from[1].toFixed(5)}|${to[0].toFixed(5)},${to[1].toFixed(5)}`;
  const cached = walkingCache.get(key);
  if (cached) return cached;

  try {
    // Lazy import keeps this module free of api.ts's Vite-only globals
    // (import.meta.env), so the router stays importable from Node test harnesses.
    const { api } = await import('./api');
    const data = await api.getWalkingRoute(from, to);
    const route = data.data;
    if (data.success && route && route.coordinates.length >= 2) {
      const result: WalkingPathResult = {
        coordinates: route.coordinates,
        distance: route.distance,
        time: route.time,
      };
      walkingCache.set(key, result);
      return result;
    }
  } catch (error) {
    console.warn('[Router] Failed to fetch walking path from API:', error);
  }

  // Fallback to straight line
  const distance = getDistance(from, to);
  return {
    coordinates: [from, to],
    distance,
    time: distance / WALK_SPEED_M_PER_MINUTE,
  };
}

export function isTunnelTransfer(fromCode: string, toCode: string): boolean {
  const fromStop = uniqueStops.get(fromCode);
  const toStop = uniqueStops.get(toCode);
  return !!(fromStop && toStop && fromStop.kind === 'station' && toStop.kind === 'station' && hasTunnelConnection(fromStop, toStop));
}

/**
 * Replace each straight-line walk leg with a real OSRM pedestrian route
 * (geometry + distance + time), then recompute plan totals and re-rank — the
 * initial search uses straight-line estimates, so the shown answer is only
 * accurate after this pass. Shared by the website and mobile planners so both
 * get identical walking. Tunnel transfers keep their straight geometry.
 * Mutates `plans` in place and returns it.
 */
/**
 * Re-runs the schedule annotations over a plan whose step times changed (the
 * walking-geometry pass), so clock times, waits and window labels stay in sync
 * with the itinerary actually being shown.
 */
function reannotatePlanSchedule(plan: JourneyPlan, schedule: ScheduleContext): void {
  let cursor = schedule.clock.departMinute;
  for (const step of plan.steps) {
    if (step.type === 'walk') {
      step.startMinute = cursor;
    } else {
      const previousWait = step.serviceWait ?? 0;
      step.time += annotateRideBoarding(step, cursor, schedule) - previousWait;
    }
    cursor += step.time;
  }
  plan.totalTime = Math.round(cursor - schedule.clock.departMinute);
  summarizeSchedule(plan, schedule.clock);
}

export async function enrichWalkingGeometries(
  plans: JourneyPlan[],
  sortBy?: 'transfers' | 'time' | 'walk',
  departAt?: PlanTime
): Promise<JourneyPlan[]> {
  const jobs: Promise<void>[] = [];
  for (const plan of plans) {
    for (const step of plan.steps) {
      if (step.type !== 'walk' || !step.path || step.path.length !== 2) continue;
      if (isTunnelTransfer(step.fromCode, step.toCode)) {
        step.isTunnel = true;
        continue;
      }
      const [from, to] = step.path;
      jobs.push(
        fetchWalkingPath(from, to).then((res) => {
          step.path = res.coordinates;
          step.distance = res.distance;
          step.time = res.time;
        })
      );
    }
  }
  if (jobs.length === 0) return plans;
  await Promise.all(jobs);

  // Real walking times shift every downstream boarding, so the schedule
  // annotations are recomputed here (not just the totals) — otherwise a card
  // could show a clock time the route's own window no longer covers (§5.6.2).
  // One context serves every plan: annotations do not depend on enforcement, so
  // an out-of-service itinerary is re-annotated exactly as it was built.
  const schedule = departAt ? createScheduleContext(departAt, false) : null;
  for (const plan of plans) {
    plan.walkDistance = Math.round(plan.steps.reduce((sum, s) => sum + (s.type === 'walk' ? s.distance : 0), 0));
    if (schedule && plan.departMinute !== undefined) {
      reannotatePlanSchedule(plan, schedule);
    } else {
      plan.totalTime = Math.round(plan.steps.reduce((sum, s) => sum + s.time, 0));
    }
  }
  sortJourneyPlans(plans, sortBy);
  return plans;
}
