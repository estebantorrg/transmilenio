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
    // Dark tile style — using Esri Dark Gray Canvas (dark gray, high contrast for routes)
    style: {
      version: 8,
      name: 'Dark Basemap',
      sources: {
        'esri-dark': {
          type: 'raster',
          tiles: [
            'https://services.arcgisonline.com/arcgis/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}'
          ],
          tileSize: 256,
          attribution: '&copy; <a href="https://www.esri.com">Esri</a>, HERE, Garmin, FAO, NOAA, USGS, EPA',
        },
      },
      layers: [
        {
          id: 'carto-dark-layer',
          type: 'raster',
          source: 'esri-dark',
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
 * Creates a high-fidelity pin marker icon using HTML5 Canvas.
 */
function createMarkerIcon(color: string): HTMLCanvasElement {
  const size = 64; // High-res
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;

  // 1. Shadow (subtle)
  ctx.shadowColor = 'rgba(0, 0, 0, 0.4)';
  ctx.shadowBlur = 6;
  ctx.shadowOffsetY = 2;

  // 2. Draw Pin Shape
  ctx.beginPath();
  ctx.fillStyle = color;
  const centerX = size / 2;
  const centerY = size / 2 - 4;
  const radius = size / 3.5;
  
  // Teardrop shape
  ctx.arc(centerX, centerY, radius, Math.PI * 0.8, Math.PI * 0.2, true);
  ctx.lineTo(centerX, size - 4);
  ctx.closePath();
  ctx.fill();

  // 3. Inner White Circle
  ctx.shadowBlur = 0;
  ctx.shadowOffsetY = 0;
  ctx.beginPath();
  ctx.fillStyle = '#FFFFFF';
  ctx.arc(centerX, centerY, radius * 0.45, 0, Math.PI * 2);
  ctx.fill();

  // 4. White Border
  ctx.strokeStyle = '#FFFFFF';
  ctx.lineWidth = 2.5;
  ctx.stroke();

  return canvas;
}

/**
 * Loads custom marker images into the map style.
 */
export async function initMapImages(map: maplibregl.Map): Promise<void> {
  const iconDefinitions = [
    { name: 'stop-red', color: '#EF4444' },
    { name: 'stop-blue', color: '#3B82F6' },
  ];

  for (const def of iconDefinitions) {
    if (!map.hasImage(def.name)) {
      const canvas = createMarkerIcon(def.color);
      const imageData = ctxToImageData(canvas);
      if (imageData) {
        map.addImage(def.name, imageData);
      }
    }
  }

  console.log('✅ Custom marker icons generated and loaded.');
}

function ctxToImageData(canvas: HTMLCanvasElement): ImageData | null {
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  return ctx.getImageData(0, 0, canvas.width, canvas.height);
}
