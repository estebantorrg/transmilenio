/**
 * Troncal station and wagon layers.
 */

import maplibregl from 'maplibre-gl';
import * as turf from '@turf/turf';
import type { TroncalRouteFeature, TroncalStationFeature, TroncalWagonFeature } from '../types/transmilenio';
import { getTroncalColor, markClickHandled, normalizeRouteCode } from './routes';
import { showPopup } from './popup';
import { escapeHTML, safeColor } from '../utils/html';

const STATION_LAYERS = [
  'wagons-fill',
  'wagons-line',
  'wagons-route-labels',
  'stations-glow',
  'stations-circle',
  'stations-hitbox',
  'stations-labels',
];

const UNUSED_TRONCAL_STATIONS = new Set([
  'ISLANDIA',
  'LOS LAURELES',
  'TIBANICA - PRIMAVERA',
  'TIBANICA PRIMAVERA',
]);

const ROUTE_TO_WAGON_DISTANCE_METERS = 34;
const ROUTE_TO_STATION_DISTANCE_METERS = 75;
const ROUTE_DIRECTION_TOLERANCE_DEGREES = 80;
const WAGON_LABEL_OFFSET_METERS = 30;

function buildSyntheticPolygon(anchorCenter: Coordinate, synthCfg: any): Coordinate[][] {
  const { length, width, distanceOffset, bearingOffset, baseBearing } = synthCfg;
  const bearing = baseBearing !== undefined ? baseBearing : 12;
  
  const ptCenter = turf.destination(turf.point(anchorCenter), distanceOffset, bearing + bearingOffset, { units: 'meters' });
  
  const ptF = turf.destination(ptCenter, length / 2, bearing, { units: 'meters' });
  const ptB = turf.destination(ptCenter, length / 2, bearing - 180, { units: 'meters' });
  
  const p1 = turf.destination(ptF, width / 2, bearing - 90, { units: 'meters' }).geometry.coordinates;
  const p2 = turf.destination(ptF, width / 2, bearing + 90, { units: 'meters' }).geometry.coordinates;
  const p3 = turf.destination(ptB, width / 2, bearing + 90, { units: 'meters' }).geometry.coordinates;
  const p4 = turf.destination(ptB, width / 2, bearing - 90, { units: 'meters' }).geometry.coordinates;
  
  return [[p1, p2, p3, p4, p1]] as Coordinate[][];
}

type PolygonFeature = GeoJSON.Feature<GeoJSON.Polygon>;

type Coordinate = [number, number];

type WagonDirection = {
  label: string;
  bearing: number;
};

type WagonMeta = {
  center: GeoJSON.Feature<GeoJSON.Point>;
  centerCoord: Coordinate;
  bearing: number;
  readableBearing: number;
  direction: WagonDirection | null;
};

type WagonProperties = {
  id: number;
  stationId: number;
  stationKey: string;
  stationName: string;
  rawName: string;
  displayName: string;
  directionLabel: string;
  routes: string;
};

type WagonFeature = GeoJSON.Feature<GeoJSON.Polygon, WagonProperties>;

type WagonCandidate = {
  feature: WagonFeature;
  meta: WagonMeta;
  routes: Set<string>;
  routesSide1?: Set<string>;
  routesSide2?: Set<string>;
};

type RouteObservation = {
  code: string;
  offset: number;
};

type WagonLabelFeature = GeoJSON.Feature<
  GeoJSON.Point,
  {
    label: string;
    bearing: number;
  }
>;

