/**
 * Troncal station layer — simplified.
 *
 * Renders stations as circles/labels. On click, shows a premium popup
 * with wagon → route data sourced from the TransMi app master catalog.
 * No more polygon rendering or geometric route guessing.
 */

import maplibregl from 'maplibre-gl';
import type { TroncalStationFeature } from '../types/transmilenio';
import { markClickHandled, normalizeRouteCode, normalizeRouteCodeForMatch } from './routes';
import { showPopup } from './popup';
import { escapeHTML, safeColor } from '../utils/html';
import { getStopTagColor } from '../utils/routeColors';
import type { MasterCatalog, CatalogRoute } from '../types/catalog';
import {
  buildStationKey,
  normalizeStationName,
  resolveStationCatalog,
  stationNode,
  type ResolvedCatalogStation,
  type StationCatalogAudit,
} from './stationCatalogResolver';

const STATION_LAYERS = [
  'stations-circle',
  'stations-hitbox',
  'stations-labels',
];

const UNUSED_TRONCAL_STATIONS = new Set([
  'ISLANDIA',
  'LOSLAURELES',
  'TIBANICAPRIMAVERA',
]);

export function isVisibleTroncalStation(station: TroncalStationFeature): boolean {
  return !UNUSED_TRONCAL_STATIONS.has(normalizeStationName(station.attributes.nombre_estacion));
}

// ─── Route Tag Formatting ───────────────────────────────

function groupCatalogRoutesByCode(routes: CatalogRoute[]): Array<{ code: string; primary: CatalogRoute; routes: CatalogRoute[] }> {
  const groups = new Map<string, { code: string; primary: CatalogRoute; routes: CatalogRoute[] }>();

  for (const route of routes) {
    const key = normalizeRouteCodeForMatch(route.codigo);
    if (!key) continue;

    const group = groups.get(key);
    if (group) {
      group.routes.push(route);
    } else {
      groups.set(key, { code: route.codigo, primary: route, routes: [route] });
    }
  }

  return Array.from(groups.values()).sort((a, b) =>
    normalizeRouteCode(a.code).localeCompare(normalizeRouteCode(b.code), undefined, { numeric: true })
  );
}

function formatRouteTags(routes: CatalogRoute[], limit = 28): string {
  const groups = groupCatalogRoutesByCode(routes);
  const visibleGroups = groups.slice(0, limit);
  const hiddenCount = groups.length - visibleGroups.length;
  const tags = visibleGroups
    .map((group) => {
      const route = group.primary;
      const color = safeColor(getStopTagColor(route.codigo, route.color), '#FB2C17');
      const routeId = group.routes.length === 1 && route.id ? `catalog-${route.id}` : '';
      const names = Array.from(new Set(group.routes.map((item) => item.nombre).filter(Boolean)));
      const title = names.join(' / ') || route.nombre;
      return `<span class="route-tag clickable" data-route-code="${escapeHTML(route.codigo)}" data-route-id="${escapeHTML(routeId)}" title="${escapeHTML(title)}" style="background:${color}; cursor:pointer;">${escapeHTML(route.codigo)}</span>`;
    })
    .join('');

  return hiddenCount > 0
    ? `${tags}<span class="route-tag muted">+${hiddenCount}</span>`
    : tags;
}

function sortCatalogRoutes(routes: CatalogRoute[]): CatalogRoute[] {
  return [...routes].sort((a, b) =>
    normalizeRouteCode(a.codigo).localeCompare(normalizeRouteCode(b.codigo), undefined, { numeric: true })
  );
}

// ─── Catalog Lookup ─────────────────────────────────────

let _catalog: MasterCatalog = { stations: {}, routes: {} };
let _resolvedStations: Record<string, ResolvedCatalogStation> = {};
let _stationAudit: StationCatalogAudit[] = [];

export function setCatalog(catalog: MasterCatalog): void {
  _catalog = catalog;
  _resolvedStations = {};
  _stationAudit = [];
}

export function getStationAudit(): StationCatalogAudit[] {
  return _stationAudit;
}

