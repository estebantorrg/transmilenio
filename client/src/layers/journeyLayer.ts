import maplibregl from 'maplibre-gl';
import type { JourneyPlan } from '../services/router';
import { getRouteAccentColor } from '../utils/routeColors';
import type { RouteListItem } from '../types/transmilenio';

const JOURNEY_LAYERS = [
  'journey-path-glow',
  'journey-path-casing',
  'journey-path-line',
  'journey-walk-glow',
  'journey-walk-casing',
  'journey-walk-line',
  'journey-stops-glow',
  'journey-stops-circle',
  'journey-stops-labels',
];

/**
 * Adds the journey sources and layers to the map (initially empty).
 */
export function addJourneyLayer(map: maplibregl.Map): void {
  if (map.getSource('journey-path')) return;

  // Transit path source
  map.addSource('journey-path', {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: [] },
  });

  // Walking path source (separate to avoid dasharray expression issues)
  map.addSource('journey-walk', {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: [] },
  });

  // Stops source
  map.addSource('journey-stops', {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: [] },
  });

  const beforeId = map.getLayer('stations-circle') ? 'stations-circle' : undefined;

  // ── Transit path layers (3-layer glow stack) ──

  // Outer glow (wide, blurred, colored)
  map.addLayer({
    id: 'journey-path-glow',
    type: 'line',
    source: 'journey-path',
    filter: ['==', ['get', 'type'], 'ride'],
    layout: {
      'line-cap': 'round',
      'line-join': 'round',
      'visibility': 'none',
    },
    paint: {
      'line-color': ['get', 'color'],
      'line-width': ['interpolate', ['linear'], ['zoom'], 10, 14, 14, 22, 17, 30],
      'line-opacity': 0.18,
      'line-blur': ['interpolate', ['linear'], ['zoom'], 10, 6, 14, 10, 17, 14],
    },
  }, beforeId);

  // Dark casing
  map.addLayer({
    id: 'journey-path-casing',
    type: 'line',
    source: 'journey-path',
    filter: ['==', ['get', 'type'], 'ride'],
    layout: {
      'line-cap': 'round',
      'line-join': 'round',
      'visibility': 'none',
    },
    paint: {
      'line-color': '#050812',
      'line-width': ['interpolate', ['linear'], ['zoom'], 10, 6, 14, 10, 17, 14],
      'line-opacity': 0.85,
    },
  }, beforeId);

  // Core colored line
  map.addLayer({
    id: 'journey-path-line',
    type: 'line',
    source: 'journey-path',
    filter: ['==', ['get', 'type'], 'ride'],
    layout: {
      'line-cap': 'round',
      'line-join': 'round',
      'visibility': 'none',
    },
    paint: {
      'line-color': ['get', 'color'],
      'line-width': ['interpolate', ['linear'], ['zoom'], 10, 3.5, 14, 5.5, 17, 8],
    },
  }, beforeId);

  // ── Walking path layers (3-layer glow stack, dashed) ──

  // Outer glow for walking
  map.addLayer({
    id: 'journey-walk-glow',
    type: 'line',
    source: 'journey-walk',
    layout: {
      'line-cap': 'round',
      'line-join': 'round',
      'visibility': 'none',
    },
    paint: {
      'line-color': '#38BDF8',
      'line-width': ['interpolate', ['linear'], ['zoom'], 10, 12, 14, 18, 17, 24],
      'line-opacity': 0.12,
      'line-blur': ['interpolate', ['linear'], ['zoom'], 10, 5, 14, 8, 17, 12],
    },
  }, beforeId);

  // Casing for walking
  map.addLayer({
    id: 'journey-walk-casing',
    type: 'line',
    source: 'journey-walk',
    layout: {
      'line-cap': 'round',
      'line-join': 'round',
      'visibility': 'none',
    },
    paint: {
      'line-color': '#0C1425',
      'line-width': ['interpolate', ['linear'], ['zoom'], 10, 5, 14, 8, 17, 11],
      'line-opacity': 0.7,
      'line-dasharray': [2, 2],
    },
  }, beforeId);

  // Core dashed line for walking
  map.addLayer({
    id: 'journey-walk-line',
    type: 'line',
    source: 'journey-walk',
    layout: {
      'line-cap': 'round',
      'line-join': 'round',
      'visibility': 'none',
    },
    paint: {
      'line-color': '#38BDF8',
      'line-width': ['interpolate', ['linear'], ['zoom'], 10, 2.5, 14, 4, 17, 6],
      'line-dasharray': [2, 2],
    },
  }, beforeId);

  // ── Stop marker layers ──

  // Outer glow for stops
  map.addLayer({
    id: 'journey-stops-glow',
    type: 'circle',
    source: 'journey-stops',
    layout: { 'visibility': 'none' },
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 10, 14, 14, 17, 18],
      'circle-color': ['get', 'color'],
      'circle-opacity': 0.35,
      'circle-blur': 0.6,
    },
  });

  // Core circle for stops
  map.addLayer({
    id: 'journey-stops-circle',
    type: 'circle',
    source: 'journey-stops',
    layout: { 'visibility': 'none' },
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 5, 14, 7.5, 17, 10],
      'circle-color': ['get', 'color'],
      'circle-stroke-color': '#FFFFFF',
      'circle-stroke-width': 2.5,
    },
  });

  // Labels for stops
  map.addLayer({
    id: 'journey-stops-labels',
    type: 'symbol',
    source: 'journey-stops',
    layout: {
      'text-field': ['get', 'label'],
      'text-font': ['Open Sans Bold'],
      'text-size': ['interpolate', ['linear'], ['zoom'], 10, 9, 14, 11, 17, 13],
      'text-offset': [0, -1.6],
      'text-anchor': 'bottom',
      'text-allow-overlap': true,
      'visibility': 'none',
    },
    paint: {
      'text-color': '#FFFFFF',
      'text-halo-color': '#050812',
      'text-halo-width': 2,
    },
  });
}

