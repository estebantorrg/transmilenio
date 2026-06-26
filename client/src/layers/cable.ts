import maplibregl from 'maplibre-gl';

const CABLE_LAYERS = [
  'cable-traces-line',
  'cable-stations-circle',
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
        name: t.attributes?.nom_traz || 'Trazado Cable',
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
        name: s.attributes?.nom_est || 'Estación de Cable',
        code: s.attributes?.cod_nodo,
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
    },
    paint: {
      'text-color': '#F97316', // Orange matching the theme
      'text-halo-color': '#0A0E17',
      'text-halo-width': 1.5,
      'text-opacity': ['interpolate', ['linear'], ['zoom'], 13, 0.6, 15, 1],
    },
  });
}

export function toggleCableLayers(map: maplibregl.Map, visible: boolean): void {
  const visibility = visible ? 'visible' : 'none';
  CABLE_LAYERS.forEach((id) => {
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
