/**
 * Troncal station layer — simplified.
 *
 * Renders stations as circles/labels. On click, shows a premium popup
 * with wagon → route data sourced from the TransMi app master catalog.
 * No more polygon rendering or geometric route guessing.
 */

import maplibregl from 'maplibre-gl';
import type { TroncalStationFeature } from '../types/transmilenio';
import { markClickHandled, normalizeRouteCode, normalizeRouteCodeForMatch } from './routes';
import { showPopup } from './popup';
import { planActionsHtml } from './popupActions';
import { escapeHTML, safeColor } from '../utils/html';
import { getStopTagColor } from '../utils/routeColors';
import type { MasterCatalog, CatalogRoute, CatalogPlanGroup } from '../types/catalog';
import {
  buildStationKey,
  normalizeStationName,
  resolveStationCatalog,
  stationNode,
  type ResolvedCatalogStation,
  type ResolvedCatalogWagons,
  type StationCatalogAudit,
} from './stationCatalogResolver';
import { catalogRouteNetwork, isZonalService } from '../utils/routeType';
import { arrivalsSectionHtml, renderStopArrivals } from './arrivals';

const APP_STOP_CODE_RE = /^TM\d+$/i;

/** The catalog TM… code to query live arrivals for — the resolved source stop
 *  (route stops are filed by these codes), falling back to a TM-shaped code. */
function stationArrivalsCode(
  resolved: ResolvedCatalogStation | undefined,
  stationCode: string
): string {
  const source = resolved?.sourceStops?.[0]?.codigo;
  if (source) return source;
  return APP_STOP_CODE_RE.test(stationCode) ? stationCode : '';
}

/** For verified-split stations, the route codes that board THIS platform's
 *  wagons — used to keep only this platform's arrivals from the union the server
 *  returns for the shared source code. `undefined` for normal stations (no
 *  filtering needed: their wagon set already equals the serving-route set). */
function platformAllowedCodes(resolved: ResolvedCatalogStation | undefined): string[] | undefined {
  if (!resolved || !resolved.matchMethod.startsWith('verified-split')) return undefined;
  const codes = new Set<string>();
  for (const routes of Object.values(resolved.wagons)) {
    for (const route of routes) if (route.codigo) codes.add(route.codigo);
  }
  return Array.from(codes);
}

const STATION_LAYERS = [
  'stations-circle',
  'stations-hitbox',
  'stations-labels',
];

const UNUSED_TRONCAL_STATIONS = new Set([
  'ISLANDIA',
  'LOSLAURELES',
  'TIBANICAPRIMAVERA',
]);

export function isVisibleTroncalStation(station: TroncalStationFeature): boolean {
  return !UNUSED_TRONCAL_STATIONS.has(normalizeStationName(station.attributes.nombre_estacion));
}

// ─── Route Tag Formatting ───────────────────────────────

function groupCatalogRoutesByDirection(routes: CatalogRoute[]): Array<{ code: string; primary: CatalogRoute; routes: CatalogRoute[] }> {
  const groups = new Map<string, { code: string; primary: CatalogRoute; routes: CatalogRoute[] }>();

  for (const route of routes) {
    const codeKey = normalizeRouteCodeForMatch(route.codigo);
    if (!codeKey) continue;

    // Key by code AND direction (destination name). A route that serves a wagon
    // in both directions — common for rutas fáciles like "1" → Universidades /
    // Portal Eldorado — must keep each end as its own clickable tag instead of
    // collapsing into a single tag that can only reach one direction.
    const key = `${codeKey}|${normalizeStationName(route.nombre)}`;

    const group = groups.get(key);
    if (group) {
      group.routes.push(route);
    } else {
      groups.set(key, { code: route.codigo, primary: route, routes: [route] });
    }
  }

  return Array.from(groups.values()).sort((a, b) =>
    normalizeRouteCode(a.code).localeCompare(normalizeRouteCode(b.code), undefined, { numeric: true }) ||
    String(a.primary.nombre || '').localeCompare(String(b.primary.nombre || ''), undefined, { numeric: true })
  );
}

