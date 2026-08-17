/**
 * Route and trunk polyline layers.
 */

import maplibregl from 'maplibre-gl';
import type { RouteListItem, TroncalCorridorFeature, TroncalRouteFeature, TroncalStationFeature } from '../types/transmilenio';
import {
  DEFAULT_TRONCAL_COLOR,
  DEFAULT_ZONAL_COLOR,
  getRouteColor,
  getTroncalColor,
  getTroncalLetter,
  normalizeRouteCode,
  normalizeRouteCodeForMatch,
  TRONCAL_COLORS,
} from '../utils/routeColors';

// `utils/routeColors` is the single source of the palette (spec §5.4.3); the
// re-export barrel that used to live here gave five of its symbols a second
// import path and three of them no consumer at all. Import from the util.
export { normalizeRouteCode, normalizeRouteCodeForMatch };

let claimedClickEvent: Event | null = null;

export function markClickHandled(e: maplibregl.MapMouseEvent): boolean {
  const originalEvent = e.originalEvent as Event | undefined;
  if (originalEvent && claimedClickEvent === originalEvent) return false;

  e.preventDefault();
  originalEvent?.stopPropagation();

  if (originalEvent) {
    claimedClickEvent = originalEvent;
    window.setTimeout(() => {
      if (claimedClickEvent === originalEvent) claimedClickEvent = null;
    }, 0);
  }

  return true;
}

function routeItemsToGeoJSON(
  routes: RouteListItem[]
): GeoJSON.FeatureCollection {
  // We only draw routes that actually have a geometry
  const featuresWithGeom = routes.filter((r) => r.geometry && r.geometry.paths && r.geometry.paths.length > 0);

  return {
    type: 'FeatureCollection',
    features: featuresWithGeom.map((r) => ({
      type: 'Feature' as const,
      properties: {
        id: r.id,
        code: r.code,
        originalCode: r.code,
        letter: r.type === 'troncal' ? getTroncalLetter(r.code) : undefined,
        color: r.color,
        name: r.name,
        type: r.type,
        origin: r.origin,
        destination: r.destination,
        busType: r.busType,
        schedule: r.schedule,
        operator: r.operator,
        length: r.length,
      },
      geometry: {
        type: 'MultiLineString' as const,
        coordinates: r.geometry!.paths,
      },
    })),
  };
}

function corridorsToGeoJSON(features: TroncalCorridorFeature[]): GeoJSON.FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: features
      .filter((f) => Array.isArray(f.geometry?.paths) && f.geometry.paths.length > 0)
      .map((f) => {
        const letter = getTroncalLetter(f.attributes.letra_trazado_troncal);
        return {
          type: 'Feature' as const,
          properties: {
            id: f.attributes.objectid,
            letter,
            color: letter ? getTroncalColor(letter) : DEFAULT_TRONCAL_COLOR,
            troncal: f.attributes.troncal,
            start: f.attributes.inicio_trazado,
            end: f.attributes.fin_trazado,
          },
          geometry: {
            type: 'MultiLineString' as const,
            coordinates: f.geometry.paths,
          },
        };
      }),
  };
}

/**
 * Catalog fallback for the trunk-corridor layer (spec §4.2: "if ArcGIS troncal
 * routes/corridors fail, the map still renders routes using coordinates from
 * catalog traces"). ArcGIS is the only source of the surveyed corridor
 * centrelines, but the corridors are also the ground every troncal route rides,
 * so the official `trazado` of the routes — already in the required master
 * catalog — reconstructs the trunk network.
 *
 * Traces are merged per trunk letter, which is what the layer keys its colour
 * and label on, so the result is one corridor feature per letter exactly like
 * the ArcGIS payload. It is an approximation of the centreline (route branches
 * into portals show up as branches), not a replacement — the moment the ArcGIS
 * layer answers again, the recovery pass replaces it.
 */
