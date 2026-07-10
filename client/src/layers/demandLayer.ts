import maplibregl from 'maplibre-gl';
import { showPopup } from './popup';
import { escapeHTML } from '../utils/html';
import type { StationDemand } from '../services/api';

/**
 * Renders per-station ridership as a graduated-circle heat overlay (spec §5.8,
 * open "Salidas" dataset). Independent of the resolved station layer — it draws
 * from the demand feed's own coordinates, so it never couples to (or can break)
 * station rendering. Off by default; toggled from the map filters.
 */
const DEMAND_LAYERS = ['demand-circle', 'demand-labels'];

const nf = new Intl.NumberFormat('es-CO');

export function addDemandLayer(map: maplibregl.Map, stations: StationDemand[]): void {
  const features = stations
    .filter((s) => Number.isFinite(s.lat) && Number.isFinite(s.lon))
    .map((s) => ({
      type: 'Feature' as const,
      properties: {
        nombre: s.nombre,
        total: s.total,
        entradas: s.entradas,
        salidas: s.salidas,
        rank: s.rank,
      },
      geometry: { type: 'Point' as const, coordinates: [s.lon, s.lat] },
    }));

  map.addSource('station-demand', {
    type: 'geojson',
    data: { type: 'FeatureCollection', features },
  });

  // Area-proportional radius: circle grows with daily footfall. The same total
  // stops are shared by radius and color so the two read consistently.
  map.addLayer({
    id: 'demand-circle',
    type: 'circle',
    source: 'station-demand',
    layout: { visibility: 'none' },
    paint: {
      'circle-radius': [
        'interpolate', ['linear'], ['get', 'total'],
        1500, 5,
        20000, 12,
        60000, 20,
        135000, 30,
      ],
      'circle-color': [
        'interpolate', ['linear'], ['get', 'total'],
        1500, '#22c55e',
        25000, '#eab308',
        70000, '#f97316',
        120000, '#ef4444',
      ],
      'circle-opacity': 0.55,
      'circle-stroke-width': 1,
      'circle-stroke-color': '#0A0E17',
      'circle-stroke-opacity': 0.6,
    },
  });

  map.addLayer({
    id: 'demand-labels',
    type: 'symbol',
    source: 'station-demand',
    minzoom: 12,
    layout: {
      'text-field': ['get', 'nombre'],
      'text-font': ['Open Sans Bold'],
      'text-size': ['interpolate', ['linear'], ['zoom'], 12, 9, 16, 13],
      'text-offset': [0, 1.2],
      'text-anchor': 'top',
      'text-max-width': 10,
      visibility: 'none',
    },
    paint: {
      'text-color': '#e2e8f0',
      'text-halo-color': '#0A0E17',
      'text-halo-width': 1.5,
      'text-opacity': ['interpolate', ['linear'], ['zoom'], 12, 0.6, 14, 1],
    },
  });

  map.on('click', 'demand-circle', (e) => {
    const feature = e.features?.[0];
    if (!feature || !feature.properties) return;
    const p = feature.properties as { nombre: string; total: number; entradas: number; salidas: number; rank: number };
    const coords = (feature.geometry as GeoJSON.Point).coordinates as [number, number];
    const html = `
      <div class="popup-card">
        <div class="popup-eyebrow" style="color:#f97316">Demanda · #${p.rank}</div>
        <div class="popup-title">${escapeHTML(p.nombre)}</div>
        <div class="popup-meta"><span>≈ ${nf.format(p.total)} validaciones/día</span></div>
        <div class="popup-meta"><span>Entradas ${nf.format(p.entradas)} · Salidas ${nf.format(p.salidas)}</span></div>
        <div class="popup-meta" style="opacity:.7"><span>Promedio de días hábiles (Salidas TMSA)</span></div>
      </div>`;
    showPopup(map, coords, html, { offset: 12, maxWidth: '280px' });
  });

  map.on('mouseenter', 'demand-circle', () => { map.getCanvas().style.cursor = 'pointer'; });
  map.on('mouseleave', 'demand-circle', () => { map.getCanvas().style.cursor = ''; });
}

export function toggleDemandLayer(map: maplibregl.Map, visible: boolean): void {
  const visibility = visible ? 'visible' : 'none';
  DEMAND_LAYERS.forEach((id) => {
    if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', visibility);
  });
}

export function bringDemandLayerToFront(map: maplibregl.Map): void {
  DEMAND_LAYERS.forEach((id) => {
    if (map.getLayer(id)) map.moveLayer(id);
  });
}
