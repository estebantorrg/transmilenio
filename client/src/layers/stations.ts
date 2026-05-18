/**
 * Troncal station layer — simplified.
 *
 * Renders stations as circles/labels. On click, shows a premium popup
 * with wagon → route data sourced from the TransMi app master catalog.
 * No more polygon rendering or geometric route guessing.
 */

import maplibregl from 'maplibre-gl';
import type { TroncalStationFeature } from '../types/transmilenio';
import { getTroncalColor, markClickHandled, normalizeRouteCode } from './routes';
import { showPopup } from './popup';
import { escapeHTML, safeColor } from '../utils/html';
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
  'stations-glow',
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

function formatRouteTags(routes: CatalogRoute[], limit = 28): string {
  const visibleRoutes = routes.slice(0, limit);
  const hiddenCount = routes.length - visibleRoutes.length;
  const tags = visibleRoutes
    .map((route) => {
      const color = safeColor(route.color || getTroncalColor(route.codigo), '#FB2C17');
      return `<span class="route-tag" style="background:${color};">${escapeHTML(route.codigo)}</span>`;
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
        const sorted = sortCatalogRoutes(routes as CatalogRoute[]);
        const tags = formatRouteTags(sorted);
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
