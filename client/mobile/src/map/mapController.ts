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
import { getRouteAccentColor, STATION_COLOR, PARADERO_COLOR, CABLE_COLOR } from '@shared/utils/routeColors';
import type { RouteListItem } from '@shared/types/transmilenio';
import { prefetchLiveBuses } from '@shared/services/api';
import { liveNameCandidates } from '../live/liveStatus';
import type { TrackingStatus } from '@shared/layers/buses';
import type { DemandRecord, StationRecord } from '../state';

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
  private pendingDemand: DemandRecord[] | null = null;
  private pendingCable: { stations: StationRecord[]; traces: any[] } | null = null;
  private pendingRoute: { route: RouteListItem; onLive?: RouteLiveHandler } | null = null;
  private pendingUser: [number, number] | null = null;
  private pendingFly: { coordinate: [number, number]; zoom: number } | null = null;
  // Map-filter state (user intent). Global layers hide while a route is active.
  private stationsOn = true;
  private paraderosOn = false;
  private demandOn = false;
  private cableOn = false;
  onSelectStation: (rec: StationRecord) => void = () => {};
  onSelectDemand: (rec: DemandRecord) => void = () => {};
  onSelectCable: (rec: StationRecord) => void = () => {};

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
    // Labels from the default open zoom (map starts at 12) — at 13.5 the map
    // opened with anonymous dots and names only appeared after zooming in.
    map.addLayer({
      id: 'tm-stations-label',
      type: 'symbol',
      source: 'tm-stations',
      minzoom: 12,
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
    // Paradero names on the map itself — before this layer existed the only way
    // to learn a stop's name was tapping it. minzoom is higher than stations
    // (~7400 stops vs ~140); MapLibre collision keeps the visible set readable.
    map.addLayer({
      id: 'tm-paraderos-label',
      type: 'symbol',
      source: 'tm-paraderos',
      minzoom: 14,
      layout: {
        visibility: 'none',
        'text-field': ['get', 'name'],
        'text-size': 10,
        'text-offset': [0, 1],
        'text-anchor': 'top',
        'text-font': ['Open Sans Semibold', 'Arial Unicode MS Bold'],
        'text-max-width': 8,
        'text-optional': true,
      },
      paint: {
        'text-color': PARADERO_COLOR,
        'text-halo-color': '#05070c',
        'text-halo-width': 1.4,
      },
    });

    // Station-demand heat overlay (open Salidas dataset) — graduated circles,
    // same footfall→radius/color ramp as the website's demandLayer (spec §5.5.1).
    // Hidden until the "Demanda" map filter enables it.
    map.addSource('tm-demand', { type: 'geojson', data: EMPTY_FC });
    map.addLayer({
      id: 'tm-demand-layer',
      type: 'circle',
      source: 'tm-demand',
      layout: { visibility: 'none' },
      paint: {
        'circle-radius': [
          'interpolate', ['linear'], ['get', 'total'],
          1500, 5,
          20000, 12,
          60000, 20,
          135000, 30,
        ],
        'circle-color': [
          'interpolate', ['linear'], ['get', 'total'],
          1500, '#22c55e',
          25000, '#eab308',
          70000, '#f97316',
          120000, '#ef4444',
        ],
        'circle-opacity': 0.55,
        'circle-stroke-width': 1,
        'circle-stroke-color': '#05070c',
        'circle-stroke-opacity': 0.6,
      },
    });

    // TransMiCable (spec §5.3) — orange gondola line + stations, hidden until the
    // "TransMiCable" map filter enables it (mirrors the website's cable layer).
    map.addSource('tm-cable-line', { type: 'geojson', data: EMPTY_FC });
    map.addLayer({
      id: 'tm-cable-line-layer',
      type: 'line',
      source: 'tm-cable-line',
      layout: { 'line-cap': 'round', 'line-join': 'round', visibility: 'none' },
      paint: {
        'line-color': CABLE_COLOR,
        'line-width': ['interpolate', ['linear'], ['zoom'], 11, 3, 16, 6],
        'line-opacity': 0.85,
      },
    });
    map.addSource('tm-cable-stations', { type: 'geojson', data: EMPTY_FC });
    map.addLayer({
      id: 'tm-cable-stations-layer',
      type: 'circle',
      source: 'tm-cable-stations',
      layout: { visibility: 'none' },
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 11, 3.4, 14, 5.5, 17, 8.5],
        'circle-color': CABLE_COLOR,
        'circle-stroke-color': '#ffffff',
        'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 11, 1.1, 16, 2.2],
      },
    });
    map.addLayer({
      id: 'tm-cable-stations-label',
      type: 'symbol',
      source: 'tm-cable-stations',
      minzoom: 13,
      layout: {
        visibility: 'none',
        'text-field': ['get', 'name'],
        'text-size': 11,
        'text-offset': [0, 1.2],
        'text-anchor': 'top',
        'text-font': ['Open Sans Semibold', 'Arial Unicode MS Bold'],
        'text-max-width': 8,
      },
      paint: {
        'text-color': CABLE_COLOR,
        'text-halo-color': '#05070c',
        'text-halo-width': 1.6,
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

    // Tap picking. Per-layer `click` handlers require the tap to land exactly on
    // the feature — a fingertip covers far more than these 3–9 px circles, so
    // taps routinely "did nothing". Instead hit-test a finger-sized box around
    // the tap across every pickable layer and dispatch the closest feature.
    // queryRenderedFeatures only returns features from visible layers, so hidden
    // filters / route mode need no special-casing.
    const TAP_PAD_PX = 14;
    const TAP_LAYERS = ['tm-stations-layer', 'tm-paraderos-layer', 'tm-cable-stations-layer', 'tm-demand-layer'];
    map.on('click', (e) => {
      const feats = map.queryRenderedFeatures(
        [
          [e.point.x - TAP_PAD_PX, e.point.y - TAP_PAD_PX],
          [e.point.x + TAP_PAD_PX, e.point.y + TAP_PAD_PX],
        ],
        { layers: TAP_LAYERS.filter((id) => map.getLayer(id)) }
      );
      if (!feats.length) return;
      const distToTap = (f: maplibregl.MapGeoJSONFeature): number =>
        map.project((f.geometry as GeoJSON.Point).coordinates as [number, number]).dist(e.point);
      feats.sort((a, b) => distToTap(a) - distToTap(b));
      const f = feats[0];
      const p = f.properties as any;
      const coordinate = (f.geometry as GeoJSON.Point).coordinates as [number, number];
      if (f.layer.id === 'tm-demand-layer') {
        this.onSelectDemand({
          name: p.name,
          coordinate,
          entradas: Number(p.entradas) || 0,
          salidas: Number(p.salidas) || 0,
          total: Number(p.total) || 0,
          rank: Number(p.rank) || 0,
        });
      } else if (f.layer.id === 'tm-cable-stations-layer') {
        this.onSelectCable({ code: p.code, name: p.name, direccion: '', coordinate, wagonCount: 0, kind: 'cable' });
      } else {
        this.onSelectStation({
          code: p.code,
          name: p.name,
          direccion: p.direccion || '',
          coordinate,
          wagonCount: Number(p.wagonCount) || 0,
          kind: f.layer.id === 'tm-stations-layer' ? 'station' : 'stop',
        });
      }
    });
    for (const layer of ['tm-stations-layer', 'tm-stops-layer', 'tm-paraderos-layer', 'tm-demand-layer', 'tm-cable-stations-layer']) {
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
    if (this.pendingDemand) {
      this.setDemand(this.pendingDemand);
      this.pendingDemand = null;
    }
    if (this.pendingCable) {
      this.setCable(this.pendingCable.stations, this.pendingCable.traces);
      this.pendingCable = null;
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

    // Warm the live-tracking assets now that the map is up: the three.js chunk
    // and the Draco-decoded bus model would otherwise both load only after the
    // user opens a route, delaying the first buses well past their data.
    loadBuses()
      .then((buses) => buses.preloadBusModels())
      .catch((error) => console.warn('[Live] Bus asset preload skipped:', error));
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

  setDemand(records: DemandRecord[]): void {
    if (!this.ready) {
      this.pendingDemand = records;
      return;
    }
    const src = this.map.getSource('tm-demand') as maplibregl.GeoJSONSource | undefined;
    src?.setData({
      type: 'FeatureCollection',
      features: records.map((d) => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: d.coordinate },
        properties: { name: d.name, total: d.total, entradas: d.entradas, salidas: d.salidas, rank: d.rank },
      })),
    });
  }

  setCable(stations: StationRecord[], traces: any[]): void {
    if (!this.ready) {
      this.pendingCable = { stations, traces };
      return;
    }
    (this.map.getSource('tm-cable-line') as maplibregl.GeoJSONSource | undefined)?.setData({
      type: 'FeatureCollection',
      features: traces
        .map((t) => ({
          type: 'Feature' as const,
          geometry: { type: 'LineString' as const, coordinates: (t.geometry?.paths?.[0] ?? []) as number[][] },
          properties: { name: t.attributes?.nom_traz || 'TransMiCable' },
        }))
        .filter((f) => f.geometry.coordinates.length > 1),
    });
    (this.map.getSource('tm-cable-stations') as maplibregl.GeoJSONSource | undefined)?.setData({
      type: 'FeatureCollection',
      features: stations.map((s) => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: s.coordinate },
        properties: { code: s.code, name: s.name },
      })),
    });
  }

  /** Map-filter toggles (station / zonal-stop / demand / cable layers). Persist even under a route. */
  setStationsVisible(on: boolean): void {
    this.stationsOn = on;
    this.applyBaseLayerVisibility();
  }

  setParaderosVisible(on: boolean): void {
    this.paraderosOn = on;
    this.applyBaseLayerVisibility();
  }

  setDemandVisible(on: boolean): void {
    this.demandOn = on;
    this.applyBaseLayerVisibility();
  }

  setCableVisible(on: boolean): void {
    this.cableOn = on;
    this.applyBaseLayerVisibility();
  }

  /** Whole-network layers follow the filters, but are always hidden while a route
   *  is shown so only that route's own stops remain (spec: route detail clarity). */
  private applyBaseLayerVisibility(): void {
    if (!this.ready) return;
    const routeActive = this.activeRouteId !== null;
    const stations = !routeActive && this.stationsOn ? 'visible' : 'none';
    const paraderos = !routeActive && this.paraderosOn ? 'visible' : 'none';
    const demand = !routeActive && this.demandOn ? 'visible' : 'none';
    const cable = !routeActive && this.cableOn ? 'visible' : 'none';
    this.map.setLayoutProperty('tm-stations-layer', 'visibility', stations);
    this.map.setLayoutProperty('tm-stations-label', 'visibility', stations);
    this.map.setLayoutProperty('tm-paraderos-layer', 'visibility', paraderos);
    this.map.setLayoutProperty('tm-paraderos-label', 'visibility', paraderos);
    this.map.setLayoutProperty('tm-demand-layer', 'visibility', demand);
    this.map.setLayoutProperty('tm-cable-line-layer', 'visibility', cable);
    this.map.setLayoutProperty('tm-cable-stations-layer', 'visibility', cable);
    this.map.setLayoutProperty('tm-cable-stations-label', 'visibility', cable);
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

    // Start the live request before drawing anything: the sources, the camera
    // and the lazy three.js import below all run while it is in flight, so the
    // first poll of `startBusTracking` reuses it instead of starting one then
    // (spec §5.2 cold start; see `prefetchLiveBuses`).
    const liveNames = liveNameCandidates(route);
    prefetchLiveBuses(
      route.code,
      liveNames[0] || route.catalogNombre || route.name || route.destination,
      route.type,
      liveNames
    );
    void loadBuses();

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
    buses.startBusTracking(
      this.map,
      route.code,
      liveNames[0] || route.catalogNombre || route.name || route.destination,
      route.type,
      liveNames,
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