function formatRouteTags(routes: CatalogRoute[], limit = 28): string {
  const groups = groupCatalogRoutesByDirection(routes);
  const visibleGroups = groups.slice(0, limit);
  const hiddenCount = groups.length - visibleGroups.length;
  const tags = visibleGroups
    .map((group) => {
      const route = group.primary;
      const color = safeColor(getStopTagColor(route.codigo, route.color, catalogRouteNetwork(route)), '#FB2C17');
      const routeId = group.routes.length === 1 && route.id ? `catalog-${route.id}` : '';
      const names = Array.from(new Set(group.routes.map((item) => item.nombre).filter(Boolean)));
      const title = names.join(' / ') || route.nombre;
      return `<span class="route-tag clickable" data-route-code="${escapeHTML(route.codigo)}" data-route-id="${escapeHTML(routeId)}" title="${escapeHTML(title)}" style="background:${color}; cursor:pointer;">${escapeHTML(route.codigo)}</span>`;
    })
    .join('');

  return hiddenCount > 0
    ? `${tags}<span class="route-tag muted">+${hiddenCount}</span>`
    : tags;
}

/**
 * A vagón's services split by the side they board from, when the catalog's plan
 * covers them (`wagonPlan`, spec §5.5.4). Returns null when it doesn't, and the
 * caller falls back to one undifferentiated row of tags.
 *
 * The split is the whole point of a plano: "which routes serve this station" is
 * answered by a list, but "which side do I stand on" is not, and that is the
 * question a rider standing on the platform actually has. `arrival` groups are
 * the services that END here — they are shown, because they do use the platform,
 * but never under a direction, since there is nothing to board them towards.
 */
function buildDirectionRowsHtml(
  routes: CatalogRoute[],
  groups: CatalogPlanGroup[] | undefined
): string | null {
  if (!groups?.length) return null;
  const byId = new Map(routes.map((r) => [String(r.id ?? ''), r]));
  const rows: string[] = [];

  for (const group of groups) {
    const members = group.ids.map((id) => byId.get(String(id))).filter((r): r is CatalogRoute => Boolean(r));
    if (members.length === 0) continue;
    const label = group.arrival
      ? '<span class="popup-dir-end">fin de recorrido</span>'
      : group.sentido
        ? `<span class="popup-dir-arrow"></span>${escapeHTML(group.sentido)}`
        : 'sentido sin determinar';
    rows.push(
      `<div class="popup-dir"><div class="popup-dir-label">${label}</div>` +
        `<div class="popup-route-tags">${formatRouteTags(members)}</div></div>`
    );
  }

  // Every service filtered out (ids that don't match this platform's routes) —
  // better to fall back than to render a vagón with nothing under it.
  return rows.length > 0 ? rows.join('') : null;
}

/**
 * The station drawn as a plan — the same view the prerendered `/estacion/` page
 * carries (spec §5.5.4): one continuous platform bar segmented per vagón, the
 * services that board each side above and below it.
 *
 * A list can say which routes serve a station; only a plan says which side to
 * stand on, which is the question a rider on the platform actually has. The
 * three parts of each vagón are laid out on shared grid rows so every plate
 * lands on one line and the bar reads as one platform — with a flex fallback
 * where `subgrid` is unsupported, since a bar that steps up and down mid-station
 * reads as a rendering fault rather than as a station.
 *
 * Wide stations scroll sideways inside the plan rather than stretching the
 * popup: a portal has six vagones and the popup is 320 px.
 */