export function catalogCorridorsToFeatures(troncalRoutes: RouteListItem[]): TroncalCorridorFeature[] {
  const pathsByLetter = new Map<string, number[][][]>();

  for (const route of troncalRoutes) {
    const paths = route.geometry?.paths;
    if (!paths?.length) continue;
    const letter = getTroncalLetter(route.code);
    // `RF` is a service family (rutas fáciles), not a corridor — those routes
    // ride the lettered trunks that are already drawn, and their black line
    // would only bury them.
    if (!letter || letter === 'RF' || !(letter in TRONCAL_COLORS)) continue;

    const merged = pathsByLetter.get(letter);
    if (merged) merged.push(...paths);
    else pathsByLetter.set(letter, [...paths]);
  }

  let objectid = 1;
  return Array.from(pathsByLetter, ([letter, paths]) => ({
    attributes: {
      objectid: objectid++,
      id_trazado: `catalog-${letter}`,
      inicio_trazado: '',
      fin_trazado: '',
      tipo_trazado: 'catalog',
      letra_trazado_troncal: letter,
      troncal: `Troncal ${letter}`,
      fase_trazado_troncal: '',
    },
    geometry: { paths },
  }));
}

// ─── Corridor gaps (a trunk ArcGIS has not surveyed yet) ───

/** A corridor point this far from the rider's trace counts as "already drawn". */
const CORRIDOR_COVERED_M = 80;
/** Grid cell for the covered-point index, in degrees (~110 m at Bogotá's latitude). */
const CORRIDOR_CELL_DEG = 0.001;
/** Shorter runs than this are trace noise beside the corridor, not a new trunk. */
const MIN_GAP_POINTS = 4;
const MIN_GAP_METERS = 250;
/** How close a run must pass to an un-surveyed estación to count as its trunk. */
const ORPHAN_STATION_M = 250;

function cellKey(lng: number, lat: number): string {
  return `${Math.floor(lng / CORRIDOR_CELL_DEG)}:${Math.floor(lat / CORRIDOR_CELL_DEG)}`;
}

function metersBetween(a: number[], b: number[]): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b[1] - a[1]);
  const dLng = toRad(b[0] - a[0]);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a[1])) * Math.cos(toRad(b[1])) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(h));
}

function pathMeters(path: number[][]): number {
  let total = 0;
  for (let i = 1; i < path.length; i++) total += metersBetween(path[i - 1], path[i]);
  return total;
}

/**
 * Trunk corridor that exists on the street but not in the ArcGIS survey.
 *
 * `consulta_trazados_troncales` publishes 20 centrelines over 12 corridors, and a
 * new trunk arrives there **late**: TransMi opened the Bosa–Tibanica stretch with
 * its stations filed under `TZ022`, a corridor that layer has never heard of. The
 * result on screen is a Troncales layer that simply stops mid-city — the corridor
 * the rider is standing on is missing, not drawn faintly.
 *
 * The routes that ride it do carry the geometry (their official `trazado`), so the
 * gap is filled from them and from nothing else. Only the parts **no surveyed
 * corridor already covers** are kept: Z63 runs Tibanica → Banderas → Pradera, and
 * two thirds of that is the Américas trunk ArcGIS draws perfectly well — patching
 * the whole trace would lay a second, differently-coloured line on top of it.
 *
 * Each kept run is emitted under the ROUTE's own letter, so the new stretch is
 * drawn and labelled in that trunk's colour (`Z` = amber, spec §5.4.3) rather than
 * inheriting the colour of whichever corridor it happens to touch.
 */