function publishStationAudit(): void {
  const total = _stationAudit.length;
  const unmatched = _stationAudit.filter((entry) => entry.matchMethod === 'unmatched').length;
  const verified = _stationAudit.filter((entry) => entry.matchMethod.startsWith('verified-split')).length;
  const platformClusters = _stationAudit.filter((entry) => entry.matchMethod.startsWith('platform-cluster')).length;

  if (typeof window !== 'undefined') {
    (window as Window & { __tmStationAudit?: StationCatalogAudit[] }).__tmStationAudit = _stationAudit;
  }

  console.info(
    `[Stations] Catalog audit: ${total - unmatched}/${total} matched, ` +
      `${verified} verified splits, ${platformClusters} platform clusters, ${unmatched} unmatched.`,
    _stationAudit
  );
}

// ─── Station Popup ──────────────────────────────────────

function hasRenderedFeatureAtPoint(
  map: maplibregl.Map,
  e: maplibregl.MapLayerMouseEvent,
  layerIds: string[]
): boolean {
  const existingLayers = layerIds.filter((id) => map.getLayer(id));
  return existingLayers.length > 0 && map.queryRenderedFeatures(e.point, { layers: existingLayers }).length > 0;
}

function showStationPopup(
  map: maplibregl.Map,
  e: maplibregl.MapLayerMouseEvent
): void {
  if (hasRenderedFeatureAtPoint(map, e, ['stops-hitbox'])) return;
  if (!markClickHandled(e)) return;
  const feature = e.features?.[0];
  if (!feature || !feature.properties) return;

  const p = feature.properties;
  const coords = (feature.geometry as GeoJSON.Point).coordinates;
  const stationCode = p.stationCode || '';
  const stationName = p.name || '';
  const stationKey = String(p.stationKey || stationCode);

  const resolvedStation = _resolvedStations[stationKey];

  // Build wagon sections
  let wagonSections = '';

  if (resolvedStation && Object.keys(resolvedStation.wagons).length > 0) {
    const wagonEntries = Object.entries(resolvedStation.wagons);

    // Sort wagon labels naturally (A, B, C... or T5A, T5B, T9...)
    wagonEntries.sort(([a], [b]) =>
      a.localeCompare(b, undefined, { numeric: true })
    );

    wagonSections = wagonEntries
      .map(([label, routes]) => {
        const tags = formatRouteTags(routes as CatalogRoute[]);
        const wagonName = label === '0' ? 'Vagón Único' : `Vagón ${escapeHTML(label)}`;
        return `
          <div class="popup-wagon-section">
            <div class="popup-wagon-label">${wagonName}</div>
            <div class="popup-route-tags">${tags}</div>
          </div>
        `;
      })
      .join('');
  } else {
    wagonSections = '<div class="popup-empty">Sin datos de vagones disponibles</div>';
  }

  // Station meta
  const meta = [
    p.location,
    p.wagons ? `${p.wagons} vagones` : '',
    p.bike ? `Biciparqueo (${p.bikeCapacity})` : '',
    p.wifi === 'SI' ? 'WiFi' : '',
  ].filter(Boolean);

  const html = `
    <div class="popup-card">
      <div class="popup-eyebrow">${escapeHTML(p.corridor)}</div>
      <div class="popup-title">${escapeHTML(stationName)}</div>
      ${meta.length ? `<div class="popup-meta">${meta.map((item) => `<span>${escapeHTML(item)}</span>`).join('')}</div>` : ''}
      <div class="popup-wagon-container">
        ${wagonSections}
      </div>
    </div>
  `;

  showPopup(map, coords as [number, number], html, { offset: 12, maxWidth: '340px' });
}

// ─── Layer Setup ────────────────────────────────────────