function buildStationPlanoHtml(
  lettered: Array<{ key: string; routes: CatalogRoute[] }>,
  vagonLabels: Record<string, string>,
  wagonPlan: Record<string, CatalogPlanGroup[]>
): string | null {
  const columns: string[] = [];

  lettered.forEach(({ key, routes }, index) => {
    const groups = wagonPlan[key] ?? [];
    const byId = new Map(routes.map((r) => [String(r.id ?? ''), r]));
    const resolved = groups
      .map((g) => ({
        group: g,
        members: g.ids.map((id) => byId.get(String(id))).filter((r): r is CatalogRoute => Boolean(r)),
      }))
      .filter((g) => g.members.length > 0);
    if (resolved.length === 0) return;

    // One group's label + tags. The wrappers are emitted once per side below:
    // a vagón can serve three groups (both directions plus terminating
    // services), and giving each its own side element pushed the extras outside
    // the three shared grid rows, where they drew on top of one another.
    const groupBlock = (entry: (typeof resolved)[number], which: 'a' | 'b'): string => {
      const { group, members } = entry;
      const label = group.arrival
        ? '<span class="popup-dir-end">fin de recorrido</span>'
        : group.sentido
          ? `<span class="popup-dir-arrow popup-dir-arrow-${which === 'a' ? 'up' : 'down'}"></span>${escapeHTML(group.sentido)}`
          : 'sin determinar';
      return (
        `<div class="pvg-group"><div class="popup-dir-label">${label}</div>` +
        `<div class="popup-route-tags">${formatRouteTags(members)}</div></div>`
      );
    };

    // No number where the plate count doesn't back the catalog's grouping —
    // "Plataforma N" is vague but true, a wrong vagón number sends a rider to
    // the wrong side of the station.
    const name = vagonLabels[key] ? `Vagón ${escapeHTML(vagonLabels[key])}` : `Plataforma ${index + 1}`;
    const count = resolved.reduce((n, g) => n + groupCatalogRoutesByDirection(g.members).length, 0);
    const [first, ...rest] = resolved;

    columns.push(
      `<section class="pvg" aria-label="${name}">` +
        `<div class="pvg-side pvg-side-a">${first ? groupBlock(first, 'a') : ''}</div>` +
        `<div class="pvg-plate"><span class="pvg-name">${name}</span><span class="pvg-sub">${count}</span></div>` +
        `<div class="pvg-side pvg-side-b">${rest.map((entry) => groupBlock(entry, 'b')).join('')}</div>` +
        `</section>`
    );
  });

  if (columns.length === 0) return null;
  return (
    `<div class="popup-plano" role="group" aria-label="Plano de la estación" tabindex="0">` +
    `<div class="popup-plano-cols">${columns.join('')}</div></div>`
  );
}

/**
 * Renders the wagon → route-tag sections shown inside a station popup.
 *
 * Sections are keyed on what each route IS, never on the wagon key it is filed
 * under (spec §5.5.4):
 *
 * - **Lettered wagons** are troncal platforms, headed by the number printed on
 *   the station's own signs (`vagonLabels`, resolved server-side against the
 *   plano plate counts) and by a neutral "Plataforma N" where that evidence is
 *   missing. The catalog's raw `A`/`B` keys are never shown: they appear on no
 *   sign in any station, so a rider sent to "Vagón A" has nothing to look for.
 *   When the TransMi data mismaps a zonal route onto one (e.g. A537 "Palermo",
 *   which merely parallels the corridor) it is a phantom stop, and it is
 *   dropped rather than repooled — the route does not board there at all.
 * - **Wagon "0"** is the pool the catalog files without a platform letter, and
 *   it is *mixed*: real feeders/zonales (Banderas F423/F424, San Mateo CSM) sit
 *   beside 61 troncal services across 22 stations (P85/M85 at Centro Memoria,
 *   L81/D81 along Avenida 68). Labelling the whole key from its dominant
 *   content printed "Vagón único" next to a Vagón A and a Vagón B, so each half
 *   gets its own true heading.
 *
 * Sections left empty are omitted.
 */
