import type { RouteListItem } from '../types/transmilenio';

export interface GraphEdge {
  to: string;
  routeCode: string;
  routeId: string;
  type: 'troncal' | 'zonal' | 'walking';
  distance: number;
  time: number;
}

export interface RouteStop {
  nombre: string;
  codigo: string;
  coordinate: [number, number];
  kind: 'station' | 'stop';
  direccion?: string;
}

export interface JourneyStep {
  type: 'walk' | 'ride';
  fromName: string;
  fromCode: string;
  toName: string;
  toCode: string;
  routeCode?: string;
  routeType?: 'troncal' | 'zonal';
  distance: number; // in meters
  time: number; // in minutes
  stopCount?: number;
  stops?: string[]; // Intermediate stop names (excluding boarding/alighting)
  path?: [number, number][]; // Coordinates for this leg
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
}

// Global router state
let uniqueStops = new Map<string, RouteStop>();
let graphAdjacency = new Map<string, GraphEdge[]>();
let rawRoutesList: RouteListItem[] = [];

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
export function initRouter(routes: RouteListItem[]): void {
  rawRoutesList = routes;
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
      }
    }
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
      
      // Travel times: 
      // Troncal: 25 km/h = 416.7 m/min. Dwell time: 30s (0.5m)
      // Zonal: 15 km/h = 250.0 m/min. Dwell time: 18s (0.3m)
      const speed = route.type === 'troncal' ? 416.7 : 250.0;
      const dwell = route.type === 'troncal' ? 0.5 : 0.3;
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

  // 3. Add Walking edges between nearby stops (distance <= 250m)
  // Limit to top 5 closest neighbors per stop to avoid dense graph bloating
  let walkingEdgesCount = 0;
  const stopsArray = Array.from(uniqueStops.values());
  const walkThreshold = 250; // meters
  const walkSpeed = 75; // meters/minute (4.5 km/h)

  for (let i = 0; i < stopsArray.length; i++) {
    const fromStop = stopsArray[i];
    const neighbors: { stopCode: string; distance: number }[] = [];

    for (let j = 0; j < stopsArray.length; j++) {
      if (i === j) continue;
      const toStop = stopsArray[j];

      // Quick bounding box check before heavy math
      const dLat = Math.abs(toStop.coordinate[1] - fromStop.coordinate[1]);
      const dLon = Math.abs(toStop.coordinate[0] - fromStop.coordinate[0]);
      if (dLat > 0.0035 || dLon > 0.0035) continue; // ~350m bounding box threshold

      const distance = getDistance(fromStop.coordinate, toStop.coordinate);
      if (distance <= walkThreshold) {
        neighbors.push({ stopCode: toStop.codigo, distance });
      }
    }

    // Sort neighbors by distance and take top 5
    neighbors.sort((a, b) => a.distance - b.distance);
    const closest = neighbors.slice(0, 5);

    const edges = graphAdjacency.get(fromStop.codigo) || [];
    for (const n of closest) {
      edges.push({
        to: n.stopCode,
        routeCode: 'walking',
        routeId: 'walking',
        type: 'walking',
        distance: n.distance,
        time: n.distance / walkSpeed,
      });
      walkingEdgesCount++;
    }
    graphAdjacency.set(fromStop.codigo, edges);
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
}

interface RawLeg {
  fromNode: string;
  toNode: string;
  routeCode: string;
  routeId: string;
  type: 'troncal' | 'zonal' | 'walking';
  distance: number;
  time: number;
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

  // Flatten all paths in the multi-line string
  const allCoords = route.geometry.paths.flat() as [number, number][];
  if (allCoords.length === 0) return fallback;

  // Find index in coordinates closest to the origin and destination stops
  let idxA = 0;
  let idxB = 0;
  let minDistA = Infinity;
  let minDistB = Infinity;

