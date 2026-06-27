import maplibregl from 'maplibre-gl';
import { showPopup } from './popup';
import { escapeHTML } from '../utils/html';

const CABLE_LAYERS = [
  'cable-traces-line',
  'cable-stations-circle',
  'cable-stations-hitbox',
  'cable-stations-labels',
];

export function addCableLayers(
  map: maplibregl.Map,
  stations: any[],
  traces: any[]
): void {
  // 1. Add Traces Source & Layer
  const traceFeatures = traces.map((t) => {
    return {
      type: 'Feature',
      properties: {
        id: t.attributes?.objectid,
        name: t.attributes?.nom_traz || 'Trazado TransMiCable',
        origin: t.attributes?.origen || '',
        destination: t.attributes?.destino || '',
      },
      geometry: {
        type: 'LineString',
        coordinates: t.geometry?.paths?.[0] || [],
      },
    };
  });

  const tracesGeojson: GeoJSON.FeatureCollection = {
    type: 'FeatureCollection',
    features: traceFeatures as any,
  };

  map.addSource('cable-traces', { type: 'geojson', data: tracesGeojson });

  map.addLayer({
    id: 'cable-traces-line',
    type: 'line',
    source: 'cable-traces',
    layout: {
      'line-join': 'round',
      'line-cap': 'round',
      'visibility': 'none',
    },
    paint: {
      'line-color': '#F97316', // Bright Orange
      'line-width': ['interpolate', ['linear'], ['zoom'], 10, 3, 14, 5, 17, 7],
      'line-opacity': 0.85,
    },
  });

  // 2. Add Stations Source & Layer
  const stationFeatures = stations.map((s) => {
    return {
      type: 'Feature',
      properties: {
        id: s.attributes?.objectid,
        name: s.attributes?.nom_est || 'Estación TransMiCable',
        code: s.attributes?.cod_nodo || '',
        number: s.attributes?.num_est,
      },
      geometry: {
        type: 'Point',
        coordinates: [s.geometry?.x, s.geometry?.y],
      },
    };
  });

  const stationsGeojson: GeoJSON.FeatureCollection = {
    type: 'FeatureCollection',
    features: stationFeatures as any,
  };

  map.addSource('cable-stations', { type: 'geojson', data: stationsGeojson });

  map.addLayer({
    id: 'cable-stations-circle',
    type: 'symbol',
    source: 'cable-stations',
    layout: {
      'icon-image': 'stop-orange',
      'icon-size': ['interpolate', ['linear'], ['zoom'], 10, 0.5, 14, 0.65, 17, 0.85],
      'icon-allow-overlap': true,
      'icon-anchor': 'bottom',
      'visibility': 'none',
    },
  });

  // Invisible hitbox for click detection
  map.addLayer({
    id: 'cable-stations-hitbox',
    type: 'circle',
    source: 'cable-stations',
    layout: { 'visibility': 'none' },
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 12, 14, 18, 17, 26],
      'circle-color': '#000000',
      'circle-opacity': 0,
    },
  });

  map.addLayer({
    id: 'cable-stations-labels',
    type: 'symbol',
    source: 'cable-stations',
    minzoom: 13,
    layout: {
      'text-field': ['get', 'name'],
      'text-font': ['Open Sans Bold'],
      'text-size': ['interpolate', ['linear'], ['zoom'], 14, 9, 17, 13],
      'text-offset': [0, 0.8],
      'text-anchor': 'top',
      'text-max-width': 10,
      'visibility': 'none',
    },
    paint: {
      'text-color': '#F97316', // Orange matching the theme
      'text-halo-color': '#0A0E17',
      'text-halo-width': 1.5,
      'text-opacity': ['interpolate', ['linear'], ['zoom'], 13, 0.6, 15, 1],
    },
  });

  // 3. Click handler — show station popup
  map.on('click', 'cable-stations-hitbox', (e) => {
    const feature = e.features?.[0];
    if (!feature || !feature.properties) return;

    const p = feature.properties;
    const coords = (feature.geometry as GeoJSON.Point).coordinates as [number, number];

    const html = `
      <div class="popup-card">
        <div class="popup-eyebrow">TransMiCable</div>
        <div class="popup-title">${escapeHTML(p.name)}</div>
        ${p.code ? `<div class="popup-meta"><span>${escapeHTML(p.code)}</span></div>` : ''}
        <div class="popup-cable-info">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#F97316" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0">
            <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
          </svg>
          <span>Las cabinas pasan aproximadamente cada 20 segundos, tanto para subir como para bajar.</span>
        </div>
      </div>
    `;

    showPopup(map, coords, html, { offset: 12, maxWidth: '300px' });
  });

  map.on('mouseenter', 'cable-stations-hitbox', () => {
    map.getCanvas().style.cursor = 'pointer';
  });
  map.on('mouseleave', 'cable-stations-hitbox', () => {
    map.getCanvas().style.cursor = '';
  });
}

export function toggleCableLayers(map: maplibregl.Map, visible: boolean): void {
  const visibility = visible ? 'visible' : 'none';
  if (map.getLayer('cable-traces-line')) {
    map.setLayoutProperty('cable-traces-line', 'visibility', visibility);
  }
}

export function toggleCableStationsLayer(map: maplibregl.Map, visible: boolean): void {
  const visibility = visible ? 'visible' : 'none';
  const stationLayers = [
    'cable-stations-circle',
    'cable-stations-hitbox',
    'cable-stations-labels',
  ];
  stationLayers.forEach((id) => {
    if (map.getLayer(id)) {
      map.setLayoutProperty(id, 'visibility', visibility);
    }
  });
}

export function bringCableLayersToFront(map: maplibregl.Map): void {
  CABLE_LAYERS.forEach((id) => {
    if (map.getLayer(id)) {
      map.moveLayer(id);
    }
  });
}