function buildWagonSectionsHtml(
  wagons: ResolvedCatalogWagons,
  vagonLabels: Record<string, string> = {},
  wagonPlan: Record<string, CatalogPlanGroup[]> = {}
): string {
  const lettered: Array<{ key: string; routes: CatalogRoute[] }> = [];
  const unlettered: CatalogRoute[] = [];
  const feeders: CatalogRoute[] = [];

  for (const [wagonKey, entries] of Object.entries(wagons)) {
    const routes = entries as CatalogRoute[];
    if (wagonKey === '0') {
      for (const route of routes) {
        (isZonalService(route.sistema, route.tipoServicio) ? feeders : unlettered).push(route);
      }
      continue;
    }
    const troncal = routes.filter((r) => !isZonalService(r.sistema, r.tipoServicio));
    if (troncal.length) lettered.push({ key: wagonKey, routes: troncal });
  }

  lettered.sort((a, b) => a.key.localeCompare(b.key, undefined, { numeric: true }));

  // The lettered platforms are drawn as the station's plan — the same view the
  // /estacion/ page carries. Where the catalog ships no plan for them, they fall
  // back to the labelled sections below, so a station is never left blank.
  const plano = buildStationPlanoHtml(lettered, vagonLabels, wagonPlan);

  const sections = [
    ...(plano
      ? []
      : lettered.map(({ key, routes }, i) => ({
          label: vagonLabels[key] ? `Vagón ${escapeHTML(vagonLabels[key])}` : `Plataforma ${i + 1}`,
          routes,
          plan: wagonPlan[key],
        }))),
    // "Vagón único" is only true where there is no lettered platform to sit
    // beside; otherwise these are simply the services the catalog gives no
    // platform for, and only the station's signage can say which.
    ...(unlettered.length
      ? [{
          label: lettered.length ? 'Otros servicios troncales' : 'Vagón único',
          routes: unlettered,
          plan: wagonPlan['0'],
        }]
      : []),
    // Feeders stay one flat list: the plan gives them no direction (they are
    // excluded from it upstream), and the estación page lists them the same way.
    ...(feeders.length ? [{ label: 'Alimentadores y zonales', routes: feeders, plan: undefined }] : []),
  ];

  const html = sections
    .map(({ label, routes, plan }) => {
      const count = groupCatalogRoutesByDirection(routes).length;
      const body =
        buildDirectionRowsHtml(routes, plan) ?? `<div class="popup-route-tags">${formatRouteTags(routes)}</div>`;
      return `
          <div class="popup-wagon-section">
            <div class="popup-wagon-label">${label}<span class="popup-count">${count}</span></div>
            ${body}
          </div>
        `;
    })
    .join('');

  return (plano ?? '') + html || '<div class="popup-empty">Sin rutas disponibles</div>';
}

// ─── Catalog Lookup ─────────────────────────────────────

let _catalog: MasterCatalog = { stations: {}, routes: {} };
let _resolvedStations: Record<string, ResolvedCatalogStation> = {};
let _stationAudit: StationCatalogAudit[] = [];

export function setCatalog(catalog: MasterCatalog): void {
  _catalog = catalog;
  _resolvedStations = {};
  _stationAudit = [];
}

function publishStationAudit(): void {
  const total = _stationAudit.length;
  const unmatched = _stationAudit.filter((entry) => entry.matchMethod === 'unmatched').length;
  const verified = _stationAudit.filter((entry) => entry.matchMethod.startsWith('verified-split')).length;
  const platformClusters = _stationAudit.filter((entry) => entry.matchMethod.startsWith('platform-cluster')).length;

  if (typeof window !== 'undefined') {
    (window as Window & { __tmStationAudit?: StationCatalogAudit[] }).__tmStationAudit = _stationAudit;
  }

  console.info(
    `[Stations] Catalog audit: ${total - unmatched}/${total} matched, ` +
      `${verified} verified splits, ${platformClusters} platform clusters, ${unmatched} unmatched.`,
    _stationAudit
  );
}

// ─── Station Popup ──────────────────────────────────────

function hasRenderedFeatureAtPoint(
  map: maplibregl.Map,
  e: maplibregl.MapLayerMouseEvent,
  layerIds: string[]
): boolean {
  const existingLayers = layerIds.filter((id) => map.getLayer(id));
  return existingLayers.length > 0 && map.queryRenderedFeatures(e.point, { layers: existingLayers }).length > 0;
}