export function corridorGapFeatures(
  troncalRoutes: RouteListItem[],
  surveyed: TroncalCorridorFeature[],
  stations: TroncalStationFeature[]
): TroncalCorridorFeature[] {
  const covered = new Set<string>();
  for (const corridor of surveyed) {
    for (const path of corridor.geometry?.paths ?? []) {
      for (const [lng, lat] of path) covered.add(cellKey(lng, lat));
    }
  }
  if (covered.size === 0) return [];

  const isCovered = (point: number[]): boolean => {
    const [lng, lat] = point;
    // The 3×3 neighbourhood, so a point just across a cell boundary from the
    // corridor still counts as covered.
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        if (covered.has(cellKey(lng + dx * CORRIDOR_CELL_DEG, lat + dy * CORRIDOR_CELL_DEG))) return true;
      }
    }
    return false;
  };

  // What separates a NEW TRUNK from a troncal route driving down an ordinary
  // street: estaciones. Every station on a surveyed corridor is already covered
  // above, so the ones left over are the trunk ArcGIS has not caught up with. No
  // uncovered station, no patch — otherwise the K86's airport run and the Carrera
  // 7 extension add ~50 km of mixed-traffic street to a layer that means
  // "dedicated trunk".
  const orphanStations = stations
    .map((station) => [Number(station.attributes.longitud_estacion), Number(station.attributes.latitud_estacion)])
    .filter(([lng, lat]) => Number.isFinite(lng) && Number.isFinite(lat) && !isCovered([lng, lat]));
  if (orphanStations.length === 0) return [];

  const servesOrphanStation = (run: number[][]): boolean =>
    orphanStations.some((station) => run.some((point) => metersBetween(point, station) <= ORPHAN_STATION_M));

  const gapsByLetter = new Map<string, number[][][]>();
  for (const route of troncalRoutes) {
    const letter = getTroncalLetter(route.code);
    if (!letter || letter === 'RF' || !(letter in TRONCAL_COLORS)) continue;

    for (const path of route.geometry?.paths ?? []) {
      let run: number[][] = [];
      const flush = (): void => {
        if (run.length >= MIN_GAP_POINTS && pathMeters(run) >= MIN_GAP_METERS && servesOrphanStation(run)) {
          const existing = gapsByLetter.get(letter);
          if (existing) existing.push(run);
          else gapsByLetter.set(letter, [run]);
        }
        run = [];
      };
      for (const point of path) {
        if (!Array.isArray(point) || point.length < 2) continue;
        if (isCovered(point)) flush();
        else run.push(point);
      }
      flush();
    }
  }

  // Both directions of the new service reach these stations, and they carry
  // different letters — `F63` and `Z63` on the Bosa stretch. Drawing both lays
  // the Américas red on top of the amber and makes a brand-new trunk look like an
  // extension of one it never touches. The letter with **no surveyed corridor of
  // its own** is the one that names this stretch: it is new for the same reason
  // the corridor is.
  const surveyedLetters = new Set(
    surveyed
      .map((corridor) => getTroncalLetter(corridor.attributes.letra_trazado_troncal))
      .filter((letter): letter is string => Boolean(letter))
  );
  const unsurveyed = Array.from(gapsByLetter.keys()).filter((letter) => !surveyedLetters.has(letter));
  if (unsurveyed.length > 0) {
    for (const letter of gapsByLetter.keys()) {
      if (!unsurveyed.includes(letter)) gapsByLetter.delete(letter);
    }
  }

  let objectid = 10_000; // well clear of the ArcGIS ids this is appended to
  return Array.from(gapsByLetter, ([letter, paths]) => ({
    attributes: {
      objectid: objectid++,
      id_trazado: `gap-${letter}`,
      inicio_trazado: '',
      fin_trazado: '',
      tipo_trazado: 'catalog-gap',
      letra_trazado_troncal: letter,
      troncal: `Troncal ${letter}`,
      fase_trazado_troncal: '',
    },
    geometry: { paths },
  }));
}

