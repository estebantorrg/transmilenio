/**
 * Station markers layer.
 * Renders Troncal stations as interactive markers on the map.
 */
import maplibregl from 'maplibre-gl';
import * as turf from '@turf/turf';
import { markClickHandled } from './routes';
export function addStationsLayer(map, stations, routes = []) {
    // Convert to GeoJSON
    const geojson = {
        type: 'FeatureCollection',
        features: stations.map((s) => ({
            type: 'Feature',
            properties: {
                name: s.attributes.nombre_estacion,
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
    // Add source
    map.addSource('stations', { type: 'geojson', data: geojson });
    // Outer glow ring
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
    // Main circle
    map.addLayer({
        id: 'stations-circle',
        type: 'circle',
        source: 'stations',
        paint: {
            'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 3, 14, 7, 17, 12],
            'circle-color': '#FBBF24',
            'circle-stroke-color': '#0A0E17',
            'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 10, 1, 14, 2],
            'circle-opacity': 0.9,
        },
    });
    // Station labels (visible at higher zoom)
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
    // Click popup
    map.on('click', 'stations-circle', (e) => {
        markClickHandled(e);
        const feature = e.features?.[0];
        if (!feature || !feature.properties)
            return;
        const p = feature.properties;
        const coords = feature.geometry.coordinates;
        const bikeInfo = p.bike
            ? `<span>🚲 Biciparqueo (${p.bikeCapacity})</span>`
            : '';
        const wifiInfo = p.wifi === 'SI' ? '<span>📶 WiFi</span>' : '';
        const wagonsInfo = p.wagons ? `<span>🚉 ${p.wagons} Vagones</span>` : '';
        // Calculate intersecting routes
        const stationPoint = turf.point(coords);
        const passingRoutes = new Set();
        routes.forEach(route => {
            const paths = route.geometry?.paths;
            if (!paths)
                return;
            for (const path of paths) {
                if (path.length < 2)
                    continue;
                const line = turf.lineString(path);
                // Measure distance in meters
                const distance = turf.pointToLineDistance(stationPoint, line, { units: 'meters' });
                // If route passes within 40 meters of station point, it likely stops or passes there
                if (distance < 40) {
                    passingRoutes.add(route.attributes.route_name_ruta_troncal);
                    break;
                }
            }
        });
        const routeTags = Array.from(passingRoutes)
            .map(r => `<span class="route-tag" style="background: var(--tm-red); font-size: 0.65rem; padding: 2px 6px;">${r}</span>`)
            .join('');
        const html = `
      <div class="popup-station">
        <div class="popup-station-name">${p.name}</div>
        <div class="popup-station-corridor">${p.corridor}</div>
        <div class="popup-station-meta">
          <span>📍 ${p.location}</span>
          ${wagonsInfo}
          ${bikeInfo}
          ${wifiInfo}
        </div>
        ${routeTags ? `<div class="popup-station-routes" style="margin-top: 8px; display: flex; flex-wrap: wrap; gap: 4px;">${routeTags}</div>` : ''}
      </div>
    `;
        new maplibregl.Popup({ offset: 12, maxWidth: '280px' })
            .setLngLat(coords)
            .setHTML(html)
            .addTo(map);
    });
    // Cursor
    map.on('mouseenter', 'stations-circle', () => {
        map.getCanvas().style.cursor = 'pointer';
    });
    map.on('mouseleave', 'stations-circle', () => {
        map.getCanvas().style.cursor = '';
    });
}
export function toggleStationsLayer(map, visible) {
    const visibility = visible ? 'visible' : 'none';
    ['stations-glow', 'stations-circle', 'stations-labels', 'wagons-fill', 'wagons-line'].forEach((id) => {
        if (map.getLayer(id)) {
            map.setLayoutProperty(id, 'visibility', visibility);
        }
    });
}
export function addWagonsLayer(map, wagons, routes = []) {
    const geojson = {
        type: 'FeatureCollection',
        features: wagons.map((w) => ({
            type: 'Feature',
            properties: {
                id: w.attributes.objectid,
                tipo: w.attributes.tipo,
                estacion: w.attributes.estacion,
                nombre: w.attributes.nombre,
            },
            geometry: {
                type: 'Polygon',
                coordinates: w.geometry.rings.map(ring => [...ring].reverse()),
            },
        })),
    };
    map.addSource('wagons', { type: 'geojson', data: geojson });
    map.addLayer({
        id: 'wagons-fill',
        type: 'fill',
        source: 'wagons',
        minzoom: 15,
        paint: {
            'fill-color': '#4B5563',
            'fill-opacity': 0.6,
            'fill-outline-color': '#FBBF24',
        },
    });
    map.addLayer({
        id: 'wagons-line',
        type: 'line',
        source: 'wagons',
        minzoom: 15,
        paint: {
            'line-color': '#FBBF24',
            'line-width': 1.5,
        },
    });
    map.on('click', 'wagons-fill', (e) => {
        markClickHandled(e);
        const feature = e.features?.[0];
        if (!feature || !feature.properties)
            return;
        // Convert coordinates safely to Turf polygon
        const coords = feature.geometry.type === 'Polygon' ? feature.geometry.coordinates : JSON.parse(feature.geometry).coordinates;
        const polygon = turf.polygon(coords);
        const center = turf.centerOfMass(polygon);
        const leftRoutes = new Set();
        const rightRoutes = new Set();
        routes.forEach(route => {
            const paths = route.geometry?.paths;
            if (!paths)
                return;
            for (const path of paths) {
                if (path.length < 2)
                    continue;
                const line = turf.lineString(path);
                const distance = turf.pointToLineDistance(center, line, { units: 'meters' });
                if (distance < 20) {
                    const nearest = turf.nearestPointOnLine(line, center);
                    const angle = turf.bearing(center, nearest);
                    if (angle >= 0 && angle <= 180) {
                        rightRoutes.add(route.attributes.route_name_ruta_troncal);
                    }
                    else {
                        leftRoutes.add(route.attributes.route_name_ruta_troncal);
                    }
                    break;
                }
            }
        });
        const p = feature.properties;
        const formatTags = (rSet) => Array.from(rSet).map(r => `<span class="route-tag" style="background: var(--tm-red); font-size: 0.65rem; padding: 2px 6px;">${r}</span>`).join('');
        const leftHTML = leftRoutes.size > 0 ? formatTags(leftRoutes) : '<i>-</i>';
        const rightHTML = rightRoutes.size > 0 ? formatTags(rightRoutes) : '<i>-</i>';
        const html = `
      <div class="popup-station">
        <div class="popup-station-name" style="font-size: 1rem;">${p.estacion}</div>
        <div class="popup-station-corridor" style="color: #9CA3AF; margin-bottom: 8px;">${p.nombre}</div>
        <div class="popup-station-meta" style="margin-top: 4px; display: grid; grid-template-columns: 1fr 1fr; gap: 8px;">
          <div style="background: rgba(255,255,255,0.05); padding: 8px; border-radius: 4px; min-width: 120px;">
            <div style="font-size: 0.65rem; color: #9CA3AF; margin-bottom: 6px; text-align: center; text-transform: uppercase;">Puerta Sur/Occ.</div>
            <div style="display: flex; flex-wrap: wrap; gap: 4px; justify-content: center;">${leftHTML}</div>
          </div>
          <div style="background: rgba(255,255,255,0.05); padding: 8px; border-radius: 4px; min-width: 120px;">
            <div style="font-size: 0.65rem; color: #9CA3AF; margin-bottom: 6px; text-align: center; text-transform: uppercase;">Puerta Norte/Ori.</div>
            <div style="display: flex; flex-wrap: wrap; gap: 4px; justify-content: center;">${rightHTML}</div>
          </div>
        </div>
      </div>
    `;
        new maplibregl.Popup({ offset: 0, maxWidth: '340px' })
            .setLngLat(e.lngLat)
            .setHTML(html)
            .addTo(map);
    });
    map.on('mouseenter', 'wagons-fill', () => {
        map.getCanvas().style.cursor = 'pointer';
    });
    map.on('mouseleave', 'wagons-fill', () => {
        map.getCanvas().style.cursor = '';
    });
}
