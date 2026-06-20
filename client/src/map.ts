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
    // Vector tile style — dark map for high contrast
    style: 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json',
    center: [-74.1071, 4.6486], // Bogotá center
    zoom: 12,
    minZoom: 11, // Restrict zoom out to prevent viewport exceeding maxBounds (avoids jitter bugs)
    maxZoom: 18,
    pitch: 0,
    bearing: 0,
    antialias: true,
    maxBounds: [
      [-74.45, 4.2], // Southwest coordinates (buffered to prevent viewport collision glitches)
      [-73.75, 5.0], // Northeast coordinates
    ],
  });

  // Navigation controls (zoom + compass) — top right
  map.addControl(new maplibregl.NavigationControl({ showCompass: true }), 'top-right');

  // Scale bar
  map.addControl(new maplibregl.ScaleControl({ maxWidth: 150, unit: 'metric' }), 'bottom-right');

  // Update the global --tm-scale variable so popups can physical-dimension scale with the map without breaking MapLibre anchor translate math
  const updateScale = () => {
    const z = map.getZoom();
    // Proportional curve: Zoom 10 -> 0.65x, Zoom 14 -> 0.85x, Zoom 16 -> 1.0x, Zoom 18 -> 1.15x
    let s = 1.0;
    if (z <= 12) s = 0.65;
    else if (z <= 14) s = 0.65 + (0.85 - 0.65) * ((z - 12) / 2);
    else if (z <= 16) s = 0.85 + (1.0 - 0.85) * ((z - 14) / 2);
    else s = 1.0 + (1.15 - 1.0) * ((Math.min(z, 18) - 16) / 2);
    map.getContainer().style.setProperty('--tm-scale', s.toFixed(3));
  };
  map.on('load', updateScale);
  map.on('zoom', updateScale);

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