function showStationPopup(
  map: maplibregl.Map,
  e: maplibregl.MapLayerMouseEvent
): void {
  if (hasRenderedFeatureAtPoint(map, e, ['stops-hitbox'])) return;
  if (!markClickHandled(e)) return;
  const feature = e.features?.[0];
  if (!feature || !feature.properties) return;

  const p = feature.properties;
  const coords = (feature.geometry as GeoJSON.Point).coordinates;
  const stationCode = p.stationCode || '';
  const stationName = p.name || '';
  const stationKey = String(p.stationKey || stationCode);

  const resolvedStation = _resolvedStations[stationKey];

  const wagonSections =
    resolvedStation && Object.keys(resolvedStation.wagons).length > 0
      ? buildWagonSectionsHtml(resolvedStation.wagons, resolvedStation.vagonLabels, resolvedStation.wagonPlan)
      // Not "no routes serve this station" — the catalog simply files no wagon
      // assignment for it, and saying which is the difference between a data gap
      // and a claim about the network (spec §1).
      : '<div class="popup-empty">El catálogo oficial no asigna vagones a esta estación. Busca la estación por nombre para ver sus rutas.</div>';

  // Station meta
  const meta = [
    p.location,
    p.wagons ? `${p.wagons} vagones` : '',
    p.bike ? `Biciparqueo (${p.bikeCapacity})` : '',
    p.wifi === 'SI' ? 'WiFi' : '',
  ].filter(Boolean);

  const html = `
    <div class="popup-card">
      <div class="popup-eyebrow">${escapeHTML(p.corridor)}</div>
      <div class="popup-title">${escapeHTML(stationName)}</div>
      ${meta.length ? `<div class="popup-meta">${meta.map((item) => `<span>${escapeHTML(item)}</span>`).join('')}</div>` : ''}
      <div class="popup-wagon-container">
        ${wagonSections}
      </div>
      ${arrivalsSectionHtml(stationArrivalsCode(resolvedStation, stationCode))}
      ${planActionsHtml(stationName, coords as [number, number], stationCode)}
    </div>
  `;

  showPopup(map, coords as [number, number], html, { offset: 12, maxWidth: '340px' });
  const arrCode = stationArrivalsCode(resolvedStation, stationCode);
  if (arrCode) void renderStopArrivals(arrCode, platformAllowedCodes(resolvedStation));
}

// ─── Layer Setup ────────────────────────────────────────

/** One entry per rendered station, carrying the RESOLVED display name (verified
 *  splits included) so list UIs (Cerca, search) match the map labels instead of
 *  echoing raw ArcGIS names — e.g. both Av. Jiménez platforms arrive named
 *  "Temporal AV. Jiménez - Inter Eléctricas" upstream. Filled by addStationsLayer. */
export interface StationDisplayPoint {
  codigo: string;
  name: string;
  coordinate: [number, number];
  direccion: string;
}

let stationDisplayPoints: StationDisplayPoint[] = [];

export function getStationDisplayPoints(): StationDisplayPoint[] {
  return stationDisplayPoints;
}

/**
 * Resolves the station set against the catalog and turns it into the layer's
 * GeoJSON, refreshing the resolved-station index, the audit and the display
 * points. Shared by the initial render and by {@link updateStationsLayer}, so a
 * recovered ArcGIS payload lands on exactly the same pipeline (spec §1.1 R2).
 */
