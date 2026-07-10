/**
 * MapLibre controller for the mobile app.
 *
 * The map ENGINE and the live 3D bus layer are shared with the website
 * (spec §5.2.6), but the chrome around it — controls, station styling, route
 * highlight, interaction model — is authored fresh here so the app looks nothing
 * like the desktop site. The heavy `buses`/`three` layer is lazy-loaded the first
 * time a route is tracked, keeping first paint fast (spec §1 Performance).
 */

import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { getRouteAccentColor, STATION_COLOR, PARADERO_COLOR } from '@shared/utils/routeColors';
import type { RouteListItem } from '@shared/types/transmilenio';
import type { TrackingStatus } from '@shared/layers/buses';
import type { StationRecord } from '../state';

const BOGOTA_CENTER: [number, number] = [-74.0938, 4.6486];

type BusesModule = typeof import('@shared/layers/buses');
let busesModule: Promise<BusesModule> | null = null;
function loadBuses(): Promise<BusesModule> {
  return (busesModule ??= import('@shared/layers/buses'));
}

const EMPTY_FC: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };

export interface RouteLiveHandler {
  (count: number, status: TrackingStatus, asOf?: number): void;
}

export class MapController {
  readonly map: maplibregl.Map;
  private ready = false;
  private activeRouteId: string | null = null;
  private pendingStations: StationRecord[] | null = null;
  private pendingParaderos: StationRecord[] | null = null;
  private pendingRoute: { route: RouteListItem; onLive?: RouteLiveHandler } | null = null;
  private pendingUser: [number, number] | null = null;
  private pendingFly: { coordinate: [number, number]; zoom: number } | null = null;
  // Map-filter state (user intent). Global layers hide while a route is active.
  private stationsOn = true;
  private paraderosOn = false;
  onSelectStation: (rec: StationRecord) => void = () => {};

  constructor(container: HTMLElement) {
    this.map = new maplibregl.Map({
      container,
      style: 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json',
      center: BOGOTA_CENTER,
      zoom: 12,
      minZoom: 10.5,
      maxZoom: 18,
      attributionControl: false,
      maxBounds: [
        [-74.45, 4.2],
        [-73.75, 5.0],
      ],
    });
    this.map.addControl(new maplibregl.AttributionControl({ compact: true }), 'top-left');
    // Diagnostic handle for remote-devtools debugging inside the webview
    // (mirrors the website's window.__tmMap).
    (window as Window & { __tmMap?: maplibregl.Map }).__tmMap = this.map;
    this.map.on('load', () => this.onLoad());
  }

  private onLoad(): void {
    const map = this.map;

    map.addSource('tm-route', { type: 'geojson', data: EMPTY_FC });
    map.addLayer({
      id: 'tm-route-casing',
      type: 'line',
      source: 'tm-route',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': '#05070c', 'line-width': ['interpolate', ['linear'], ['zoom'], 11, 6, 16, 12] },
    });
    map.addLayer({
      id: 'tm-route-line',
      type: 'line',
      source: 'tm-route',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': ['get', 'color'],
        'line-width': ['interpolate', ['linear'], ['zoom'], 11, 3.4, 16, 7.5],
      },
    });