function normalizeName(value: string | null | undefined): string {
  return (value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .replace(/\s+/g, ' ')
    .toUpperCase();
}

export function isVisibleTroncalStation(station: TroncalStationFeature): boolean {
  return !UNUSED_TRONCAL_STATIONS.has(normalizeName(station.attributes.nombre_estacion));
}

function formatRouteTags(routes: string[], limit = 28): string {
  const visibleRoutes = routes.slice(0, limit);
  const hiddenCount = routes.length - visibleRoutes.length;
  const tags = visibleRoutes
    .map((route) => {
      const color = safeColor(getTroncalColor(route), '#FB2C17');
      return `<span class="route-tag" style="background:${color};">${escapeHTML(route)}</span>`;
    })
    .join('');

  return hiddenCount > 0
    ? `${tags}<span class="route-tag muted">+${hiddenCount}</span>`
    : tags;
}

function shortRouteList(routes: string[], limit = 7): string {
  if (routes.length === 0) return 'Sin rutas';
  const visible = routes.slice(0, limit).join(' ');
  return routes.length > limit ? `${visible} +${routes.length - limit}` : visible;
}

function sortRoutes(routes: Iterable<string>): string[] {
  return Array.from(routes).sort((a, b) =>
    normalizeRouteCode(a).localeCompare(normalizeRouteCode(b), undefined, { numeric: true })
  );
}

function normalizeBearing(bearing: number): number {
  return (bearing + 360) % 360;
}

function bearingDifference(a: number, b: number): number {
  return Math.abs(((normalizeBearing(a) - normalizeBearing(b) + 540) % 360) - 180);
}

function bearingAxisDifference(a: number, b: number): number {
  return Math.min(bearingDifference(a, b), bearingDifference(a, normalizeBearing(b + 180)));
}

function isNearFast(a: Coordinate, b: Coordinate, maxDistSq: number): boolean {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  return dx * dx + dy * dy <= maxDistSq;
}

function readableMapBearing(bearing: number): number {
  const normalized = normalizeBearing(bearing);
  return normalized > 90 && normalized < 270 ? normalizeBearing(normalized + 180) : normalized;
}

function getLongestEdgeBearing(polygon: GeoJSON.Feature<GeoJSON.Polygon>): number {
  const ring = polygon.geometry.coordinates[0] as Coordinate[] | undefined;
  if (!ring || ring.length < 2) return 0;

  let longestDistance = 0;
  let bearing = 0;

  for (let i = 1; i < ring.length; i += 1) {
    const start = ring[i - 1];
    const end = ring[i];
    const distance = turf.distance(start, end, { units: 'meters' });
    if (distance > longestDistance) {
      longestDistance = distance;
      bearing = turf.bearing(start, end);
    }
  }

  return normalizeBearing(bearing);
}

function parseDirection(...values: Array<string | null | undefined>): WagonDirection | null {
  const directionBearings: Record<string, number> = {
    'N-S': 180,
    'S-N': 0,
    'W-E': 90,
    'E-W': 270,
    'O-E': 90,
    'E-O': 270,
  };

  for (const value of values) {
    const normalized = normalizeName(value).replace(/\s+/g, '');
    const match = normalized.match(/(N-S|S-N|W-E|E-W|O-E|E-O)/);
    if (match) {
      const label = match[1].replace('O', 'W');
      return { label, bearing: directionBearings[match[1]] };
    }
  }

  return null;
}

function getDirectionCandidates(...values: Array<string | null | undefined>): WagonDirection[] {
  const candidates: WagonDirection[] = [];

  values.forEach((value) => {
    const direction = parseDirection(value);
    if (direction && !candidates.some((candidate) => candidate.label === direction.label)) {
      candidates.push(direction);
    }
  });

  return candidates;
}

function pickDirectionForBearing(
  bearing: number,
  ...values: Array<string | null | undefined>
): WagonDirection | null {
  const candidates = getDirectionCandidates(...values);
  if (candidates.length === 0) return null;

  return candidates.sort(
    (a, b) => bearingAxisDifference(bearing, a.bearing) - bearingAxisDifference(bearing, b.bearing)
  )[0];
}

function isActiveWagon(wagon: TroncalWagonFeature): boolean {
  const attrs = wagon.attributes;
  const name = normalizeName(attrs.nombre);
  const type = normalizeName(attrs.tipo);
  const section = normalizeName(attrs.secciontipo);
  const station = normalizeName(attrs.estacion);

  // Handle Terminal station specifically as its database tags are inconsistent
  if (station === 'TERMINAL') {
    // Exclude the pedestrian bridge (tagged as Conexion)
    if (section.includes('CONEX') || type.includes('CONEX')) return false;
    return name.includes('VAGON') || name.includes('TRANSICION') || section === 'VAGON';
  }


  // General logic for other stations
  const isVagon = name.includes('VAGON') || type.includes('VAGON') || section === 'VAGON';
  if (!isVagon) return false;

  // We exclude clear non-passenger areas, but we are lenient if it's explicitly labeled as a vagon in some way
  const isExclusion = /(CONEX|CONEXION|CONEXA|PLATAFORMA|ENTRADA)/.test(`${name} ${type}`);
  if (isExclusion && !name.includes('VAGON')) return false;

  // General exclusion for transitions unless they are explicitly tagged as wagons
  if (name.includes('TRANSIC') && !name.includes('VAGON') && !type.includes('VAGON')) return false;

  return true;
}

function getStationKey(wagon: TroncalWagonFeature): string {
  const stationId = Number(wagon.attributes.idestacion ?? 0);
  return stationId > 0
    ? `id:${stationId}`
    : `name:${normalizeName(wagon.attributes.estacion)}`;
}

function extractWagonNumber(name: string): number | null {
  const match = normalizeName(name).match(/\bVAGON\s+(\d+)\b/);
  return match ? Number(match[1]) : null;
}

function cleanWagonDisplayName(rawName: string, fallbackNumber: number): string {
  const number = extractWagonNumber(rawName) ?? fallbackNumber;
  return `Vagon ${number}`;
}

function getWagonMeta(feature: WagonFeature, source: TroncalWagonFeature): WagonMeta {
  const polygon = turf.polygon(feature.geometry.coordinates);
  const center = turf.centerOfMass(polygon);
  const bearing = getLongestEdgeBearing(polygon);

  return {
    center,
    centerCoord: center.geometry.coordinates as Coordinate,
    bearing,
    readableBearing: readableMapBearing(bearing),
    direction: pickDirectionForBearing(bearing, source.attributes.nombre, source.attributes.tipo),
  };
}

function makeWagonFeature(wagon: TroncalWagonFeature, ordinal: number): WagonFeature {
  const displayName = cleanWagonDisplayName(wagon.attributes.nombre, ordinal);

  return {
    type: 'Feature',
    properties: {
      id: wagon.attributes.objectid,
      stationId: Number(wagon.attributes.idestacion ?? 0),
      stationKey: getStationKey(wagon),
      stationName: wagon.attributes.estacion,
      rawName: wagon.attributes.nombre,
      displayName,
      directionLabel: '',
      routes: '[]',
    },
    geometry: {
      type: 'Polygon',
      coordinates: wagon.geometry.rings.map((ring) => [...ring].reverse()),
    },
  };
}

function getStationLocalOrdinals(wagons: TroncalWagonFeature[]): Map<number, number> {
  const ordinals = new Map<number, number>();
  const groups = new Map<string, TroncalWagonFeature[]>();

  wagons.forEach((wagon) => {
    const key = getStationKey(wagon);
    groups.set(key, [...(groups.get(key) ?? []), wagon]);
  });

  groups.forEach((group) => {
    const explicitNumbers = group.map((wagon) => extractWagonNumber(wagon.attributes.nombre));
    const uniqueExplicitNumbers = new Set(explicitNumbers.filter((number): number is number => number !== null));
    const canUseExplicitNumbers = explicitNumbers.every((number) => number !== null)
      && uniqueExplicitNumbers.size === group.length;

    if (canUseExplicitNumbers) {
      group.forEach((wagon, index) => {
        ordinals.set(wagon.attributes.objectid, explicitNumbers[index] ?? index + 1);
      });
      return;
    }

    const sorted = [...group].sort((a, b) => {
      const aCenter = turf.centerOfMass(turf.polygon(a.geometry.rings.map((ring) => [...ring].reverse()))).geometry.coordinates;
      const bCenter = turf.centerOfMass(turf.polygon(b.geometry.rings.map((ring) => [...ring].reverse()))).geometry.coordinates;
      const lngDiff = aCenter[0] - bCenter[0];
      return Math.abs(lngDiff) > 0.00001
        ? lngDiff
        : aCenter[1] - bCenter[1];
    });

    sorted.forEach((wagon, index) => {
      ordinals.set(wagon.attributes.objectid, index + 1);
    });
  });

  return ordinals;
}

function getRouteSegmentCandidate(
  wagon: WagonCandidate,
  start: Coordinate,
  end: Coordinate,
  useDeclaredDirection: boolean
): { distance: number; score: number } | null {
  const line = turf.lineString([start, end]);
  const distance = turf.pointToLineDistance(wagon.meta.center, line, { units: 'meters' });
  if (distance > ROUTE_TO_WAGON_DISTANCE_METERS) return null;

  const segmentBearing = normalizeBearing(turf.bearing(start, end));
  const directionBearing = useDeclaredDirection ? wagon.meta.direction?.bearing : undefined;
  const directionDifference = directionBearing === undefined
    ? bearingDifference(segmentBearing, wagon.meta.bearing)
    : bearingDifference(segmentBearing, directionBearing);

  if (directionBearing !== undefined && directionDifference > ROUTE_DIRECTION_TOLERANCE_DEGREES) {
    return null;
  }

  return {
    distance,
    score: distance + directionDifference / 10,
  };
}

function getStationCenter(wagons: WagonCandidate[]): GeoJSON.Feature<GeoJSON.Point> {
  return turf.center(turf.featureCollection(wagons.map((wagon) => wagon.meta.center)));
}

function routeOffsetFromStationCenter(
  stationCenter: GeoJSON.Feature<GeoJSON.Point>,
  route: TroncalRouteFeature
): RouteObservation | null {
  let best:
    | {
      distance: number;
      point: GeoJSON.Feature<GeoJSON.Point>;
    }
    | null = null;

  for (const path of route.geometry?.paths ?? []) {
    if (path.length < 2) continue;
    const line = turf.lineString(path);
    const nearest = turf.nearestPointOnLine(line, stationCenter);
    const distance = turf.distance(stationCenter, nearest, { units: 'meters' });
    if (!best || distance < best.distance) {
      best = {
        distance,
        point: nearest,
      };
    }
  }

  if (!best || best.distance > ROUTE_TO_STATION_DISTANCE_METERS) return null;

  const bearing = turf.bearing(stationCenter, best.point);
  const radians = (bearing * Math.PI) / 180;
  return {
    code: route.attributes.route_name_ruta_troncal,
    offset: Math.cos(radians) * best.distance,
  };
}

function clusterRouteObservations(observations: RouteObservation[], clusterCount: number): RouteObservation[][] {
  const count = Math.min(clusterCount, observations.length);
  if (count <= 1) return [observations];

  const sorted = [...observations].sort((a, b) => b.offset - a.offset);
  let centroids = Array.from({ length: count }, (_, index) => {
    const sampleIndex = Math.round((index * (sorted.length - 1)) / (count - 1));
    return sorted[sampleIndex].offset;
  });

  let clusters: RouteObservation[][] = [];
  for (let iteration = 0; iteration < 8; iteration += 1) {
    clusters = Array.from({ length: count }, () => []);

    sorted.forEach((observation) => {
      let bestIndex = 0;
      let bestDistance = Number.POSITIVE_INFINITY;
      centroids.forEach((centroid, index) => {
        const distance = Math.abs(observation.offset - centroid);
        if (distance < bestDistance) {
          bestDistance = distance;
          bestIndex = index;
        }
      });
      clusters[bestIndex].push(observation);
    });

    centroids = centroids.map((centroid, index) => {
      const cluster = clusters[index];
      return cluster.length
        ? cluster.reduce((sum, observation) => sum + observation.offset, 0) / cluster.length
        : centroid;
    });
  }

  return clusters
    .filter((cluster) => cluster.length > 0)
    .sort((a, b) => {
      const aMean = a.reduce((sum, observation) => sum + observation.offset, 0) / a.length;
      const bMean = b.reduce((sum, observation) => sum + observation.offset, 0) / b.length;
      return bMean - aMean;
    });
}

function redistributeEmptyWagonRoutes(stationWagons: WagonCandidate[], routes: TroncalRouteFeature[]): void {
  if (stationWagons.length < 2) return;
  if (!stationWagons.some((wagon) => wagon.routes.size === 0)) return;

  const stationCenter = getStationCenter(stationWagons);
  const observationsByRoute = new Map<string, RouteObservation>();

  routes.forEach((route) => {
    const observation = routeOffsetFromStationCenter(stationCenter, route);
    if (!observation) return;

    const existing = observationsByRoute.get(observation.code);
    if (!existing || Math.abs(observation.offset) > Math.abs(existing.offset)) {
      observationsByRoute.set(observation.code, observation);
    }
  });

  const observations = Array.from(observationsByRoute.values());
  if (observations.length < stationWagons.length) return;

  const clusters = clusterRouteObservations(observations, stationWagons.length);
  if (clusters.length < 2) return;

  const orderedWagons = [...stationWagons].sort((a, b) =>
    normalizeRouteCode(a.feature.properties.displayName)
      .localeCompare(normalizeRouteCode(b.feature.properties.displayName), undefined, { numeric: true })
  );

  orderedWagons.forEach((wagon) => wagon.routes.clear());
  clusters.forEach((cluster, index) => {
    const wagon = orderedWagons[Math.min(index, orderedWagons.length - 1)];
    cluster.forEach((observation) => wagon.routes.add(observation.code));
  });
}

function assignRoutesToWagons(
  wagons: WagonCandidate[],
  routes: TroncalRouteFeature[],
  layouts: Record<string, any> = {}
): void {
  const wagonsByStation = new Map<string, WagonCandidate[]>();
  wagons.forEach((wagon) => {
    const key = wagon.feature.properties.stationKey;
    wagonsByStation.set(key, [...(wagonsByStation.get(key) ?? []), wagon]);
  });

  const layoutsByName = new Map<string, any>();
  Object.values(layouts).forEach((l: any) => {
    if (l.name) layoutsByName.set(normalizeName(l.name), l);
  });

  wagonsByStation.forEach((stationWagons, stationKey) => {
    const stationName = stationWagons[0]?.feature.properties.stationName;
    const exactLayout = layoutsByName.get(normalizeName(stationName));

    if (exactLayout && exactLayout.wagons && exactLayout.wagons.length > 0) {
      // Use exact layout mapping!
      const layoutWagons = exactLayout.wagons;
      // Sort stationWagons geographically or by displayName so they correspond 1:1 roughly
      const orderedWagons = [...stationWagons].sort((a, b) =>
        normalizeRouteCode(a.feature.properties.displayName)
          .localeCompare(normalizeRouteCode(b.feature.properties.displayName), undefined, { numeric: true })
      );

      orderedWagons.forEach((wagon, index) => {
        const matchingLayoutWagon = layoutWagons[index];
        if (matchingLayoutWagon) {
          if (matchingLayoutWagon.geometry || matchingLayoutWagon.synthetic) {
            const geom = matchingLayoutWagon.synthetic 
               ? buildSyntheticPolygon(orderedWagons[0].meta.centerCoord, matchingLayoutWagon.synthetic)
               : matchingLayoutWagon.geometry;

            wagon.feature.geometry = {
              type: 'Polygon',
              coordinates: geom
            };
            const poly = turf.polygon(geom);
            const newCenter = turf.centerOfMass(poly);
            wagon.meta.center = newCenter;
            wagon.meta.centerCoord = newCenter.geometry.coordinates as Coordinate;
            wagon.meta.bearing = getLongestEdgeBearing(poly);
            wagon.meta.readableBearing = readableMapBearing(wagon.meta.bearing);
          }

          wagon.routesSide1 = new Set();
          wagon.routesSide2 = new Set();
          
          if (matchingLayoutWagon.side1) {
            matchingLayoutWagon.side1.forEach((r: string) => r && r.trim() !== '' && wagon.routesSide1!.add(r.trim()));
          }
          if (matchingLayoutWagon.side2) {
            matchingLayoutWagon.side2.forEach((r: string) => r && r.trim() !== '' && wagon.routesSide2!.add(r.trim()));
          }

          const allRoutes = [...(matchingLayoutWagon.side1 || []), ...(matchingLayoutWagon.side2 || [])];
          allRoutes.forEach((r: string) => {
            if (r && r.trim() !== '') {
               wagon.routes.add(r.trim());
            }
          });
        }
        // If this is the last physical wagon but there are more layout wagons (because ArcGIS data is missing polygons),
        // we procedurally generate and draw the missing wagons!
        if (index === orderedWagons.length - 1 && layoutWagons.length > orderedWagons.length) {
          const lastWagon = wagon;
          
          for (let i = index + 1; i < layoutWagons.length; i++) {
            const extraLayoutWagon = layoutWagons[i];
            const distance = (i - index) * 50; 
            const bearing = lastWagon.meta.bearing;
            
            let baseFeature;
            let newCenter;
            if (extraLayoutWagon.geometry || extraLayoutWagon.synthetic) {
              const geom = extraLayoutWagon.synthetic 
                 ? buildSyntheticPolygon(orderedWagons[0].meta.centerCoord, extraLayoutWagon.synthetic)
                 : extraLayoutWagon.geometry;
              baseFeature = turf.polygon(geom);
              newCenter = turf.centerOfMass(baseFeature);
            } else {
              baseFeature = turf.transformTranslate(
                lastWagon.feature,
                distance,
                bearing,
                { units: 'meters' }
              );
              newCenter = turf.transformTranslate(
                lastWagon.meta.center,
                distance,
                bearing,
                { units: 'meters' }
              ) as GeoJSON.Feature<GeoJSON.Point>;
            }

            const newFeature = baseFeature as WagonFeature;

            const syntheticId = lastWagon.feature.properties.id + i * 10000;
            newFeature.properties = {
              ...lastWagon.feature.properties,
              id: syntheticId,
              displayName: extraLayoutWagon.name || `Vagon ${i + 1}`,
            };

            const newCandidate: WagonCandidate = {
              feature: newFeature,
              meta: {
                ...lastWagon.meta,
                center: newCenter,
                centerCoord: newCenter.geometry.coordinates as Coordinate,
              },
              routes: new Set<string>(),
              routesSide1: new Set<string>(),
              routesSide2: new Set<string>(),
            };

            if (extraLayoutWagon.side1) {
              extraLayoutWagon.side1.forEach((r: string) => r && r.trim() !== '' && newCandidate.routesSide1!.add(r.trim()));
            }
            if (extraLayoutWagon.side2) {
              extraLayoutWagon.side2.forEach((r: string) => r && r.trim() !== '' && newCandidate.routesSide2!.add(r.trim()));
            }

            const extraRoutes = [...(extraLayoutWagon.side1 || []), ...(extraLayoutWagon.side2 || [])];
            extraRoutes.forEach((r: string) => {
              if (r && r.trim() !== '') {
                newCandidate.routes.add(r.trim());
              }
            });

            wagons.push(newCandidate);
          }
        }
      });
      return; // Skip geographical guessing for this station
    }

    // Geographic guessing fallback
    const declaredDirections = new Set(
      stationWagons
        .map((wagon) => wagon.meta.direction?.bearing)
        .filter((bearing): bearing is number => bearing !== undefined)
    );
    const useDeclaredDirection = declaredDirections.size > 1;

    routes.forEach((route) => {
      const routeCode = route.attributes.route_name_ruta_troncal;
      let best:
        | {
          wagon: WagonCandidate;
          score: number;
          distance: number;
        }
        | null = null;

      for (const path of route.geometry?.paths ?? []) {
        for (let i = 1; i < path.length; i += 1) {
          const start = path[i - 1] as Coordinate;
          const end = path[i] as Coordinate;

          // FAST PASSDOWN: Only process segments roughly near the whole station (~300 meters)
          if (!isNearFast(start, stationWagons[0].meta.centerCoord, 0.00001)) {
             continue;
          }

          for (const wagon of stationWagons) {
            // FAST PASSDOWN for wagon (~111 meters)
            if (!isNearFast(start, wagon.meta.centerCoord, 0.000001)) {
               continue;
            }

            const candidate = getRouteSegmentCandidate(wagon, start, end, useDeclaredDirection);
            if (!candidate) continue;
            if (
              !best
              || candidate.score < best.score
              || (candidate.score === best.score && candidate.distance < best.distance)
            ) {
              best = { wagon, score: candidate.score, distance: candidate.distance };
            }
          }
        }
      }

      if (best) {
        best.wagon.routes.add(routeCode);
      }
    });

    redistributeEmptyWagonRoutes(stationWagons, routes);
  });
}

function getLabelPoint(wagon: WagonCandidate, stationWagons: WagonCandidate[]): GeoJSON.Point {
  if (stationWagons.length < 2) return wagon.meta.center.geometry;

  const stationCenter = turf.center(turf.featureCollection(stationWagons.map((item) => item.meta.center)));
  const fromStation = turf.bearing(stationCenter, wagon.meta.center);
  return turf.destination(wagon.meta.center, WAGON_LABEL_OFFSET_METERS, fromStation, { units: 'meters' }).geometry;
}

function hasRenderedFeatureAtPoint(
  map: maplibregl.Map,
  e: maplibregl.MapLayerMouseEvent,
  layerIds: string[]
): boolean {
  const existingLayers = layerIds.filter((layerId) => map.getLayer(layerId));
  return existingLayers.length > 0 && map.queryRenderedFeatures(e.point, { layers: existingLayers }).length > 0;
}

function showStationPopup(
  map: maplibregl.Map,
  e: maplibregl.MapLayerMouseEvent,
  routes: TroncalRouteFeature[]
): void {
  if (hasRenderedFeatureAtPoint(map, e, ['stops-hitbox', 'wagons-fill'])) return;
  if (!markClickHandled(e)) return;
  const feature = e.features?.[0];
  if (!feature || !feature.properties) return;

  const p = feature.properties;
  const coords = (feature.geometry as GeoJSON.Point).coordinates;
  const stationPoint = turf.point(coords as Coordinate);
  const passingRoutes = new Set<string>();

  routes.forEach((route) => {
    for (const path of route.geometry?.paths ?? []) {
      if (path.length < 2) continue;
      const line = turf.lineString(path);
      const distance = turf.pointToLineDistance(stationPoint, line, { units: 'meters' });
      if (distance < 40) {
        passingRoutes.add(route.attributes.route_name_ruta_troncal);
        break;
      }
    }
  });

  const routeList = sortRoutes(passingRoutes);
  const routeTags = formatRouteTags(routeList);
  const meta = [
    p.location,
    p.wagons ? `${p.wagons} vagones` : '',
    p.bike ? `Biciparqueo (${p.bikeCapacity})` : '',
    p.wifi === 'SI' ? 'WiFi' : '',
  ].filter(Boolean);

  const html = `
    <div class="popup-card">
      <div class="popup-eyebrow">${escapeHTML(p.corridor)}</div>
      <div class="popup-title">${escapeHTML(p.name)}</div>
      ${meta.length ? `<div class="popup-meta">${meta.map((item) => `<span>${escapeHTML(item)}</span>`).join('')}</div>` : ''}
      ${routeTags ? `<div class="popup-route-tags">${routeTags}</div>` : ''}
    </div>
  `;

  showPopup(map, coords as Coordinate, html, { offset: 12, maxWidth: '300px' });
}

function showWagonPopup(map: maplibregl.Map, e: maplibregl.MapLayerMouseEvent): void {
  if (hasRenderedFeatureAtPoint(map, e, ['stops-hitbox'])) return;
  if (!markClickHandled(e)) return;
  const feature = e.features?.[0];
  if (!feature || !feature.properties) return;

  const p = feature.properties;
  const routes = JSON.parse(p.routes || '[]') as string[];
  const routesSide1 = JSON.parse(p.routesSide1 || '[]') as string[];
  const routesSide2 = JSON.parse(p.routesSide2 || '[]') as string[];

  let routeTags = '';
  
  if (routesSide1.length > 0 || routesSide2.length > 0) {
    if (routesSide1.length > 0) {
      routeTags += `<div class="popup-eyebrow" style="margin-top: 8px;">Puerta Occidente / Sur</div>`;
      routeTags += formatRouteTags(routesSide1);
    }
    if (routesSide2.length > 0) {
      routeTags += `<div class="popup-eyebrow" style="margin-top: 8px;">Puerta Oriente / Norte</div>`;
      routeTags += formatRouteTags(routesSide2);
    }
  } else if (routes.length) {
    routeTags = formatRouteTags(routes);
  } else {
    routeTags = '<span class="popup-empty">Sin rutas asociadas</span>';
  }
  const subtitle = [p.displayName, p.directionLabel].filter(Boolean).join(' ');
  const html = `
    <div class="popup-card popup-card-compact">
      <div class="popup-eyebrow">Vagon troncal</div>
      <div class="popup-title">${escapeHTML(p.stationName)}</div>
      <div class="popup-subtitle">${escapeHTML(subtitle)}</div>
      <div class="popup-route-tags">${routeTags}</div>
    </div>
  `;

  showPopup(map, e.lngLat, html, { offset: 8, maxWidth: '280px' });
}

export function addStationsLayer(
  map: maplibregl.Map,
  stations: TroncalStationFeature[],
  routes: TroncalRouteFeature[] = [],
  layouts: Record<string, any> = {}
): void {
  const visibleStations = stations.filter(isVisibleTroncalStation);
  const geojson: GeoJSON.FeatureCollection = {
    type: 'FeatureCollection',
    features: visibleStations.map((s) => ({
      type: 'Feature',
      properties: {
        name: s.attributes.nombre_estacion,
        corridor: s.attributes.troncal_estacion,
        location: s.attributes.ubicacion_estacion,
        wifi: s.attributes.componente_wifi,
        bike: s.attributes.biciestacion_estacion === '1',
        bikeCapacity: s.attributes.capacidad_biciestacion_estacion,
        wagons: s.attributes.numero_vagones_estacion,
        stationType: s.attributes.tipo_estacion,
      },
      geometry: {
        type: 'Point',
        coordinates: [s.geometry.x, s.geometry.y],
      },
    })),
  };

  map.addSource('stations', { type: 'geojson', data: geojson });

  map.addLayer({
    id: 'stations-glow',
    type: 'circle',
    source: 'stations',
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 6, 14, 14, 17, 22],
      'circle-color': '#FBBF24',
      'circle-opacity': 0.15,
      'circle-blur': 0.8,
    },
  });

  map.addLayer({
    id: 'stations-circle',
    type: 'circle',
    source: 'stations',
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 3, 14, 7, 17, 12],
      'circle-color': '#FBBF24',
      'circle-stroke-color': '#0A0E17',
      'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 10, 1, 14, 2],
      'circle-opacity': 0.92,
    },
  });

  map.addLayer({
    id: 'stations-hitbox',
    type: 'circle',
    source: 'stations',
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 12, 14, 18, 17, 26],
      'circle-color': '#FBBF24',
      'circle-opacity': 0.01,
    },
  });

  map.addLayer({
    id: 'stations-labels',
    type: 'symbol',
    source: 'stations',
    minzoom: 13,
    layout: {
      'text-field': ['get', 'name'],
      'text-font': ['Open Sans Bold'],
      'text-size': ['interpolate', ['linear'], ['zoom'], 13, 9, 16, 13],
      'text-offset': [0, 1.5],
      'text-anchor': 'top',
      'text-max-width': 10,
    },
    paint: {
      'text-color': '#FBBF24',
      'text-halo-color': '#0A0E17',
      'text-halo-width': 1.5,
      'text-opacity': ['interpolate', ['linear'], ['zoom'], 13, 0.6, 15, 1],
    },
  });

  map.on('click', 'stations-hitbox', (e) => showStationPopup(map, e, routes));
  map.on('mouseenter', 'stations-hitbox', () => {
    map.getCanvas().style.cursor = 'pointer';
  });
  map.on('mouseleave', 'stations-hitbox', () => {
    map.getCanvas().style.cursor = '';
  });
}

