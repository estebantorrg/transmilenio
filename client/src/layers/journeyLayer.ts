import maplibregl from 'maplibre-gl';
import type { JourneyPlan } from '../services/router';
import { getRouteAccentColor } from '../utils/routeColors';
import type { RouteListItem } from '../types/transmilenio';

const JOURNEY_LAYERS = [
  'journey-path-casing',
  'journey-path-line',
  'journey-stops-glow',
  'journey-stops-circle',
  'journey-stops-labels'
];

/**
 * Adds the journey sources and layers to the map (initially empty).
 */
export function addJourneyLayer(map: maplibregl.Map): void {
  if (map.getSource('journey-path')) return;

  // Path source
  map.addSource('journey-path', {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: [] },
  });

  // Stops source
  map.addSource('journey-stops', {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: [] },
  });

  const beforeId = map.getLayer('stations-circle') ? 'stations-circle' : undefined;

  // Casing layer for path line
  map.addLayer({
    id: 'journey-path-casing',
    type: 'line',
    source: 'journey-path',
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

  // Core path line layer
  map.addLayer({
    id: 'journey-path-line',
    type: 'line',
    source: 'journey-path',
    layout: {
      'line-cap': 'round',
      'line-join': 'round',
      'visibility': 'none',
    },
    paint: {
      'line-color': ['get', 'color'],
      'line-width': ['interpolate', ['linear'], ['zoom'], 10, 3.5, 14, 5.5, 17, 8],
      // Dotted line for walking segments, solid for riding
      'line-dasharray': [
        'case',
        ['==', ['get', 'type'], 'walk'],
        ['literal', [1.5, 1.5]],
        ['literal', [1, 0]],
      ],
    },
  }, beforeId);

  // Outer glow for stops
  map.addLayer({
    id: 'journey-stops-glow',
    type: 'circle',
    source: 'journey-stops',
    layout: { 'visibility': 'none' },
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 8, 14, 12, 17, 16],
      'circle-color': ['get', 'color'],
      'circle-opacity': 0.3,
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
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 4.5, 14, 7, 17, 9],
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
      'text-offset': [0, -1.4],
      'text-anchor': 'bottom',
      'text-allow-overlap': false,
      'visibility': 'none',
    },
    paint: {
      'text-color': '#FFFFFF',
      'text-halo-color': '#050812',
      'text-halo-width': 1.8,
    },
  });
}

/**
 * Returns the hex color for a route code.
 */
function getRouteColorHex(routeCode: string, routeType?: 'troncal' | 'zonal'): string {
  if (routeCode === 'walking') return '#94A3B8'; // Slate gray
  
  // Create dummy RouteListItem to resolve color
  const dummyRoute: Partial<RouteListItem> = {
    code: routeCode,
    type: routeType || 'troncal',
  };
  return getRouteAccentColor(dummyRoute as RouteListItem);
}

/**
 * Draws the selected journey plan path on the map.
 */
export function drawJourneyPath(map: maplibregl.Map, plan: JourneyPlan): void {
  addJourneyLayer(map); // Safety check

  const pathSource = map.getSource('journey-path') as maplibregl.GeoJSONSource;
  const stopsSource = map.getSource('journey-stops') as maplibregl.GeoJSONSource;
  if (!pathSource || !stopsSource) return;

  const pathFeatures: GeoJSON.Feature[] = [];
  const stopFeatures: GeoJSON.Feature[] = [];

  // 1. Compile path segments
  plan.steps.forEach((step, index) => {
    if (step.path && step.path.length >= 2) {
      const color = step.type === 'walk' ? '#38BDF8' : getRouteColorHex(step.routeCode || '', step.routeType);
      
      pathFeatures.push({
        type: 'Feature',
        properties: {
          type: step.type,
          color,
          routeCode: step.routeCode || 'walk',
        },
        geometry: {
          type: 'LineString',
          coordinates: step.path,
        },
      });
    }
  });

  // 2. Compile stop markers
  // Origin Stop (first step start point)
  const firstStep = plan.steps[0];
  if (firstStep && firstStep.path && firstStep.path.length > 0) {
    stopFeatures.push({
      type: 'Feature',
      properties: {
        kind: 'start',
        label: 'Origen',
        color: '#10B981', // Emerald green
      },
      geometry: {
        type: 'Point',
        coordinates: firstStep.path[0],
      },
    });
  }

  // Destination Stop (last step end point)
  const lastStep = plan.steps[plan.steps.length - 1];
  if (lastStep && lastStep.path && lastStep.path.length > 0) {
    stopFeatures.push({
      type: 'Feature',
      properties: {
        kind: 'end',
        label: 'Destino',
        color: '#EF4444', // Red
      },
      geometry: {
        type: 'Point',
        coordinates: lastStep.path[lastStep.path.length - 1],
      },
    });
  }

  // Intermediate transfer stops
  for (let i = 0; i < plan.steps.length - 1; i++) {
    const currentStep = plan.steps[i];
    const nextStep = plan.steps[i + 1];

    if (currentStep.path && currentStep.path.length > 0 && nextStep.path && nextStep.path.length > 0) {
      const coord = currentStep.path[currentStep.path.length - 1];
      
      // If transferring from ride -> ride, or walk -> ride
      if (currentStep.type !== nextStep.type || (currentStep.type === 'ride' && currentStep.routeCode !== nextStep.routeCode)) {
        stopFeatures.push({
          type: 'Feature',
          properties: {
            kind: 'transfer',
            label: nextStep.type === 'ride' ? `Subir a ${nextStep.routeCode}` : 'Bajar y caminar',
            color: '#F59E0B', // Amber orange
          },
          geometry: {
            type: 'Point',
            coordinates: coord,
          },
        });
      }
    }
  }

  // Update sources
  pathSource.setData({
    type: 'FeatureCollection',
    features: pathFeatures,
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

  // Dim background layers to pop out the journey path (similar to highlightRoute)
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
  const stopsSource = map.getSource('journey-stops') as maplibregl.GeoJSONSource;
  if (pathSource) pathSource.setData({ type: 'FeatureCollection', features: [] });
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