    // Active-route stops: accent fill + white stroke (same scheme as the station
    // circles) so they read on the dark basemap at fit zoom for EVERY accent —
    // the old dark fill + accent stroke vanished for black-accent rutas fáciles
    // (spec §5.4.3 RF = #000000) and was near-invisible for the rest.
    map.addSource('tm-stops', { type: 'geojson', data: EMPTY_FC });
    map.addLayer({
      id: 'tm-stops-layer',
      type: 'circle',
      source: 'tm-stops',
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 11, 3.5, 14, 5.5, 17, 8],
        'circle-color': ['get', 'color'],
        'circle-stroke-color': '#ffffff',
        'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 11, 1.2, 16, 2.2],
      },
    });

    map.addSource('tm-stations', { type: 'geojson', data: EMPTY_FC });
    map.addLayer({
      id: 'tm-stations-layer',
      type: 'circle',
      source: 'tm-stations',
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 11, 3.2, 14, 5.5, 17, 9],
        'circle-color': STATION_COLOR,
        'circle-stroke-color': '#ffffff',
        'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 11, 1, 16, 2.4],
      },
    });
    map.addLayer({
      id: 'tm-stations-label',
      type: 'symbol',
      source: 'tm-stations',
      minzoom: 13.5,
      layout: {
        'text-field': ['get', 'name'],
        'text-size': 11,
        'text-offset': [0, 1.2],
        'text-anchor': 'top',
        'text-font': ['Open Sans Semibold', 'Arial Unicode MS Bold'],
        'text-max-width': 8,
      },
      paint: {
        'text-color': '#f4f6fb',
        'text-halo-color': '#05070c',
        'text-halo-width': 1.6,
      },
    });

    // Whole-network zonal paraderos (thousands) — hidden by default; toggled
    // from the map filter panel so the map isn't crowded out of the box.
    map.addSource('tm-paraderos', { type: 'geojson', data: EMPTY_FC });
    map.addLayer({
      id: 'tm-paraderos-layer',
      type: 'circle',
      source: 'tm-paraderos',
      layout: { visibility: 'none' },
      minzoom: 12.5,
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 12, 2.2, 16, 4.4],
        'circle-color': PARADERO_COLOR,
        'circle-stroke-color': '#06121b',
        'circle-stroke-width': 1.2,
      },
    });

    map.addSource('tm-user', { type: 'geojson', data: EMPTY_FC });
    map.addLayer({
      id: 'tm-user-halo',
      type: 'circle',
      source: 'tm-user',
      paint: { 'circle-radius': 18, 'circle-color': '#3b82f6', 'circle-opacity': 0.16 },
    });
    map.addLayer({
      id: 'tm-user-dot',
      type: 'circle',
      source: 'tm-user',
      paint: { 'circle-radius': 6, 'circle-color': '#3b82f6', 'circle-stroke-color': '#fff', 'circle-stroke-width': 2.5 },
    });

    const pickHandler = (kind: 'station' | 'stop') => (e: maplibregl.MapLayerMouseEvent) => {
      const f = e.features?.[0];
      if (!f) return;
      const p = f.properties as any;
      this.onSelectStation({
        code: p.code,
        name: p.name,
        direccion: p.direccion || '',
        coordinate: (f.geometry as GeoJSON.Point).coordinates as [number, number],
        wagonCount: Number(p.wagonCount) || 0,
        kind,
      });
    };
    map.on('click', 'tm-stations-layer', pickHandler('station'));
    map.on('click', 'tm-paraderos-layer', pickHandler('stop'));
    for (const layer of ['tm-stations-layer', 'tm-stops-layer', 'tm-paraderos-layer']) {
      map.on('mouseenter', layer, () => (map.getCanvas().style.cursor = 'pointer'));
      map.on('mouseleave', layer, () => (map.getCanvas().style.cursor = ''));
    }

    this.ready = true;
    // Apply anything requested before the style finished loading.
    if (this.pendingStations) {
      this.setStations(this.pendingStations);
      this.pendingStations = null;
    }
    if (this.pendingParaderos) {
      this.setParaderos(this.pendingParaderos);
      this.pendingParaderos = null;
    }
    if (this.pendingUser) {
      this.setUser(this.pendingUser);
      this.pendingUser = null;
    }
    if (this.pendingFly) {
      this.flyTo(this.pendingFly.coordinate, this.pendingFly.zoom);
      this.pendingFly = null;
    }
    if (this.pendingRoute) {
      const { route, onLive } = this.pendingRoute;
      this.pendingRoute = null;
      void this.showRoute(route, onLive);
    }
    // Sync station/paradero layers to the current filter state (in case a toggle
    // fired before the style finished loading).
    this.applyBaseLayerVisibility();
  }

  setStations(records: StationRecord[]): void {
    if (!this.ready) {
      this.pendingStations = records;
      return;
    }
    const src = this.map.getSource('tm-stations') as maplibregl.GeoJSONSource | undefined;
    src?.setData({
      type: 'FeatureCollection',
      features: records.map((r) => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: r.coordinate },
        properties: { code: r.code, name: r.name, direccion: r.direccion, wagonCount: r.wagonCount },
      })),
    });
  }

  setParaderos(records: StationRecord[]): void {
    if (!this.ready) {
      this.pendingParaderos = records;
      return;
    }
    const src = this.map.getSource('tm-paraderos') as maplibregl.GeoJSONSource | undefined;
    src?.setData({
      type: 'FeatureCollection',
      features: records.map((r) => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: r.coordinate },
        properties: { code: r.code, name: r.name, direccion: r.direccion },
      })),
    });
  }

  /** Map-filter toggles (station / zonal-stop layers). Persist even under a route. */
  setStationsVisible(on: boolean): void {
    this.stationsOn = on;
    this.applyBaseLayerVisibility();
  }

  setParaderosVisible(on: boolean): void {
    this.paraderosOn = on;
    this.applyBaseLayerVisibility();
  }

  /** Whole-network layers follow the filters, but are always hidden while a route
   *  is shown so only that route's own stops remain (spec: route detail clarity). */
  private applyBaseLayerVisibility(): void {
    if (!this.ready) return;
    const routeActive = this.activeRouteId !== null;
    const stations = !routeActive && this.stationsOn ? 'visible' : 'none';
    const paraderos = !routeActive && this.paraderosOn ? 'visible' : 'none';
    this.map.setLayoutProperty('tm-stations-layer', 'visibility', stations);
    this.map.setLayoutProperty('tm-stations-label', 'visibility', stations);
    this.map.setLayoutProperty('tm-paraderos-layer', 'visibility', paraderos);
  }

  private setStopsVisible(visible: boolean): void {
    if (!this.ready) return;
    this.map.setLayoutProperty('tm-stops-layer', 'visibility', visible ? 'visible' : 'none');
  }

  private fitPadding(): maplibregl.PaddingOptions {
    // Keep padding well under the canvas size or fitBounds silently no-ops
    // ("Map cannot fit within canvas…"). Leaves room for the top chips + banner.
    const h = this.map.getContainer().clientHeight || window.innerHeight;
    return { top: 84, bottom: Math.min(180, Math.round(h * 0.28)), left: 34, right: 34 };
  }

  /** Draw a route + its stops and start live 3D-bus tracking. */
  async showRoute(route: RouteListItem, onLive?: RouteLiveHandler): Promise<void> {
    if (!this.ready) {
      this.pendingRoute = { route, onLive };
      return;
    }
    this.activeRouteId = route.id;
    const color = getRouteAccentColor(route);

    const paths = route.geometry?.paths ?? [];
    const routeSrc = this.map.getSource('tm-route') as maplibregl.GeoJSONSource | undefined;
    routeSrc?.setData({
      type: 'FeatureCollection',
      features: paths.length
        ? [{ type: 'Feature', geometry: { type: 'MultiLineString', coordinates: paths }, properties: { color } }]
        : [],
    });

    const stops = route.stops ?? [];
    const stopsSrc = this.map.getSource('tm-stops') as maplibregl.GeoJSONSource | undefined;
    stopsSrc?.setData({
      type: 'FeatureCollection',
      features: stops.map((s) => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: s.coordinate },
        properties: { color, name: s.nombre },
      })),
    });
    this.setStopsVisible(true);
    // Route active → hide the whole-network station/paradero layers so only the
    // stops this route serves (tm-stops) remain.
    this.applyBaseLayerVisibility();

    if (paths.length) {
      const bounds = new maplibregl.LngLatBounds();
      for (const path of paths) for (const c of path) bounds.extend(c as [number, number]);
      if (!bounds.isEmpty()) this.map.fitBounds(bounds, { padding: this.fitPadding(), maxZoom: 15, duration: 700 });
    }

    // Live tracking: lazy-load the shared buses/three layer on first use.
    const buses = await loadBuses();
    if (this.activeRouteId !== route.id) return; // switched away during import
    const candidates = route.liveNameCandidates ?? [];
    buses.startBusTracking(
      this.map,
      route.code,
      candidates[0] || route.catalogNombre || route.name || route.destination,
      route.type,
      candidates,
      color,
      stops.map((s) => ({ nombre: s.nombre, coordinate: s.coordinate })),
      (count, status, asOf) => onLive?.(count, status, asOf)
    );
  }

  async clearRoute(): Promise<void> {
    this.activeRouteId = null;
    (this.map.getSource('tm-route') as maplibregl.GeoJSONSource | undefined)?.setData(EMPTY_FC);
    (this.map.getSource('tm-stops') as maplibregl.GeoJSONSource | undefined)?.setData(EMPTY_FC);
    this.setStopsVisible(false);
    // Route cleared → restore the whole-network layers per the user's filters.
    this.applyBaseLayerVisibility();
    if (busesModule) (await busesModule).stopBusTracking();
  }

  flyTo(coordinate: [number, number], zoom = 15.5): void {
    if (!this.ready) {
      this.pendingFly = { coordinate, zoom };
      return;
    }
    this.map.flyTo({ center: coordinate, zoom, duration: 800 });
  }

  setUser(coordinate: [number, number]): void {
    if (!this.ready) {
      this.pendingUser = coordinate;
      return;
    }
    (this.map.getSource('tm-user') as maplibregl.GeoJSONSource | undefined)?.setData({
      type: 'FeatureCollection',
      features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: coordinate }, properties: {} }],
    });
  }

  resize(): void {
    this.map.resize();
  }
}
