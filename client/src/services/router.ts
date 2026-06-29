import { api } from './api';
import type { RouteListItem } from '../types/transmilenio';

export interface GraphEdge {
  to: string;
  routeCode: string;
  routeId: string;
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
  routeType?: 'troncal' | 'zonal' | 'cable';
  distance: number; // in meters
  time: number; // in minutes
  stopCount?: number;
  stops?: string[]; // Intermediate stop names (excluding boarding/alighting)
  path?: [number, number][]; // Coordinates for this leg
  isTunnel?: boolean;
}

export interface JourneyPlan {
  totalTime: number; // in minutes
  walkDistance: number; // in meters
  transfers: number;
  steps: JourneyStep[];
}

export interface RouteSearchParams {
  origin: [number, number];      // [lng, lat]
  destination: [number, number]; // [lng, lat]
  originStopCode?: string;
  destStopCode?: string;
  mode: 'mix' | 'troncal' | 'zonal';
  minWalk: boolean;
  sortBy?: 'transfers' | 'time' | 'walk';
}

// Global router state
let uniqueStops = new Map<string, RouteStop>();
let graphAdjacency = new Map<string, GraphEdge[]>();
let rawRoutesList: RouteListItem[] = [];
let rawCableStations: CableStationInput[] = [];

// TransMiCable: a single line of gondola stations. It connects to the rest of
// the network ONLY at Tunal ↔ Portal Tunal (the portal complex). Every other
// cable station is isolated — no walking transfers (rider must ride the cable).
const CABLE_ROUTE_CODE = 'Cable';
const CABLE_ROUTE_ID = 'cable-tmc';
const CABLE_TUNAL_CODE = '40000'; // cod_nodo of the Tunal cable station
const PORTAL_TUNAL_STATION_CODE = 'TM0119'; // troncal Portal Tunal node
// Gondola cruise speed incl. station dwell (~9 km/h effective end-to-end).
const CABLE_SPEED_M_PER_MINUTE = 150;
const CABLE_DWELL_MINUTES = 0.5;

const WALK_SPEED_M_PER_MINUTE = 75;
const WALK_TRANSFER_THRESHOLD_M = 320;
const MAX_WALK_NEIGHBORS = 4;
const ACCESS_SEARCH_RADIUS_M = 1500;
const ACCESS_CANDIDATE_LIMIT = 12;
const WALK_COST_WEIGHT = 20.0;
const MAX_TRANSFERS = 3;
const MIN_WALK_COST_WEIGHT = 50.0;
const TRANSFER_PENALTY_MINUTES = 8.0;
// Above this straight-line distance a walking-only itinerary is not realistic;
// prefer the "no routes found" state over an absurd multi-km walk suggestion.
const WALK_ONLY_FALLBACK_MAX_M = 2500;

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

/**
 * Initializes the routing graph from the loaded route list.
 */