export function addTroncalCorridorsLayer(
  map: maplibregl.Map,
  corridors: TroncalCorridorFeature[]
): void {
  // Idempotent: the recovery pass (main.ts) re-runs the layer once a degraded
  // ArcGIS fetch finally succeeds, and re-adding a live source throws.
  if (map.getSource('troncal-corridors')) {
    updateTroncalCorridors(map, corridors);
    return;
  }

  const geojson = corridorsToGeoJSON(corridors);
  map.addSource('troncal-corridors', { type: 'geojson', data: geojson });

  map.addLayer({
    id: 'troncal-corridors-casing',
    type: 'line',
    source: 'troncal-corridors',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': '#050812',
      'line-width': ['interpolate', ['linear'], ['zoom'], 10, 3, 14, 6, 17, 10],
      'line-opacity': 0.72,
    },
  });

  map.addLayer({
    id: 'troncal-corridors-line',
    type: 'line',
    source: 'troncal-corridors',
    layout: {
      'line-cap': 'round',
      'line-join': 'round',
      'line-sort-key': ['index-of', ['get', 'letter'], 'ABCDEFGHIJKLMPT'],
    },
    paint: {
      'line-color': ['get', 'color'],
      'line-width': ['interpolate', ['linear'], ['zoom'], 10, 2, 14, 4, 17, 6],
      'line-opacity': 0.95,
    },
  });

  map.addLayer({
    id: 'troncal-corridors-labels',
    type: 'symbol',
    source: 'troncal-corridors',
    minzoom: 12,
    layout: {
      'symbol-placement': 'line',
      'text-field': ['get', 'letter'],
      'text-font': ['Open Sans Bold'],
      'text-size': ['interpolate', ['linear'], ['zoom'], 12, 10, 16, 14],
      'text-allow-overlap': false,
      'text-ignore-placement': false,
    },
    paint: {
      'text-color': '#FFFFFF',
      'text-halo-color': '#050812',
      'text-halo-width': 1.2,
    },
  });
}

export function updateTroncalCorridors(
  map: maplibregl.Map,
  corridors: TroncalCorridorFeature[]
): void {
  const source = map.getSource('troncal-corridors') as maplibregl.GeoJSONSource | undefined;
  source?.setData(corridorsToGeoJSON(corridors));
}

export function addTroncalRoutesLayer(
  map: maplibregl.Map,
  routes: RouteListItem[]
): void {
  const geojson = routeItemsToGeoJSON(routes);
  const source = map.getSource('troncal-routes') as maplibregl.GeoJSONSource | undefined;
  if (source) {
    source.setData(geojson);
    return;
  }
  map.addSource('troncal-routes', { type: 'geojson', data: geojson });
}

export function addZonalRoutesLayer(
  map: maplibregl.Map,
  routes: RouteListItem[]
): void {
  const geojson = routeItemsToGeoJSON(routes);
  map.addSource('zonal-routes', { type: 'geojson', data: geojson });

  // Insert zonal layers BEFORE any troncal layers if they exist
  const firstTroncalLayer = 'troncal-corridors-casing';
  const beforeId = map.getLayer(firstTroncalLayer) ? firstTroncalLayer : undefined;

  map.addLayer({
    id: 'zonal-routes-casing',
    type: 'line',
    source: 'zonal-routes',
    layout: { 'line-cap': 'round', 'line-join': 'round', 'visibility': 'none' },
    paint: {
      'line-color': '#032A3F',
      'line-width': ['interpolate', ['linear'], ['zoom'], 10, 1.5, 14, 3.5, 17, 5],
      'line-opacity': 0.35,
    },
  }, beforeId);

  map.addLayer({
    id: 'zonal-routes-glow',
    type: 'line',
    source: 'zonal-routes',
    layout: { 'line-cap': 'round', 'line-join': 'round', 'visibility': 'none' },
    paint: {
      'line-color': DEFAULT_ZONAL_COLOR,
      'line-width': ['interpolate', ['linear'], ['zoom'], 10, 2, 14, 4, 17, 6],
      'line-opacity': 0.16,
      'line-blur': 3,
    },
  }, beforeId);

  map.addLayer({
    id: 'zonal-routes-line',
    type: 'line',
    source: 'zonal-routes',
    layout: { 'line-cap': 'round', 'line-join': 'round', 'visibility': 'none' },
    paint: {
      'line-color': DEFAULT_ZONAL_COLOR,
      'line-width': ['interpolate', ['linear'], ['zoom'], 10, 0.5, 14, 1.5, 17, 2],
      'line-opacity': 0.78,
    },
  }, beforeId);
}

export function updateZonalRoutes(map: maplibregl.Map, routes: RouteListItem[]): void {
  const source = map.getSource('zonal-routes') as maplibregl.GeoJSONSource;
  if (source) {
    source.setData(routeItemsToGeoJSON(routes));
  }
}