/**
 * Per-segment color palette for distinct tramos.
 * Each ride segment gets a unique vibrant color from this palette.
 */
const TRAMO_COLORS = [
  '#FF6B6B', // coral red
  '#4ECDC4', // teal
  '#FFD93D', // golden yellow
  '#6C5CE7', // purple
  '#00B894', // mint green
  '#FD79A8', // pink
  '#0984E3', // blue
  '#E17055', // burnt orange
  '#00CEC9', // cyan
  '#A29BFE', // lavender
];

/**
 * Returns the hex color for a route code, or picks from tramo palette.
 */
function getRouteColorHex(routeCode: string, routeType?: 'troncal' | 'zonal'): string {
  if (routeCode === 'walking') return '#38BDF8';

  const dummyRoute: Partial<RouteListItem> = {
    code: routeCode,
    type: routeType || 'troncal',
  };
  return getRouteAccentColor(dummyRoute as RouteListItem);
}

/**
 * Assigns distinct colors to each ride segment, using route accent color
 * but falling back to palette if multiple segments share the same route color.
 */
export function assignSegmentColors(plan: JourneyPlan): string[] {
  const colors: string[] = [];
  const usedColors = new Set<string>();
  let paletteIdx = 0;

  for (const step of plan.steps) {
    if (step.type === 'walk') {
      colors.push('#38BDF8');
      continue;
    }

    let color = getRouteColorHex(step.routeCode || '', step.routeType);

    // If this color is already used by a previous ride segment, pick from palette
    if (usedColors.has(color)) {
      color = TRAMO_COLORS[paletteIdx % TRAMO_COLORS.length];
      paletteIdx++;
    }

    usedColors.add(color);
    colors.push(color);
  }

  return colors;
}

/**
 * Draws the selected journey plan path on the map.
 */