function prepareStations(stations: TroncalStationFeature[]): GeoJSON.FeatureCollection {
  globalStations = stations;
  const visibleStations = stations.filter(isVisibleTroncalStation);
  const resolution = resolveStationCatalog(visibleStations, _catalog);
  _resolvedStations = resolution.stationsByKey;
  _stationAudit = resolution.audit;
  publishStationAudit();

  const geojson: GeoJSON.FeatureCollection = {
    type: 'FeatureCollection',
    features: visibleStations.map((s) => {
      const key = buildStationKey(s);
      const resolved = _resolvedStations[key];
      // Use resolved name from verified splits so split stations
      // (e.g. Av. Jiménez Caracas vs Av. Jiménez CL 13) show distinct labels.
      const displayName = resolved?.matchMethod.startsWith('verified-split')
        ? resolved.stationName
        : s.attributes.nombre_estacion;
      return {
        type: 'Feature',
        properties: {
          stationKey: key,
          name: displayName,
          stationCode: s.attributes.numero_estacion,
          stationNode: stationNode(s),
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
      };
    }),
  };

  stationDisplayPoints = geojson.features
    .map((f) => ({
      codigo: String((f.properties as any)?.stationCode ?? ''),
      name: String((f.properties as any)?.name ?? ''),
      coordinate: (f.geometry as GeoJSON.Point).coordinates as [number, number],
      direccion: String((f.properties as any)?.location ?? ''),
    }))
    .filter((p) => p.name && Number.isFinite(p.coordinate[0]) && Number.isFinite(p.coordinate[1]));

  return geojson;
}

/**
 * Re-renders the station layer from a new station set — used when the recovery
 * pass finally gets the ArcGIS payload that failed at boot, so the catalog
 * fallback is upgraded in place (ArcGIS-only metadata included) instead of the
 * user having to reload. No-op before the layer exists.
 */
export function updateStationsLayer(
  map: maplibregl.Map,
  stations: TroncalStationFeature[]
): void {
  const source = map.getSource('stations') as maplibregl.GeoJSONSource | undefined;
  if (!source) return;
  source.setData(prepareStations(stations));
}

export function addStationsLayer(
  map: maplibregl.Map,
  stations: TroncalStationFeature[]
): void {
  // Idempotent: the recovery pass re-runs this once a degraded ArcGIS fetch
  // succeeds, and re-adding a live source throws.
  if (map.getSource('stations')) {
    updateStationsLayer(map, stations);
    return;
  }

  const geojson = prepareStations(stations);

  map.addSource('stations', { type: 'geojson', data: geojson });

  map.addLayer({
    id: 'stations-circle',
    type: 'symbol',
    source: 'stations',
    layout: {
      'icon-image': 'stop-red',
      'icon-size': ['interpolate', ['linear'], ['zoom'], 10, 0.5, 14, 0.65, 17, 0.85],
      'icon-allow-overlap': true,
      'icon-anchor': 'bottom',
    },
  });

  map.addLayer({
    id: 'stations-hitbox',
    type: 'circle',
    source: 'stations',
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 12, 14, 18, 17, 26],
      'circle-color': '#000000',
      'circle-opacity': 0,
    },
  });

  map.addLayer({
    id: 'stations-labels',
    type: 'symbol',
    source: 'stations',
    minzoom: 14,
    layout: {
      'text-field': ['get', 'name'],
      'text-font': ['Open Sans Bold'],
      'text-size': ['interpolate', ['linear'], ['zoom'], 14, 9, 17, 13],
      'text-offset': [0, 0.8],
      'text-anchor': 'top',
      'text-max-width': 10,
    },
    paint: {
      'text-color': '#FB2C17',
      'text-halo-color': '#0A0E17',
      'text-halo-width': 1.5,
      'text-opacity': ['interpolate', ['linear'], ['zoom'], 14, 0.6, 16, 1],
    },
  });

  map.on('click', 'stations-hitbox', (e) => showStationPopup(map, e));
  map.on('mouseenter', 'stations-hitbox', () => {
    map.getCanvas().style.cursor = 'pointer';
  });
  map.on('mouseleave', 'stations-hitbox', () => {
    map.getCanvas().style.cursor = '';
  });
}

/**
 * Catalog fallback for the base station layer (spec §4.2). ArcGIS is the
 * primary source of troncal stations, but when that fetch fails or comes back
 * empty (upstream flake, cold relay) the layer must not silently vanish — the
 * master catalog is required for the app to open at all and carries every
 * troncal station with coordinates and wagon data, so synthesize features
 * from it instead. ArcGIS-only metadata (wifi, biciestación) is simply absent.
 */