export function addStationsLayer(
  map: maplibregl.Map,
  stations: TroncalStationFeature[]
): void {
  globalStations = stations;
  const visibleStations = stations.filter(isVisibleTroncalStation);
  const resolution = resolveStationCatalog(visibleStations, _catalog);
  _resolvedStations = resolution.stationsByKey;
  _stationAudit = resolution.audit;
  publishStationAudit();

  const geojson: GeoJSON.FeatureCollection = {
    type: 'FeatureCollection',
    features: visibleStations.map((s) => ({
      type: 'Feature',
      properties: {
        stationKey: buildStationKey(s),
        name: s.attributes.nombre_estacion,
        stationCode: s.attributes.numero_estacion,
        stationNode: stationNode(s),
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
    id: 'stations-circle',
    type: 'symbol',
    source: 'stations',
    layout: {
      'icon-image': 'stop-red',
      'icon-size': ['interpolate', ['linear'], ['zoom'], 10, 0.5, 14, 0.65, 17, 0.85],
      'icon-allow-overlap': true,
      'icon-anchor': 'bottom',
    },
  });

  map.addLayer({
    id: 'stations-hitbox',
    type: 'circle',
    source: 'stations',
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 12, 14, 18, 17, 26],
      'circle-color': '#000000',
      'circle-opacity': 0,
    },
  });

  map.addLayer({
    id: 'stations-labels',
    type: 'symbol',
    source: 'stations',
    minzoom: 14,
    layout: {
      'text-field': ['get', 'name'],
      'text-font': ['Open Sans Bold'],
      'text-size': ['interpolate', ['linear'], ['zoom'], 14, 9, 17, 13],
      'text-offset': [0, 0.8],
      'text-anchor': 'top',
      'text-max-width': 10,
    },
    paint: {
      'text-color': '#FB2C17',
      'text-halo-color': '#0A0E17',
      'text-halo-width': 1.5,
      'text-opacity': ['interpolate', ['linear'], ['zoom'], 14, 0.6, 16, 1],
    },
  });

  map.on('click', 'stations-hitbox', (e) => showStationPopup(map, e));
  map.on('mouseenter', 'stations-hitbox', () => {
    map.getCanvas().style.cursor = 'pointer';
  });
  map.on('mouseleave', 'stations-hitbox', () => {
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

let globalStations: TroncalStationFeature[] = [];

export function showStationPopupByCode(map: maplibregl.Map, stationCode: string, coordinate: [number, number]): boolean {
  let resolvedStation: ResolvedCatalogStation | undefined;
  for (const station of Object.values(_resolvedStations)) {
    if (
      station.stationCode === stationCode ||
      station.stationKey === stationCode ||
      station.sourceStops.some(ss => ss.codigo === stationCode)
    ) {
      resolvedStation = station;
      break;
    }
  }

  if (!resolvedStation) return false;

  let wagonSections = '';

  if (Object.keys(resolvedStation.wagons).length > 0) {
    const wagonEntries = Object.entries(resolvedStation.wagons);
    wagonEntries.sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }));

    wagonSections = wagonEntries
      .map(([label, routes]) => {
        const tags = formatRouteTags(routes as CatalogRoute[]);
        const wagonName = label === '0' ? 'Vagón Único' : `Vagón ${escapeHTML(label)}`;
        return `
          <div class="popup-wagon-section">
            <div class="popup-wagon-label">${wagonName}</div>
            <div class="popup-route-tags">${tags}</div>
          </div>
        `;
      })
      .join('');
  } else {
    wagonSections = '<div class="popup-empty">Sin datos de vagones disponibles</div>';
  }

  const stationFeature = globalStations.find(s => 
    s.attributes.numero_estacion === stationCode ||
    s.attributes.codigo_nodo_estacion === stationCode ||
    normalizeStationName(s.attributes.nombre_estacion) === normalizeStationName(resolvedStation!.stationName)
  );

  const corridor = stationFeature?.attributes.troncal_estacion || 'Estación troncal';

  const firstSource = resolvedStation.sourceStops[0];
  const location = firstSource ? firstSource.direccion : '';

  const html = `
    <div class="popup-card">
      <div class="popup-eyebrow">${escapeHTML(corridor)}</div>
      <div class="popup-title">${escapeHTML(resolvedStation.stationName)}</div>
      ${location ? `<div class="popup-meta"><span>${escapeHTML(location)}</span></div>` : ''}
      <div class="popup-wagon-container">
        ${wagonSections}
      </div>
    </div>
  `;

  showPopup(map, coordinate, html, { offset: 12, maxWidth: '340px' });
  return true;
}