export function addWagonsLayer(
  map: maplibregl.Map,
  wagons: TroncalWagonFeature[],
  routes: TroncalRouteFeature[] = [],
  layouts: Record<string, any> = {}
): void {
  const activeWagons = wagons.filter(isActiveWagon);
  const ordinals = getStationLocalOrdinals(activeWagons);
  const candidates: WagonCandidate[] = activeWagons.map((wagon) => {
    const feature = makeWagonFeature(wagon, ordinals.get(wagon.attributes.objectid) ?? 1);
    const meta = getWagonMeta(feature, wagon);
    feature.properties.directionLabel = meta.direction?.label ?? '';
    return {
      feature,
      meta,
      routes: new Set<string>(),
      routesSide1: new Set<string>(),
      routesSide2: new Set<string>(),
    };
  });

  assignRoutesToWagons(candidates, routes, layouts);

  const candidatesByStation = new Map<string, WagonCandidate[]>();
  candidates.forEach((candidate) => {
    const key = candidate.feature.properties.stationKey;
    candidatesByStation.set(key, [...(candidatesByStation.get(key) ?? []), candidate]);
  });

  const labelFeatures: WagonLabelFeature[] = [];
  const wagonFeatures = candidates.map((candidate) => {
    const routesForWagon = sortRoutes(candidate.routes);
    
    const props: any = {
      ...candidate.feature.properties,
      routes: JSON.stringify(routesForWagon),
      routesSide1: candidate.routesSide1 ? JSON.stringify(sortRoutes(candidate.routesSide1)) : '[]',
      routesSide2: candidate.routesSide2 ? JSON.stringify(sortRoutes(candidate.routesSide2)) : '[]',
      vagonLabel: [candidate.feature.properties.displayName, candidate.feature.properties.directionLabel].filter(Boolean).join(' '),
    };

    // Prepare color slots for the map renderer
    for (let i = 0; i < 12; i++) {
        const route = routesForWagon[i];
        if (route) {
            props[`r${i + 1}`] = route;
            props[`c${i + 1}`] = getTroncalColor(route);
            props[`s${i + 1}`] = ' '; // Spacer
        } else {
            props[`r${i + 1}`] = '';
            props[`c${i + 1}`] = '#ffffff';
            props[`s${i + 1}`] = '';
        }
    }

    labelFeatures.push({
      type: 'Feature',
      properties: {
        ...props,
        bearing: candidate.meta.readableBearing,
      },
      geometry: getLabelPoint(candidate, candidatesByStation.get(candidate.feature.properties.stationKey) ?? [candidate]),
    });

    return {
      ...candidate.feature,
      properties: props,
    };
  });

  map.addSource('wagons', {
    type: 'geojson',
    data: {
      type: 'FeatureCollection',
      features: wagonFeatures,
    },
  });

  map.addSource('wagon-route-labels', {
    type: 'geojson',
    data: {
      type: 'FeatureCollection',
      features: labelFeatures,
    },
  });

  map.addLayer({
    id: 'wagons-fill',
    type: 'fill',
    source: 'wagons',
    minzoom: 15,
    paint: {
      'fill-color': '#182235',
      'fill-opacity': 0.58,
      'fill-outline-color': '#FBBF24',
    },
  });

  map.addLayer({
    id: 'wagons-line',
    type: 'line',
    source: 'wagons',
    minzoom: 15,
    paint: {
      'line-color': '#FBBF24',
      'line-width': 1.4,
    },
  });

  map.addLayer({
    id: 'wagons-route-labels',
    type: 'symbol',
    source: 'wagon-route-labels',
    minzoom: 15,
    layout: {
      'text-field': [
        'format',
        ['get', 'vagonLabel'], { 'font-scale': 1.1, 'text-font': ['Open Sans Bold'] },
        '\n', {},
        ['get', 'r1'], { 'text-color': ['get', 'c1'] }, ['get', 's1'], {},
        ['get', 'r2'], { 'text-color': ['get', 'c2'] }, ['get', 's2'], {},
        ['get', 'r3'], { 'text-color': ['get', 'c3'] }, ['get', 's3'], {},
        ['get', 'r4'], { 'text-color': ['get', 'c4'] }, ['get', 's4'], {},
        ['get', 'r5'], { 'text-color': ['get', 'c5'] }, ['get', 's5'], {},
        ['get', 'r6'], { 'text-color': ['get', 'c6'] }, ['get', 's6'], {},
        ['get', 'r7'], { 'text-color': ['get', 'c7'] }, ['get', 's7'], {},
        ['get', 'r8'], { 'text-color': ['get', 'c8'] }, ['get', 's8'], {},
        ['get', 'r9'], { 'text-color': ['get', 'c9'] }, ['get', 's9'], {},
        ['get', 'r10'], { 'text-color': ['get', 'c10'] }, ['get', 's10'], {},
        ['get', 'r11'], { 'text-color': ['get', 'c11'] }, ['get', 's11'], {},
        ['get', 'r12'], { 'text-color': ['get', 'c12'] }, ['get', 's12'], {}
      ],
      'text-font': ['Open Sans Bold'],
      'text-size': ['interpolate', ['linear'], ['zoom'], 15, 8, 17, 10],
      'text-max-width': 12,
      'text-rotate': ['get', 'bearing'],
      'text-rotation-alignment': 'map',
      'text-pitch-alignment': 'map',
      'text-allow-overlap': false,
      'text-ignore-placement': false,
    },
    paint: {
      'text-color': '#FFFFFF',
      'text-halo-color': '#0A0E17',
      'text-halo-width': 1.3,
    },
  });

  map.on('click', 'wagons-fill', (e) => showWagonPopup(map, e));
  map.on('mouseenter', 'wagons-fill', () => {
    map.getCanvas().style.cursor = 'pointer';
  });
  map.on('mouseleave', 'wagons-fill', () => {
    map.getCanvas().style.cursor = '';
  });
}

export function toggleStationsLayer(map: maplibregl.Map, visible: boolean): void {
  const visibility = visible ? 'visible' : 'none';
  STATION_LAYERS.forEach((id) => {
    if (map.getLayer(id)) {
      map.setLayoutProperty(id, 'visibility', visibility);
    }
  });
}

export function bringStationsLayerToFront(map: maplibregl.Map): void {
  STATION_LAYERS.forEach((id) => {
    if (map.getLayer(id)) {
      map.moveLayer(id);
    }
  });
}