export function bringTroncalLayersToFront(map: maplibregl.Map): void {
  // Order matters: Bottom to Top
  const layers = [
    'troncal-corridors-casing',
    'troncal-corridors-line',
    'highlight-route-casing',
    'highlight-route-glow',
    'highlight-route',
    'troncal-corridors-labels',
  ];
  layers.forEach((id) => {
    if (map.getLayer(id)) map.moveLayer(id);
  });
}

export function toggleTroncalRoutes(map: maplibregl.Map, visible: boolean): void {
  const v = visible ? 'visible' : 'none';
  const layers = [
    'troncal-corridors-casing',
    'troncal-corridors-line',
    'troncal-corridors-labels',
  ];
  layers.forEach((id) => {
    if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', v);
  });

  // Re-enforce hierarchy when turning back on
  if (visible) {
    bringTroncalLayersToFront(map);
  }
}

export function toggleZonalRoutes(map: maplibregl.Map, visible: boolean): void {
  const v = visible ? 'visible' : 'none';
  ['zonal-routes-casing', 'zonal-routes-glow', 'zonal-routes-line'].forEach((id) => {
    if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', v);
  });

  // If turning on zonales, make sure troncals still stay on top
  if (visible) {
    bringTroncalLayersToFront(map);
  }
}

export function highlightRoute(
  map: maplibregl.Map,
  routeCode: string,
  type: 'troncal' | 'zonal',
  customGeometry?: { paths: number[][][] },
  color?: string
): void {
  clearHighlight(map);

  // Dim global traces
  if (map.getLayer('troncal-corridors-line')) map.setPaintProperty('troncal-corridors-line', 'line-opacity', 0.1);
  if (map.getLayer('troncal-corridors-casing')) map.setPaintProperty('troncal-corridors-casing', 'line-opacity', 0.05);
  if (map.getLayer('troncal-corridors-labels')) map.setPaintProperty('troncal-corridors-labels', 'text-opacity', 0.1);

  if (map.getLayer('zonal-routes-line')) map.setPaintProperty('zonal-routes-line', 'line-opacity', 0.02);
  if (map.getLayer('zonal-routes-casing')) map.setPaintProperty('zonal-routes-casing', 'line-opacity', 0.01);
  if (map.getLayer('zonal-routes-glow')) map.setPaintProperty('zonal-routes-glow', 'line-opacity', 0);

  if (map.getLayer('stations-circle')) map.setPaintProperty('stations-circle', 'icon-opacity', 0.25);
  if (map.getLayer('stations-labels')) map.setPaintProperty('stations-labels', 'text-opacity', 0.2);
  if (map.getLayer('stops-circle')) map.setPaintProperty('stops-circle', 'icon-opacity', 0.25);
  if (map.getLayer('stops-labels')) map.setPaintProperty('stops-labels', 'text-opacity', 0.2);

  if (map.getLayer('cable-traces-line')) map.setPaintProperty('cable-traces-line', 'line-opacity', 0.1);
  if (map.getLayer('cable-stations-circle')) map.setPaintProperty('cable-stations-circle', 'icon-opacity', 0.25);
  if (map.getLayer('cable-stations-labels')) map.setPaintProperty('cable-stations-labels', 'text-opacity', 0.2);

  let sourceId = `${type}-routes`;
  let filter: any[] = ['==', ['get', 'code'], routeCode];

  if (customGeometry) {
    sourceId = 'highlight-temp-source';
    const geojson: GeoJSON.FeatureCollection = {
      type: 'FeatureCollection',
      features: [{
        type: 'Feature',
        properties: { code: routeCode, color: color || getRouteColor(routeCode, type) },
        geometry: { type: 'MultiLineString', coordinates: customGeometry.paths },
      }],
    };
    map.addSource(sourceId, { type: 'geojson', data: geojson });
    filter = ['all'];
  }

  const source = map.getSource(sourceId);
  if (!source) return;

  const glowId = 'highlight-route-glow';
  const lineId = 'highlight-route';
  const lineColor = color
    ? color
    : ['coalesce', ['get', 'color'], type === 'troncal' ? DEFAULT_TRONCAL_COLOR : DEFAULT_ZONAL_COLOR] as any;

  const beforeId = map.getLayer('stations-circle') ? 'stations-circle' : undefined;

  const casingColor = color === '#000000' || color === '#050812' ? '#FFFFFF' : '#000000';

  map.addLayer({
    id: 'highlight-route-casing',
    type: 'line',
    source: sourceId,
    filter,
    layout: { 'line-cap': 'round', 'line-join': 'round', visibility: 'visible' },
    paint: {
      'line-color': casingColor,
      'line-width': ['interpolate', ['linear'], ['zoom'], 10, 5, 14, 8, 17, 11] as any,
      'line-opacity': 0.85,
    },
  } as any, beforeId);

  map.addLayer({
    id: glowId,
    type: 'line',
    source: sourceId,
    filter,
    layout: { 'line-cap': 'round', 'line-join': 'round', visibility: 'visible' },
    paint: {
      'line-color': lineColor,
      'line-width': ['interpolate', ['linear'], ['zoom'], 10, 6, 14, 12, 17, 18] as any,
      'line-opacity': 0.35,
      'line-blur': 6,
    },
  } as any, beforeId);

  map.addLayer({
    id: lineId,
    type: 'line',
    source: sourceId,
    filter,
    layout: { 'line-cap': 'round', 'line-join': 'round', visibility: 'visible' },
    paint: {
      'line-color': lineColor,
      'line-width': ['interpolate', ['linear'], ['zoom'], 10, 3, 14, 5, 17, 7] as any,
      'line-opacity': 1,
    },
  } as any, beforeId);
}

