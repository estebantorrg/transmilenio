/**
 * Zonal stop markers layer.
 * Renders zonal bus stops with actual names, addresses, and route info.
 */
import maplibregl from 'maplibre-gl';
import { markClickHandled } from './routes';
/**
 * Build a cenefa→routes lookup map from the paraderos_rutas API response.
 */
export function buildStopRoutesMap(stopRoutes) {
    const map = new Map();
    for (const sr of stopRoutes) {
        const cenefa = sr.attributes?.cenefa;
        const route = sr.attributes?.ruta;
        if (!cenefa || !route)
            continue;
        const existing = map.get(cenefa);
        if (existing) {
            // Avoid duplicates
            if (!existing.includes(route)) {
                existing.push(route);
            }
        }
        else {
            map.set(cenefa, [route]);
        }
    }
    return map;
}
export function addStopsLayer(map, stops, stopRoutesMap) {
    // Filter out features with no geometry
    const validStops = stops.filter(s => s.geometry && s.geometry.x && s.geometry.y);
    const geojson = {
        type: 'FeatureCollection',
        features: validStops.map((s) => {
            const a = s.attributes;
            const cenefa = a.cenefa || '';
            // Look up routes for this stop
            const routes = stopRoutesMap?.get(cenefa) ?? [];
            return {
                type: 'Feature',
                properties: {
                    id: a.objectid,
                    cenefa,
                    name: a.nombre || 'Paradero Zonal',
                    address: a.direccion_bandera || a.via || '',
                    locality: a.localidad || '',
                    zone: a.zona_sitp || '',
                    routes: JSON.stringify(routes),
                },
                geometry: {
                    type: 'Point',
                    coordinates: [s.geometry.x, s.geometry.y],
                },
            };
        }),
    };
    map.addSource('stops', { type: 'geojson', data: geojson });
    // Only show stops starting from zoom level 14 to avoid cluttering the map at city-level
    map.addLayer({
        id: 'stops-circle',
        type: 'circle',
        source: 'stops',
        minzoom: 14,
        paint: {
            'circle-radius': ['interpolate', ['linear'], ['zoom'], 14, 2, 17, 5, 20, 8],
            'circle-color': '#34D399', // tm-green
            'circle-stroke-color': '#0A0E17',
            'circle-stroke-width': 1,
            'circle-opacity': 0.8,
        },
    });
    // Stop labels (visible at higher zoom)
    map.addLayer({
        id: 'stops-labels',
        type: 'symbol',
        source: 'stops',
        minzoom: 15,
        layout: {
            'text-field': ['get', 'name'],
            'text-font': ['Open Sans Bold'],
            'text-size': ['interpolate', ['linear'], ['zoom'], 15, 8, 17, 11],
            'text-offset': [0, 1.4],
            'text-anchor': 'top',
            'text-max-width': 9,
        },
        paint: {
            'text-color': '#34D399',
            'text-halo-color': '#0A0E17',
            'text-halo-width': 1.5,
            'text-opacity': ['interpolate', ['linear'], ['zoom'], 15, 0.5, 16, 0.9],
        },
    });
    // Click popup
    map.on('click', 'stops-circle', (e) => {
        markClickHandled(e);
        const feature = e.features?.[0];
        if (!feature || !feature.properties)
            return;
        const p = feature.properties;
        const coords = feature.geometry.coordinates;
        // Parse routes list
        let routes = [];
        try {
            routes = JSON.parse(p.routes || '[]');
        }
        catch { /* empty */ }
        const routeTags = routes
            .map(r => `<span class="route-tag" style="background: rgba(56,189,248,0.2); color: #38BDF8; border: 1px solid rgba(56,189,248,0.3); font-size: 0.65rem; padding: 2px 6px; border-radius: 4px; font-weight: 600;">${r}</span>`)
            .join('');
        const html = `
      <div class="popup-station">
        <div class="popup-station-name">${p.name}</div>
        <div class="popup-station-corridor" style="color: #34D399">Paradero Zonal</div>
        <div class="popup-station-meta">
          ${p.cenefa ? `<span># ${p.cenefa}</span>` : ''}
          ${p.address ? `<span>📍 ${p.address}</span>` : ''}
          ${p.locality ? `<span>🏘️ ${p.locality}</span>` : ''}
        </div>
        ${routeTags ? `<div style="margin-top: 8px; display: flex; flex-wrap: wrap; gap: 4px;">${routeTags}</div>` : ''}
      </div>
    `;
        new maplibregl.Popup({ offset: 6, maxWidth: '280px' })
            .setLngLat(coords)
            .setHTML(html)
            .addTo(map);
    });
    // Cursor
    map.on('mouseenter', 'stops-circle', () => {
        map.getCanvas().style.cursor = 'pointer';
    });
    map.on('mouseleave', 'stops-circle', () => {
        map.getCanvas().style.cursor = '';
    });
}
export function toggleStopsLayer(map, visible) {
    const visibility = visible ? 'visible' : 'none';
    ['stops-circle', 'stops-labels'].forEach((id) => {
        if (map.getLayer(id)) {
            map.setLayoutProperty(id, 'visibility', visibility);
        }
    });
}