export function initRouter(routes: RouteListItem[], cableStations?: CableStationInput[]): void {
  rawRoutesList = routes;
  if (cableStations) rawCableStations = cableStations;
  uniqueStops.clear();
  graphAdjacency.clear();

  console.log('[Router] Initializing graph builder...');

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

  // Initialize adjacency map for each unique stop
  for (const code of uniqueStops.keys()) {
    graphAdjacency.set(code, []);
  }

  // 2. Add Transit edges (A -> B for successive stops in routes)
  let transitEdgesCount = 0;
  for (const route of routes) {
    if (!route.stops || route.stops.length < 2) continue;

    for (let i = 0; i < route.stops.length - 1; i++) {
      const fromStop = route.stops[i];
      const toStop = route.stops[i + 1];
      if (!fromStop.codigo || !toStop.codigo) continue;

      const distance = getDistance(fromStop.coordinate, toStop.coordinate);
      
      // Travel times (effective speed accounts for traffic, track curvature, queueing):
      // Troncal: 15 km/h = 250.0 m/min. Dwell time: 60s (1.0m)
      // Zonal: 10 km/h = 166.7 m/min. Dwell time: 36s (0.6m)
      const speed = route.type === 'troncal' ? 250.0 : 166.7;
      const dwell = route.type === 'troncal' ? 1.0 : 0.6;
      const time = (distance / speed) + dwell;

      const edges = graphAdjacency.get(fromStop.codigo) || [];
      edges.push({
        to: toStop.codigo,
        routeCode: route.code,
        routeId: route.id,
        type: route.type,
        distance,
        time,
      });
      graphAdjacency.set(fromStop.codigo, edges);
      transitEdgesCount++;
    }
  }

  // 2b. Add TransMiCable ride edges between consecutive stations (both ways).
  // Boarding the cable after any bus counts as a transbordo (route code changes).
  for (let i = 0; i < cableLine.length - 1; i++) {
    const a = cableLine[i];
    const b = cableLine[i + 1];
    const distance = getDistance(a.coordinate, b.coordinate);
    const time = distance / CABLE_SPEED_M_PER_MINUTE + CABLE_DWELL_MINUTES;
    const edge = (from: string, to: string) => {
      const edges = graphAdjacency.get(from) || [];
      edges.push({ to, routeCode: CABLE_ROUTE_CODE, routeId: CABLE_ROUTE_ID, type: 'cable', distance, time });
      graphAdjacency.set(from, edges);
      transitEdgesCount++;
    };
    edge(a.codigo, b.codigo);
    edge(b.codigo, a.codigo);
  }

  // 3. Add short transfer walks. Station-to-station links are only verified tunnels.
  let walkingEdgesCount = 0;
  const stopsArray = Array.from(uniqueStops.values());

  const addWalkingEdge = (fromCode: string, toCode: string, distance: number): void => {
    const edges = graphAdjacency.get(fromCode) || [];
    if (edges.some((edge) => edge.type === 'walking' && edge.to === toCode)) return;
    edges.push({
      to: toCode,
      routeCode: 'walking',
      routeId: 'walking',
      type: 'walking',
      distance,
      time: distance / WALK_SPEED_M_PER_MINUTE,
    });
    graphAdjacency.set(fromCode, edges);
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

  for (let i = 0; i < stopsArray.length; i++) {
    const fromStop = stopsArray[i];
    const neighbors: { stopCode: string; distance: number }[] = [];

    for (let j = 0; j < stopsArray.length; j++) {
      if (i === j) continue;
      const toStop = stopsArray[j];
      if (!canCreateWalkingTransfer(fromStop, toStop)) continue;

      // Quick bounding box check before heavy math
      const dLat = Math.abs(toStop.coordinate[1] - fromStop.coordinate[1]);
      const dLon = Math.abs(toStop.coordinate[0] - fromStop.coordinate[0]);
      if (dLat > 0.0055 || dLon > 0.0055) continue; // ~600m bounding box threshold

      const distance = getDistance(fromStop.coordinate, toStop.coordinate);
      if (distance <= WALK_TRANSFER_THRESHOLD_M) {
        neighbors.push({ stopCode: toStop.codigo, distance });
      }
    }

    // Sort neighbors by distance and take nearest few to keep transfers sane.
    neighbors.sort((a, b) => a.distance - b.distance);
    neighbors.slice(0, MAX_WALK_NEIGHBORS).forEach((n) => addWalkingEdge(fromStop.codigo, n.stopCode, n.distance));
  }

  console.log(
    `[Router] Graph ready! Vertices: ${uniqueStops.size}, Transit Edges: ${transitEdgesCount}, Walking Edges: ${walkingEdgesCount}`
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
  nodeCode: string;
  routeCode: string; // The route we arrived on ("walking", "start", or transit route code)
  routeId: string;
  cost: number;
  time: number;
  walkDistance: number;
  transfers: number;
  parentKey: string | null;
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
 * Slice coordinates of a route variant between two stops.
 */
function sliceRouteGeometry(
  routeId: string,
  fromStopCode: string,
  toStopCode: string
): [number, number][] {
  const route = rawRoutesList.find((r) => r.id === routeId);
  const fromStop = uniqueStops.get(fromStopCode);
  const toStop = uniqueStops.get(toStopCode);

  if (!fromStop || !toStop) return [];

  const fallback: [number, number][] = [fromStop.coordinate, toStop.coordinate];

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
 * Collapses successive graph legs on the same route into a single Ride step.
 */
function buildJourneySteps(legs: RawLeg[], virtualStops?: Map<string, RouteStop>): JourneyStep[] {
  const steps: JourneyStep[] = [];
  if (legs.length === 0) return steps;

  let currentStep: JourneyStep | null = null;

  for (const leg of legs) {
    const fromStop = getStop(leg.fromNode, virtualStops);
    const toStop = getStop(leg.toNode, virtualStops);
    if (!fromStop || !toStop) continue;

    if (leg.type === 'walking') {
      // If there's an ongoing ride step, commit it
      if (currentStep) {
        steps.push(currentStep);
        currentStep = null;
      }
      
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
      });
    } else {
      // Transit leg
      if (currentStep && currentStep.type === 'ride' && currentStep.routeCode === leg.routeCode) {
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
        
        // Append sliced coordinates
        const slice = sliceRouteGeometry(leg.routeId, leg.fromNode, leg.toNode);
        if (currentStep.path && slice.length > 0) {
          // Avoid duplicating the connection point coordinate
          currentStep.path = currentStep.path.concat(slice.slice(1));
        }
      } else {
        // If there's an ongoing ride step, commit it
        if (currentStep) {
          steps.push(currentStep);
        }

        // Create new ride step
        const slice = sliceRouteGeometry(leg.routeId, leg.fromNode, leg.toNode);
        currentStep = {
          type: 'ride',
          fromName: fromStop.nombre,
          fromCode: fromStop.codigo,
          toName: toStop.nombre,
          toCode: toStop.codigo,
          routeCode: leg.routeCode,
          routeType: leg.type,
          distance: leg.distance,
          time: leg.time,
          stopCount: 1,
          stops: [], // Will populate if multiple stops are traversed
          path: slice,
        };
      }
    }
  }

  // Commit last step
  if (currentStep) {
    steps.push(currentStep);
  }

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

    const sourceMatches = Array.from(uniqueStops.values())
      .filter((stop) => stop.sourceCode === selectedCode && isStopCompatible(stop, mode));
    for (const stop of sourceMatches) {
      if (!seenCodes.has(stop.codigo)) {
        candidates.push({ nodeCode: stop.codigo, distance: getDistance(coordinate, stop.coordinate) });
        seenCodes.add(stop.codigo);
      }
    }
  }

  // If the user does NOT want to minimize walking, we allow walking up to 400m (1-2 mins) to alternative stops/stations.
  // This opens up direct or fewer-transfer routes.
  const alternativeStopsRadius = minWalk ? 0 : 400;

  const compatibleStops = Array.from(uniqueStops.values())
    .filter((stop) => isStopCompatible(stop, mode) && !seenCodes.has(stop.codigo))
    .map((stop) => ({ nodeCode: stop.codigo, distance: getDistance(coordinate, stop.coordinate) }));

  const searchRadius = selectedCode ? alternativeStopsRadius : ACCESS_SEARCH_RADIUS_M;
  const limit = selectedCode ? 6 : ACCESS_CANDIDATE_LIMIT;

  if (searchRadius > 0) {
    const nearby = compatibleStops
      .filter((candidate) => candidate.distance <= searchRadius)
      .sort((a, b) => a.distance - b.distance)
      .slice(0, limit);
    candidates.push(...nearby);
  }

  if (candidates.length > 0) {
    return candidates.sort((a, b) => a.distance - b.distance);
  }

  // Fallback to absolute closest if none nearby
  const sortedCompatible = compatibleStops.sort((a, b) => a.distance - b.distance);
  return sortedCompatible.slice(0, Math.min(5, ACCESS_CANDIDATE_LIMIT));
}

/**
 * Ranks journey plans in place by the chosen preference. Each criterion uses the
 * others as deterministic tie-breakers so the ordering is stable. Exported so the
 * async walking-geometry enrichment can re-rank with accurate distances/times
 * (the initial search ranks on straight-line estimates).
 */
export function sortJourneyPlans(plans: JourneyPlan[], sortBy?: 'transfers' | 'time' | 'walk'): void {
  const sortCriteria = sortBy || 'transfers';
  plans.sort((a, b) => {
    if (sortCriteria === 'transfers') {
      return a.transfers - b.transfers || a.totalTime - b.totalTime || a.walkDistance - b.walkDistance;
    } else if (sortCriteria === 'time') {
      return a.totalTime - b.totalTime || a.transfers - b.transfers || a.walkDistance - b.walkDistance;
    }
    // 'walk'
    return a.walkDistance - b.walkDistance || a.totalTime - b.totalTime || a.transfers - b.transfers;
  });
}

function findRoutesCore(params: RouteSearchParams): JourneyPlan[] {
  const { origin, destination, originStopCode, destStopCode, mode, minWalk, sortBy } = params;

  // 1. Identify starting nodes
  const startNodes = findAccessNodes(origin, mode, originStopCode, minWalk);
  if (startNodes.length === 0) return [];

  // 2. Identify destination nodes
  const destNodes = new Map<string, number>(); // nodeCode -> walkDistance
  findAccessNodes(destination, mode, destStopCode, minWalk).forEach((node) => destNodes.set(node.nodeCode, node.distance));
  if (destNodes.size === 0) return [];

  // 3. Multi-criteria Dijkstra
  const queue = new MinHeap<DijkstraState>();
  const bestCosts = new Map<string, number>();
  const stateRegistry = new Map<string, DijkstraState>();
  const makeKey = (nodeCode: string, routeCode: string, routeId: string) => `${nodeCode}|${routeCode}|${routeId}`;

  const walkWeight = minWalk ? MIN_WALK_COST_WEIGHT : WALK_COST_WEIGHT;

  // Push starting states
  for (const start of startNodes) {
    const walkTime = start.distance / WALK_SPEED_M_PER_MINUTE;
    const cost = walkTime * walkWeight;
    const state: DijkstraState = {
      nodeCode: start.nodeCode,
      routeCode: 'start',
      routeId: 'start',
      cost,
      time: walkTime,
      walkDistance: start.distance,
      transfers: 0,
      parentKey: null,
      hasRidden: false,
    };
    
    const key = makeKey(start.nodeCode, 'start', 'start');
    bestCosts.set(key, cost);
    stateRegistry.set(key, state);
    queue.push(state, cost);
  }

  const results: DijkstraState[] = [];
  // Collect more terminal candidates than we ultimately show. The Dijkstra
  // cost does NOT include the egress (destination) walk, so the first arrival
  // is not necessarily the best end-to-end trip — a slightly costlier transit
  // path that alights closer to the destination can win once the egress walk
  // is added. We gather several arrivals and re-rank by true total time below.
  const TERMINAL_CANDIDATE_CAP = 12;
  // Hard ceiling on node expansions so an unreachable destination (or a huge
  // graph) can never blow past the sub-100ms search budget (spec §1 perf).
  const MAX_NODE_POPS = 60000;
  let nodePops = 0;
  const transferPenalty = TRANSFER_PENALTY_MINUTES;

  while (!queue.isEmpty()) {
    if (++nodePops > MAX_NODE_POPS) break;
    const current = queue.pop()!;
    const currentKey = makeKey(current.nodeCode, current.routeCode, current.routeId);

    const bestCost = bestCosts.get(currentKey);
    if (bestCost !== undefined && current.cost > bestCost) continue;

    if (destNodes.has(current.nodeCode)) {
      results.push(current);
      if (results.length >= TERMINAL_CANDIDATE_CAP) break;
    }

    const edges = graphAdjacency.get(current.nodeCode) || [];
    for (const edge of edges) {
      if (edge.type === 'troncal' && mode === 'zonal') continue;
      if (edge.type === 'zonal' && mode === 'troncal') continue;
      // TransMiCable is its own system — only offered in the mixed mode.
      if (edge.type === 'cable' && mode !== 'mix') continue;

      // CRITICAL: Troncal routes can ONLY be boarded/alighted at stations.
      // A paradero (zonal stop) cannot physically serve troncal buses.
      if (edge.type === 'troncal') {
        const fromNode = uniqueStops.get(current.nodeCode);
        const toNode = uniqueStops.get(edge.to);
        if (fromNode && fromNode.kind !== 'station') continue;
        if (toNode && toNode.kind !== 'station') continue;
      }

      let edgeTime = edge.time;
      let edgeCost = edge.time;
      let isTransfer = false;

      if (edge.type === 'walking') {
        const fromStop = uniqueStops.get(current.nodeCode);
        const toStop = uniqueStops.get(edge.to);
        const isTunnel = fromStop && toStop && fromStop.kind === 'station' && toStop.kind === 'station' && hasTunnelConnection(fromStop, toStop);
        
        if (!isTunnel && (current.routeCode === 'start' || current.routeCode === 'walking')) {
          continue;
        }

        if (isTunnel) {
          edgeCost = edgeTime * 1.5;
        } else {
          edgeCost = edgeTime * walkWeight;
        }
      } else {
        if (current.hasRidden && current.routeCode !== edge.routeCode) {
          // Hard cap on transfers — prevent absurd multi-transfer routes
          if (current.transfers >= MAX_TRANSFERS) continue;
          edgeCost += transferPenalty;
          isTransfer = true;
        }
      }

      const nextCost = current.cost + edgeCost;
      const nextTime = current.time + edgeTime;
      const nextWalkDistance = current.walkDistance + (edge.type === 'walking' ? edge.distance : 0);
      const nextTransfers = current.transfers + (isTransfer ? 1 : 0);

      const nextRouteCode = edge.type === 'walking' ? 'walking' : edge.routeCode;
      const nextRouteId = edge.type === 'walking' ? 'walking' : edge.routeId;
      const nextKey = makeKey(edge.to, nextRouteCode, nextRouteId);
      const prevBest = bestCosts.get(nextKey);

      if (prevBest === undefined || nextCost < prevBest) {
        bestCosts.set(nextKey, nextCost);
        const nextState: DijkstraState = {
          nodeCode: edge.to,
          routeCode: nextRouteCode,
          routeId: nextRouteId,
          cost: nextCost,
          time: nextTime,
          walkDistance: nextWalkDistance,
          transfers: nextTransfers,
          parentKey: currentKey,
          hasRidden: current.hasRidden || (edge.type !== 'walking'),
        };
        stateRegistry.set(nextKey, nextState);
        queue.push(nextState, nextCost);
      }
    }
  }

  // 4. Reconstruct paths and map to JourneyPlan structures
  const plans: JourneyPlan[] = [];

  for (const targetState of results) {
    const legs: RawLeg[] = [];
    const virtualStops = new Map<string, RouteStop>();
    let state = targetState;

    const destWalkDist = destNodes.get(state.nodeCode) || 0;
    if (destWalkDist > 0) {
      const destStop = uniqueStops.get(state.nodeCode)!;
      legs.push({
        fromNode: state.nodeCode,
        toNode: 'END',
        routeCode: 'walking',
        routeId: 'walking',
        type: 'walking',
        distance: destWalkDist,
        time: destWalkDist / WALK_SPEED_M_PER_MINUTE,
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

      const edges = graphAdjacency.get(parent.nodeCode) || [];
      let edge = edges.find((e) => {
        const edgeRouteCode = e.type === 'walking' ? 'walking' : e.routeCode;
        const edgeRouteId = e.type === 'walking' ? 'walking' : e.routeId;
        return e.to === state.nodeCode && edgeRouteCode === state.routeCode && edgeRouteId === state.routeId;
      });

      if (!edge && edges.length > 0) {
        edge = edges.find((e) => e.to === state.nodeCode);
      }

      if (edge) {
        legs.unshift({
          fromNode: parent.nodeCode,
          toNode: state.nodeCode,
          routeCode: edge.routeCode,
          routeId: edge.routeId,
          type: edge.type,
          distance: edge.distance,
          time: edge.time,
        });
      }

      state = parent;
    }

    const startState = state;
    const startNodeCode = startState.nodeCode;
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

    const totalTime = legs.reduce((sum, leg) => sum + leg.time, 0);
    const totalWalkDistance = legs.reduce((sum, leg) => sum + (leg.type === 'walking' ? leg.distance : 0), 0);
    const transfers = targetState.transfers;
    const journeySteps = buildJourneySteps(legs, virtualStops);

    plans.push({
      totalTime: Math.round(totalTime),
      walkDistance: Math.round(totalWalkDistance),
      transfers,
      steps: journeySteps,
    });
  }

  // Deduplicate, validate, and filter plans
  const finalPlans: JourneyPlan[] = [];
  const seenRouteKeys = new Set<string>();

  for (const plan of plans) {
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

  // Show at most 3 distinct options (we over-collected terminals for ranking).
  return finalPlans.slice(0, 3);
}

function createWalkingFallbackPlan(origin: [number, number], destination: [number, number]): JourneyPlan {
  const distance = getDistance(origin, destination);
  const time = distance / WALK_SPEED_M_PER_MINUTE;
  return {
    totalTime: Math.round(time),
    walkDistance: Math.round(distance),
    transfers: 0,
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
      },
    ],
  };
}

export function findRoutes(params: RouteSearchParams): JourneyPlan[] {
  const { origin, destination, mode } = params;

  if (uniqueStops.size === 0) {
    console.warn('[Router] Graph is empty. Initializing router with rawRoutesList.');
    initRouter(rawRoutesList);
  }

  console.log(`[Router] Routing request. Mode: ${mode}`);

  // 1. Primary search
  let plans = findRoutesCore(params);

  // 2. Fallback to walking-only plan if no transit exists under the selected
  // filter — but only when the destination is actually walkable. Beyond that a
  // straight "walk 8 km / 100 min" plan is misleading, so return nothing and
  // let the UI show the honest "no routes" state.
  if (plans.length === 0) {
    const directWalk = getDistance(origin, destination);
    if (directWalk <= WALK_ONLY_FALLBACK_MAX_M) {
      console.log('[Router] No transit routes found. Falling back to walking-only plan.');
      plans = [createWalkingFallbackPlan(origin, destination)];
    } else {
      console.log('[Router] No transit routes found and destination too far to walk.');
    }
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
    time: distance / 75,
  };
}

export function getGraphAdjacency() {
  return graphAdjacency;
}

export function isTunnelTransfer(fromCode: string, toCode: string): boolean {
  const fromStop = uniqueStops.get(fromCode);
  const toStop = uniqueStops.get(toCode);
  return !!(fromStop && toStop && fromStop.kind === 'station' && toStop.kind === 'station' && hasTunnelConnection(fromStop, toStop));
}