export function clearHighlight(map: maplibregl.Map): void {
  if (map.getLayer('highlight-route-casing')) map.removeLayer('highlight-route-casing');
  if (map.getLayer('highlight-route')) map.removeLayer('highlight-route');
  if (map.getLayer('highlight-route-glow')) map.removeLayer('highlight-route-glow');
  if (map.getSource('highlight-temp-source')) map.removeSource('highlight-temp-source');

  // Restore global traces
  if (map.getLayer('troncal-corridors-line')) map.setPaintProperty('troncal-corridors-line', 'line-opacity', 0.95);
  if (map.getLayer('troncal-corridors-casing')) map.setPaintProperty('troncal-corridors-casing', 'line-opacity', 0.72);
  if (map.getLayer('troncal-corridors-labels')) map.setPaintProperty('troncal-corridors-labels', 'text-opacity', 1);

  if (map.getLayer('zonal-routes-line')) map.setPaintProperty('zonal-routes-line', 'line-opacity', 0.78);
  if (map.getLayer('zonal-routes-casing')) map.setPaintProperty('zonal-routes-casing', 'line-opacity', 0.35);
  if (map.getLayer('zonal-routes-glow')) map.setPaintProperty('zonal-routes-glow', 'line-opacity', 0.16);

  if (map.getLayer('stations-circle')) map.setPaintProperty('stations-circle', 'icon-opacity', 1);
  if (map.getLayer('stations-labels')) map.setPaintProperty('stations-labels', 'text-opacity', ['interpolate', ['linear'], ['zoom'], 14, 0.6, 16, 1]);
  if (map.getLayer('stops-circle')) map.setPaintProperty('stops-circle', 'icon-opacity', 1);
  if (map.getLayer('stops-labels')) map.setPaintProperty('stops-labels', 'text-opacity', ['interpolate', ['linear'], ['zoom'], 16, 0.5, 17, 0.9]);

  if (map.getLayer('cable-traces-line')) map.setPaintProperty('cable-traces-line', 'line-opacity', 0.85);
  if (map.getLayer('cable-stations-circle')) map.setPaintProperty('cable-stations-circle', 'icon-opacity', 1);
  if (map.getLayer('cable-stations-labels')) map.setPaintProperty('cable-stations-labels', 'text-opacity', ['interpolate', ['linear'], ['zoom'], 13, 0.6, 15, 1]);
}