export function drawJourneyPath(map: maplibregl.Map, plan: JourneyPlan): void {
  addJourneyLayer(map);

  const pathSource = map.getSource('journey-path') as maplibregl.GeoJSONSource;
  const walkSource = map.getSource('journey-walk') as maplibregl.GeoJSONSource;
  const stopsSource = map.getSource('journey-stops') as maplibregl.GeoJSONSource;
  if (!pathSource || !walkSource || !stopsSource) return;

  const transitFeatures: GeoJSON.Feature[] = [];
  const walkFeatures: GeoJSON.Feature[] = [];
  const stopFeatures: GeoJSON.Feature[] = [];

  // Assign distinct colors per segment
  const segmentColors = assignSegmentColors(plan);

  // 1. Compile path segments into separate sources
  plan.steps.forEach((step, index) => {
    if (!step.path || step.path.length < 2) return;

    const color = segmentColors[index];
    const feature: GeoJSON.Feature = {
      type: 'Feature',
      properties: {
        type: step.type,
        color,
        routeCode: step.routeCode || 'walk',
        index,
      },
      geometry: {
        type: 'LineString',
        coordinates: step.path,
      },
    };

    if (step.type === 'walk') {
      walkFeatures.push(feature);
    } else {
      transitFeatures.push(feature);
    }
  });

  // 2. Compile stop markers with clear boarding/alighting labels
  const firstStep = plan.steps[0];
  if (firstStep?.path?.length) {
    stopFeatures.push({
      type: 'Feature',
      properties: {
        kind: 'start',
        label: 'Origen',
        color: '#10B981',
      },
      geometry: {
        type: 'Point',
        coordinates: firstStep.path[0],
      },
    });
  }

  const lastStep = plan.steps[plan.steps.length - 1];
  if (lastStep?.path?.length) {
    stopFeatures.push({
      type: 'Feature',
      properties: {
        kind: 'end',
        label: 'Destino',
        color: '#EF4444',
      },
      geometry: {
        type: 'Point',
        coordinates: lastStep.path[lastStep.path.length - 1],
      },
    });
  }

  // Intermediate boarding, alighting, and transfer markers
  for (let i = 0; i < plan.steps.length; i++) {
    const step = plan.steps[i];
    const prevStep = i > 0 ? plan.steps[i - 1] : null;
    const nextStep = i < plan.steps.length - 1 ? plan.steps[i + 1] : null;

    if (step.type === 'ride' && step.path && step.path.length > 0) {
      const color = segmentColors[i];

      // Boarding marker at start of this ride (unless it's the very first step = origin)
      if (i > 0) {
        stopFeatures.push({
          type: 'Feature',
          properties: {
            kind: 'board',
            label: `Subir a ${step.routeCode}`,
            color,
          },
          geometry: {
            type: 'Point',
            coordinates: step.path[0],
          },
        });
      }

      // Alighting marker at end of this ride (unless it's the very last step = destination)
      if (i < plan.steps.length - 1) {
        const alightLabel = nextStep?.type === 'ride'
          ? `Transferir a ${nextStep.routeCode}`
          : `Bajar de ${step.routeCode}`;
        const alightColor = nextStep?.type === 'ride' ? '#F59E0B' : color;

        stopFeatures.push({
          type: 'Feature',
          properties: {
            kind: nextStep?.type === 'ride' ? 'transfer' : 'alight',
            label: alightLabel,
            color: alightColor,
          },
          geometry: {
            type: 'Point',
            coordinates: step.path[step.path.length - 1],
          },
        });
      }
    }
  }

  // Update sources
  pathSource.setData({
    type: 'FeatureCollection',
    features: transitFeatures,
  });

  walkSource.setData({
    type: 'FeatureCollection',
    features: walkFeatures,
  });

  stopsSource.setData({
    type: 'FeatureCollection',
    features: stopFeatures,
  });

  // Make layers visible
  JOURNEY_LAYERS.forEach((id) => {
    if (map.getLayer(id)) {
      map.setLayoutProperty(id, 'visibility', 'visible');
    }
  });

  // Dim background layers
  if (map.getLayer('troncal-corridors-line')) map.setPaintProperty('troncal-corridors-line', 'line-opacity', 0.08);
  if (map.getLayer('troncal-corridors-casing')) map.setPaintProperty('troncal-corridors-casing', 'line-opacity', 0.04);
  if (map.getLayer('troncal-corridors-labels')) map.setPaintProperty('troncal-corridors-labels', 'text-opacity', 0.08);

  if (map.getLayer('zonal-routes-line')) map.setPaintProperty('zonal-routes-line', 'line-opacity', 0.02);
  if (map.getLayer('zonal-routes-casing')) map.setPaintProperty('zonal-routes-casing', 'line-opacity', 0.01);
  if (map.getLayer('zonal-routes-glow')) map.setPaintProperty('zonal-routes-glow', 'line-opacity', 0);

  if (map.getLayer('stations-circle')) map.setPaintProperty('stations-circle', 'icon-opacity', 0.2);
  if (map.getLayer('stations-labels')) map.setPaintProperty('stations-labels', 'text-opacity', 0.15);
  if (map.getLayer('stops-circle')) map.setPaintProperty('stops-circle', 'icon-opacity', 0.2);
  if (map.getLayer('stops-labels')) map.setPaintProperty('stops-labels', 'text-opacity', 0.15);

  // Bring journey layers to front
  JOURNEY_LAYERS.forEach((id) => {
    if (map.getLayer(id)) map.moveLayer(id);
  });
}

/**
 * Clears the journey path from the map and restores background layers opacity.
 */
export function clearJourneyPath(map: maplibregl.Map): void {
  // Hide layers
  JOURNEY_LAYERS.forEach((id) => {
    if (map.getLayer(id)) {
      map.setLayoutProperty(id, 'visibility', 'none');
    }
  });

  const pathSource = map.getSource('journey-path') as maplibregl.GeoJSONSource;
  const walkSource = map.getSource('journey-walk') as maplibregl.GeoJSONSource;
  const stopsSource = map.getSource('journey-stops') as maplibregl.GeoJSONSource;
  if (pathSource) pathSource.setData({ type: 'FeatureCollection', features: [] });
  if (walkSource) walkSource.setData({ type: 'FeatureCollection', features: [] });
  if (stopsSource) stopsSource.setData({ type: 'FeatureCollection', features: [] });

  // Restore opacity for background layers
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
}
