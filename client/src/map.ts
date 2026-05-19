/**
 * MapLibre GL JS initialization.
 * Dark basemap centered on Bogotá.
 */

import maplibregl from 'maplibre-gl';

// We import the CSS from the npm package
import 'maplibre-gl/dist/maplibre-gl.css';

export function createMap(container: string): maplibregl.Map {
  const map = new maplibregl.Map({
    container,
    // Dark tile style — using CartoCDN's dark_all basemap (free, no API key)
    style: {
      version: 8,
      name: 'Dark Basemap',
      sources: {
        'carto-dark': {
          type: 'raster',
          tiles: [
            'https://a.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png',
            'https://b.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png',
            'https://c.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png',
          ],
          tileSize: 256,
          attribution: '&copy; <a href="https://carto.com/attributions">CARTO</a> &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
        },
      },
      layers: [
        {
          id: 'carto-dark-layer',
          type: 'raster',
          source: 'carto-dark',
          minzoom: 0,
          maxzoom: 20,
        },
      ],
      glyphs: 'https://fonts.openmaptiles.org/{fontstack}/{range}.pbf',
    },
    center: [-74.1071, 4.6486], // Bogotá center
    zoom: 12,
    minZoom: 9,
    maxZoom: 18,
    pitch: 0,
    bearing: 0,
    antialias: true,
  });

  // Navigation controls (zoom + compass) — top right
  map.addControl(new maplibregl.NavigationControl({ showCompass: true }), 'top-right');

  // Scale bar
  map.addControl(new maplibregl.ScaleControl({ maxWidth: 150, unit: 'metric' }), 'bottom-right');

  return map;
}

/**
 * Loads custom marker images into the map style.
 */
export async function initMapImages(map: maplibregl.Map): Promise<void> {
  const images = [
    { name: 'stop-red', url: '/icons/stop-red.png' },
    { name: 'stop-blue', url: '/icons/stop-blue.png' },
  ];

  await Promise.all(
    images.map(
      (img) =>
        new Promise<void>((resolve) => {
          const timeout = setTimeout(() => {
            console.warn(`[Map] Loading image timed out: ${img.name}`);
            resolve();
          }, 2000);

          (map as any).loadImage(img.url, (error: any, image: any) => {
            clearTimeout(timeout);
            if (error) {
              console.error(`[Map] Failed to load image: ${img.name}`, error);
              resolve(); 
              return;
            }
            if (image && !map.hasImage(img.name)) {
              map.addImage(img.name, image);
            }
            resolve();
          });
        })
    )
  );
  console.log('✅ Custom marker images loaded.');
}