export function catalogStationsToFeatures(catalog: MasterCatalog): TroncalStationFeature[] {
  const features: TroncalStationFeature[] = [];
  let objectid = 1;

  for (const [key, station] of Object.entries(catalog.stations)) {
    // Classify by CODE, not sistema/tipoServicio: the light catalog this
    // fallback consumes may omit both fields on a real TM station, which would
    // silently drop it exactly when ArcGIS already failed. TM…-coded nodes are
    // the troncal estaciones (spec §5.4.1a; same rule as the mobile twin).
    const isTroncal = /^TM\d+$/i.test(String(station.codigo || key).trim());
    if (!isTroncal) continue;

    const [latRaw, lngRaw] = String(station.coordenada || '').split(',');
    const lat = Number(latRaw);
    const lng = Number(lngRaw);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;

    features.push({
      attributes: {
        objectid: objectid++,
        numero_estacion: station.codigo || key,
        nombre_estacion: station.nombre,
        ubicacion_estacion: station.direccion || '',
        troncal_estacion: 'TransMilenio',
        numero_vagones_estacion: Object.keys(station.wagons || {}).length,
        numero_accesos_estacion: 0,
        biciestacion_estacion: '0',
        capacidad_biciestacion_estacion: 0,
        tipo_estacion: 0,
        latitud_estacion: lat,
        longitud_estacion: lng,
        componente_wifi: '',
      },
      geometry: { x: lng, y: lat },
    });
  }
  return features;
}

export function toggleStationsLayer(map: maplibregl.Map, visible: boolean): void {
  const visibility = visible ? 'visible' : 'none';
  STATION_LAYERS.forEach((id) => {
    if (map.getLayer(id)) {
      map.setLayoutProperty(id, 'visibility', visibility);
    }
  });
}

export function bringStationsLayerToFront(map: maplibregl.Map): void {
  STATION_LAYERS.forEach((id) => {
    if (map.getLayer(id)) {
      map.moveLayer(id);
    }
  });
}

let globalStations: TroncalStationFeature[] = [];

export function showStationPopupByCode(map: maplibregl.Map, stationCode: string, coordinate: [number, number]): boolean {
  let resolvedStation: ResolvedCatalogStation | undefined;
  for (const station of Object.values(_resolvedStations)) {
    if (
      station.stationCode === stationCode ||
      station.stationKey === stationCode ||
      station.sourceStops.some(ss => ss.codigo === stationCode)
    ) {
      resolvedStation = station;
      break;
    }
  }

  if (!resolvedStation) return false;

  const wagonSections = buildWagonSectionsHtml(resolvedStation.wagons, resolvedStation.vagonLabels, resolvedStation.wagonPlan);

  const stationFeature = globalStations.find(s =>
    s.attributes.numero_estacion === stationCode ||
    s.attributes.codigo_nodo_estacion === stationCode ||
    normalizeStationName(s.attributes.nombre_estacion) === normalizeStationName(resolvedStation!.stationName)
  );

  const corridor = stationFeature?.attributes.troncal_estacion || 'Estación troncal';

  const firstSource = resolvedStation.sourceStops[0];
  const location = firstSource ? firstSource.direccion : '';

  const html = `
    <div class="popup-card">
      <div class="popup-eyebrow">${escapeHTML(corridor)}</div>
      <div class="popup-title">${escapeHTML(resolvedStation.stationName)}</div>
      ${location ? `<div class="popup-meta"><span>${escapeHTML(location)}</span></div>` : ''}
      <div class="popup-wagon-container">
        ${wagonSections}
      </div>
      ${arrivalsSectionHtml(stationArrivalsCode(resolvedStation, stationCode))}
      ${planActionsHtml(resolvedStation.stationName, coordinate, stationCode)}
    </div>
  `;

  showPopup(map, coordinate, html, { offset: 12, maxWidth: '340px' });
  const arrCode = stationArrivalsCode(resolvedStation, stationCode);
  if (arrCode) void renderStopArrivals(arrCode, platformAllowedCodes(resolvedStation));
  return true;
}