  for (let i = 0; i < allCoords.length; i++) {
    const coord = allCoords[i];
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

  // Slice coordinate sequence
  if (idxA <= idxB) {
    const sliced = allCoords.slice(idxA, idxB + 1);
    return sliced.length >= 2 ? sliced : fallback;
  } else {
    const sliced = allCoords.slice(idxB, idxA + 1).reverse();
    return sliced.length >= 2 ? sliced : fallback;
  }
}

/**
 * Collapses successive graph legs on the same route into a single Ride step.
 */
function buildJourneySteps(legs: RawLeg[]): JourneyStep[] {
  const steps: JourneyStep[] = [];
  if (legs.length === 0) return steps;

  let currentStep: JourneyStep | null = null;

  for (const leg of legs) {
    const fromStop = uniqueStops.get(leg.fromNode);
    const toStop = uniqueStops.get(leg.toNode);
    if (!fromStop || !toStop) continue;

    if (leg.type === 'walking') {
      // If there's an ongoing ride step, commit it
      if (currentStep) {
        steps.push(currentStep);
        currentStep = null;
      }
      
      // Add Walk step
      steps.push({
        type: 'walk',
        fromName: fromStop.nombre,
        fromCode: fromStop.codigo,
        toName: toStop.nombre,
        toCode: toStop.codigo,
        distance: leg.distance,
        time: leg.time,
        path: [fromStop.coordinate, toStop.coordinate],
      });
    } else {
      // Transit leg
      if (currentStep && currentStep.type === 'ride' && currentStep.routeCode === leg.routeCode) {
        // Extend existing ride step
        currentStep.toName = toStop.nombre;
        currentStep.toCode = toStop.codigo;
        currentStep.distance += leg.distance;
        currentStep.time += leg.time;
        if (currentStep.stopCount !== undefined) currentStep.stopCount++;
        if (currentStep.stops && currentStep.stops.length > 0) {
          // Add old destination as intermediate stop
          const lastIndex = currentStep.stops.length - 1;
          // Only add if not already in the list
          currentStep.stops.splice(lastIndex, 0, fromStop.nombre);
        }
        
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
export function findRoutes(params: RouteSearchParams): JourneyPlan[] {
  const { origin, destination, originStopCode, destStopCode, mode, minWalk } = params;

  if (uniqueStops.size === 0) {
    console.warn('[Router] Graph is empty. Initializing router with rawRoutesList.');
    initRouter(rawRoutesList);
  }

  console.log(`[Router] Routing request. Mode: ${mode}, minWalk: ${minWalk}`);

  // 1. Identify starting nodes
  const startNodes: { nodeCode: string; distance: number }[] = [];
  if (originStopCode && uniqueStops.has(originStopCode)) {
    startNodes.push({ nodeCode: originStopCode, distance: 0 });
  } else {
    // Find stops within radius of origin coordinate
    const radius = 800; // meters
    for (const stop of uniqueStops.values()) {
      const distance = getDistance(origin, stop.coordinate);
      if (distance <= radius) {
        startNodes.push({ nodeCode: stop.codigo, distance });
      }
    }
    // If none within 800m, take the 3 closest stops
    if (startNodes.length === 0) {
      const sorted = Array.from(uniqueStops.values())
        .map((s) => ({ s, d: getDistance(origin, s.coordinate) }))
        .sort((a, b) => a.d - b.d)
        .slice(0, 3);
      sorted.forEach((item) => {
        startNodes.push({ nodeCode: item.s.codigo, distance: item.d });
      });
    }
  }

  // 2. Identify destination nodes
  const destNodes = new Map<string, number>(); // nodeCode -> walkDistance to destination
  if (destStopCode && uniqueStops.has(destStopCode)) {
    destNodes.set(destStopCode, 0);
  } else {
    const radius = 800; // meters
    for (const stop of uniqueStops.values()) {
      const distance = getDistance(destination, stop.coordinate);
      if (distance <= radius) {
        destNodes.set(stop.codigo, distance);
      }
    }
    // If none within 800m, take the 3 closest stops
    if (destNodes.size === 0) {
      const sorted = Array.from(uniqueStops.values())
        .map((s) => ({ s, d: getDistance(destination, s.coordinate) }))
        .sort((a, b) => a.d - b.d)
        .slice(0, 3);
      sorted.forEach((item) => {
        destNodes.set(item.s.codigo, item.d);
      });
    }
  }

  // 3. Multi-criteria Dijkstra
  const queue = new MinHeap<DijkstraState>();
  
  // Track visited states. Key format: "nodeCode|routeCode" -> cost
  const bestCosts = new Map<string, number>();

  // Track parent pointer to rebuild paths. Key format: "nodeCode|routeCode" -> DijkstraState
  const stateRegistry = new Map<string, DijkstraState>();

  // Helper to make key
  const makeKey = (nodeCode: string, routeCode: string) => `${nodeCode}|${routeCode}`;

  const walkSpeed = 75; // meters/minute
  const walkWeight = minWalk ? 15.0 : 1.5; // Heavily penalize walking if minWalk is enabled

  // Push starting states
  for (const start of startNodes) {
    const walkTime = start.distance / walkSpeed;
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
    };
    
    const key = makeKey(start.nodeCode, 'start');
    bestCosts.set(key, cost);
    stateRegistry.set(key, state);
    queue.push(state, cost);
  }

  const results: DijkstraState[] = [];
  const maxRoutesCount = 3;
  const transferPenalty = 8.0; // minutes penalty per transfer

  while (!queue.isEmpty()) {
    const current = queue.pop()!;
    const currentKey = makeKey(current.nodeCode, current.routeCode);

    // If we've found a better path to this exact state already, skip
    const bestCost = bestCosts.get(currentKey);
    if (bestCost !== undefined && current.cost > bestCost) continue;

    // Check if we reached a destination node
    if (destNodes.has(current.nodeCode)) {
      results.push(current);
      if (results.length >= maxRoutesCount) break;
    }

    const edges = graphAdjacency.get(current.nodeCode) || [];
    for (const edge of edges) {
      // Filter by transport mode preference
      if (edge.type === 'troncal' && mode === 'zonal') continue;
      if (edge.type === 'zonal' && mode === 'troncal') continue;

      let edgeTime = edge.time;
      let edgeCost = edge.time;
      let isTransfer = false;

      if (edge.type === 'walking') {
        // Walking edge
        edgeCost = edgeTime * walkWeight;
      } else {
        // Transit edge
        // Check for transfer penalty (route switch)
        if (current.routeCode !== 'start' && current.routeCode !== edge.routeCode) {
          edgeCost += transferPenalty;
          isTransfer = true;
        }
      }

      const nextCost = current.cost + edgeCost;
      const nextTime = current.time + edgeTime;
      const nextWalkDistance = current.walkDistance + (edge.type === 'walking' ? edge.distance : 0);
      const nextTransfers = current.transfers + (isTransfer ? 1 : 0);

      const nextKey = makeKey(edge.to, edge.type === 'walking' ? 'walking' : edge.routeCode);
      const prevBest = bestCosts.get(nextKey);

      if (prevBest === undefined || nextCost < prevBest) {
        bestCosts.set(nextKey, nextCost);
        const nextState: DijkstraState = {
          nodeCode: edge.to,
          routeCode: edge.type === 'walking' ? 'walking' : edge.routeCode,
          routeId: edge.type === 'walking' ? 'walking' : edge.routeId,
          cost: nextCost,
          time: nextTime,
          walkDistance: nextWalkDistance,
          transfers: nextTransfers,
          parentKey: currentKey,
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
    let state = targetState;

    // Connect from the final stop to the actual destination coordinates
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
        time: destWalkDist / walkSpeed,
      });
      
      // Inject virtual END node metadata to uniqueStops temporarily for path build
      uniqueStops.set('END', {
        nombre: 'Destino',
        codigo: 'END',
        coordinate: destination,
        kind: 'stop',
      });
    }

    // Trace parents backwards
    while (state.parentKey !== null) {
      const parent = stateRegistry.get(state.parentKey);
      if (!parent) break;

      // Deduce the edge between parent.nodeCode and state.nodeCode
      const edges = graphAdjacency.get(parent.nodeCode) || [];
      
      // Find the edge that matches this transit/walking transition
      let edge = edges.find((e) => {
        const edgeRouteCode = e.type === 'walking' ? 'walking' : e.routeCode;
        return e.to === state.nodeCode && edgeRouteCode === state.routeCode;
      });

      // Fallback in case graph topology varies (shouldn't happen)
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

    // Connect from origin coordinates to first stop
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
        time: startWalk.distance / walkSpeed,
      });

      // Inject virtual START node metadata to uniqueStops temporarily
      uniqueStops.set('START', {
        nombre: 'Origen',
        codigo: 'START',
        coordinate: origin,
        kind: 'stop',
      });
    }

    // Compute total walk distance and total time
    const totalTime = legs.reduce((sum, leg) => sum + leg.time, 0);
    const totalWalkDistance = legs.reduce((sum, leg) => sum + (leg.type === 'walking' ? leg.distance : 0), 0);
    const transfers = targetState.transfers;

    const journeySteps = buildJourneySteps(legs);

    plans.push({
      totalTime: Math.round(totalTime),
      walkDistance: Math.round(totalWalkDistance),
      transfers,
      steps: journeySteps,
    });
  }

  // Deduplicate and filter plans (e.g. discard identical route combinations)
  const finalPlans: JourneyPlan[] = [];
  const seenRouteKeys = new Set<string>();

  for (const plan of plans) {
    const routeKey = plan.steps
      .filter((s) => s.type === 'ride')
      .map((s) => `${s.routeCode}|${s.fromCode}|${s.toCode}`)
      .join(' -> ');
    
    if (!seenRouteKeys.has(routeKey) && plan.steps.length > 0) {
      seenRouteKeys.add(routeKey);
      finalPlans.push(plan);
    }
  }

  return finalPlans;
}
