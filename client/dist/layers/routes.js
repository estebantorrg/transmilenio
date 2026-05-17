/**
 * Route polylines layer.
 * Renders Troncal and Zonal routes as colored lines.
 */
import maplibregl from 'maplibre-gl';
/**
 * Higher-priority interactive layers — if any feature from these
 * layers exists at a click point, the route click handler should yield.
 */
const PRIORITY_LAYERS = ['stations-circle', 'stops-circle', 'wagons-fill'];
export function markClickHandled(_e) {
    // Kept for backward compat with station/stop imports, now a no-op.
}
function hasHigherPriorityFeature(map, e) {
    const existing = PRIORITY_LAYERS.filter(id => map.getLayer(id));
    if (existing.length === 0)
        return false;
    const hits = map.queryRenderedFeatures(e.point, { layers: existing });
    return hits.length > 0;
}
// ─── Convert ArcGIS paths to GeoJSON ──────────────────────
function routesToGeoJSON(features, type) {
    return {
        type: 'FeatureCollection',
        features: features.map((f) => {
            const isTroncal = type === 'troncal';
            const attrs = f.attributes;
            return {
                type: 'Feature',
                properties: {
                    id: attrs.objectid,
                    code: isTroncal
                        ? attrs.route_name_ruta_troncal
                        : attrs.codigo_definitivo_ruta_zonal,
                    name: isTroncal
                        ? `${attrs.origen_ruta_troncal} → ${attrs.destino_ruta_troncal}`
                        : attrs.denominacion_ruta_zonal,
                    type,
                    origin: isTroncal ? attrs.origen_ruta_troncal : attrs.origen_ruta_zonal,
                    destination: isTroncal ? attrs.destino_ruta_troncal : attrs.destino_ruta_zonal,
                    busType: isTroncal ? attrs.desc_tipo_bus_ruta_troncal : undefined,
                    schedule: isTroncal ? attrs.horario_lunes_viernes : undefined,
                    operator: !isTroncal ? attrs.operador_ruta_zonal : undefined,
                },
                geometry: {
                    type: 'MultiLineString',
                    coordinates: f.geometry.paths,
                },
            };
        }),
    };
}
// ─── Add Troncal Routes ───────────────────────────────────
export function addTroncalRoutesLayer(map, routes) {
    const geojson = routesToGeoJSON(routes, 'troncal');
    map.addSource('troncal-routes', { type: 'geojson', data: geojson });
    // Glow / casing
    map.addLayer({
        id: 'troncal-routes-glow',
        type: 'line',
        source: 'troncal-routes',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
            'line-color': '#E3342F',
            'line-width': ['interpolate', ['linear'], ['zoom'], 10, 4, 14, 10, 17, 18],
            'line-opacity': 0.12,
            'line-blur': 4,
        },
    });
    // Main line
    map.addLayer({
        id: 'troncal-routes-line',
        type: 'line',
        source: 'troncal-routes',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
            'line-color': '#E3342F',
            'line-width': ['interpolate', ['linear'], ['zoom'], 10, 1.5, 14, 3, 17, 5],
            'line-opacity': 0.8,
        },
    });
    // Click interaction
    map.on('click', 'troncal-routes-line', (e) => {
        if (hasHigherPriorityFeature(map, e))
            return;
        const feature = e.features?.[0];
        if (!feature?.properties)
            return;
        showRoutePopup(map, feature, e.lngLat);
    });
    map.on('mouseenter', 'troncal-routes-line', () => {
        map.getCanvas().style.cursor = 'pointer';
    });
    map.on('mouseleave', 'troncal-routes-line', () => {
        map.getCanvas().style.cursor = '';
    });
}
// ─── Add Zonal Routes ─────────────────────────────────────
export function addZonalRoutesLayer(map, routes) {
    const geojson = routesToGeoJSON(routes, 'zonal');
    map.addSource('zonal-routes', { type: 'geojson', data: geojson });
    // Glow
    map.addLayer({
        id: 'zonal-routes-glow',
        type: 'line',
        source: 'zonal-routes',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
            'line-color': '#38BDF8',
            'line-width': ['interpolate', ['linear'], ['zoom'], 10, 3, 14, 8, 17, 14],
            'line-opacity': 0.08,
            'line-blur': 3,
        },
    });
    // Main line
    map.addLayer({
        id: 'zonal-routes-line',
        type: 'line',
        source: 'zonal-routes',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
            'line-color': '#38BDF8',
            'line-width': ['interpolate', ['linear'], ['zoom'], 10, 0.8, 14, 2, 17, 3.5],
            'line-opacity': 0.5,
        },
    });
    // Click interaction
    map.on('click', 'zonal-routes-line', (e) => {
        if (hasHigherPriorityFeature(map, e))
            return;
        const feature = e.features?.[0];
        if (!feature?.properties)
            return;
        showRoutePopup(map, feature, e.lngLat);
    });
    map.on('mouseenter', 'zonal-routes-line', () => {
        map.getCanvas().style.cursor = 'pointer';
    });
    map.on('mouseleave', 'zonal-routes-line', () => {
        map.getCanvas().style.cursor = '';
    });
}
// ─── Route Popup ──────────────────────────────────────────
function showRoutePopup(map, feature, lngLat) {
    const p = feature.properties;
    const isTroncal = p.type === 'troncal';
    const color = isTroncal ? '#FC8181' : '#38BDF8';
    const html = `
    <div class="popup-route">
      <div class="popup-route-code" style="color: ${color}">${p.code}</div>
      <div class="popup-route-name">${p.name}</div>
      <div class="popup-route-endpoints">
        <span class="dot" style="background: #34D399"></span>
        ${p.origin}
        <span style="color: #4B5563">→</span>
        <span class="dot" style="background: #E3342F"></span>
        ${p.destination}
      </div>
      ${p.busType ? `<div style="margin-top:8px;font-size:11px;color:#9CA3AF">${p.busType}</div>` : ''}
      ${p.schedule ? `<div style="font-size:11px;color:#9CA3AF">🕐 ${p.schedule}</div>` : ''}
      ${p.operator ? `<div style="font-size:11px;color:#9CA3AF">🏢 ${p.operator}</div>` : ''}
    </div>
  `;
    new maplibregl.Popup({ offset: 8, maxWidth: '300px' })
        .setLngLat(lngLat)
        .setHTML(html)
        .addTo(map);
}
// ─── Visibility Toggles ──────────────────────────────────
export function toggleTroncalRoutes(map, visible) {
    const v = visible ? 'visible' : 'none';
    ['troncal-routes-glow', 'troncal-routes-line'].forEach((id) => {
        if (map.getLayer(id))
            map.setLayoutProperty(id, 'visibility', v);
    });
}
export function toggleZonalRoutes(map, visible) {
    const v = visible ? 'visible' : 'none';
    ['zonal-routes-glow', 'zonal-routes-line'].forEach((id) => {
        if (map.getLayer(id))
            map.setLayoutProperty(id, 'visibility', v);
    });
}
// ─── Highlight a specific route ───────────────────────────
let highlightedSource = null;
export function highlightRoute(map, routeCode, type) {
    clearHighlight(map);
    const sourceId = `${type}-routes`;
    const source = map.getSource(sourceId);
    if (!source)
        return;
    // Add highlight layer
    map.addLayer({
        id: 'highlight-route',
        type: 'line',
        source: sourceId,
        filter: ['==', ['get', 'code'], routeCode],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
            'line-color': type === 'troncal' ? '#FC8181' : '#7DD3FC',
            'line-width': ['interpolate', ['linear'], ['zoom'], 10, 4, 14, 7, 17, 10],
            'line-opacity': 1,
        },
    });
    map.addLayer({
        id: 'highlight-route-glow',
        type: 'line',
        source: sourceId,
        filter: ['==', ['get', 'code'], routeCode],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
            'line-color': type === 'troncal' ? '#E3342F' : '#38BDF8',
            'line-width': ['interpolate', ['linear'], ['zoom'], 10, 12, 14, 20, 17, 30],
            'line-opacity': 0.2,
            'line-blur': 6,
        },
    });
    highlightedSource = sourceId;
}
export function clearHighlight(map) {
    if (map.getLayer('highlight-route'))
        map.removeLayer('highlight-route');
    if (map.getLayer('highlight-route-glow'))
        map.removeLayer('highlight-route-glow');
    highlightedSource = null;
}
