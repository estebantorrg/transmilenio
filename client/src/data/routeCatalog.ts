/**
 * Master-catalog → RouteListItem builder (shared, presentation-agnostic).
 *
 * This is the single source of truth for turning the raw master catalog (+ the
 * optional zonal stop mappings) into the unified
 * `RouteListItem[]` both front-ends consume. The website (`main.ts`) and the
 * native mobile app (`mobile/`) import it verbatim so the two clients can never
 * drift in how a route is deduped, colored, or named (spec §1.1 R2 — no
 * duplicated logic). It is intentionally free of any MapLibre / DOM dependency.
 */

import { getRouteColor, getStopTagColor, normalizeRouteCodeForMatch } from '../utils/routeColors';
import { isStampedStationCode } from '../utils/routeType';
import { mergeServiceSpans, parseServiceSpans } from '../services/schedule';
import { haversineMeters } from '../utils/geo';
import type { RouteListItem } from '../types/transmilenio';
import type { CatalogRoute, MasterCatalog } from '../types/catalog';
import { plataformasDe } from '../../../shared/route_stop.js';

export type RouteStop = NonNullable<RouteListItem['stops']>[number];
/** A catalog route as its variant lists it: `stops` says where it starts. */
type CatalogVariant = CatalogRoute & { stops?: unknown[] };

export function normalizeRouteText(value: string | null | undefined): string {
  return normalizeRouteCodeForMatch(value)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
}

export function getBaseRouteCode(code: string): string {
  return code.toUpperCase()
    .replace(/(?:CV|CICLOVIA|CICLOVÍA|C)$/i, '')
    .trim();
}

export function cleanRouteText(text: string): string {
  return text.toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\bciclovia\b/g, '')
    .replace(/[^a-z0-9]/g, '')
    .trim();
}

/** Accent-insensitive Ciclovía check — the catalog spells it "Ciclovía". */
export function isCicloviaName(text: string | null | undefined): boolean {
  return String(text || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .includes('ciclovia');
}

/**
 * Is this catalog node an estación?
 *
 * The server answers it from the official station register and stamps the light
 * catalog (`station.estacion`, §5.1.4/§5.5.6); the `TM…` code shape stays as the
 * fallback for the 140 stations that have one, and for any surface reading a
 * catalog that predates the stamp. Deriving it from the code alone drew three
 * real estaciones — Tibanica - Primavera, Los Laureles, Islandia, opened before
 * TransMi assigned them TM codes — as zonal paraderos on every screen.
 */
export function isStationStopCode(code: string | null | undefined): boolean {
  const key = String(code || '').trim();
  if (!key) return false;
  return /^TM\d+$/i.test(key) || isStampedStationCode(key);
}

function stopKind(code: string | null | undefined): 'station' | 'stop' {
  return isStationStopCode(code) ? 'station' : 'stop';
}

/**
 * The planner's nodes for a stop the catalog merges out of two stations (Av.
 * Jiménez, Ricaurte): the platform this route calls at, read off the wagon it
 * is filed under. As one node the router let a rider change between halves that
 * share no service — C15 to J23 at "Avenida Jiménez", whose tunnel is closed —
 * and crossed Ricaurte's tunnel in no time at all (spec §5.6.3).
 */
function platformNodes(stop: any, route: CatalogVariant, catalog: MasterCatalog): RouteStop['platforms'] {
  const calls = plataformasDe(catalog.stations?.[stop.codigo], route.codigo, route.stops?.[0] === stop);
  // A route no wagon carries keeps the merged stop: its half is not known.
  if (!calls.length) return undefined;
  return calls.map((half) => ({
    nombre: half.nombre,
    codigo: half.codigo,
    sourceCode: half.parent,
    coordinate: half.coordinate,
    kind: 'station' as const,
  }));
}

/**
 * Parses one catalog route stop into a map-ready stop. Avenida Jiménez (TM0013)
 * and Ricaurte (TM0069) keep the merged código the catalog files them under
 * (spec §5.4.1) but stand where the route boards: the catalog's one point is the
 * trunk half, so every Calle 13 route was pinned across the tunnel. The planner
 * reads the `platforms` stamped beside them.
 */
export function parseCatalogStop(stop: any, route?: CatalogVariant, catalog?: MasterCatalog): RouteStop | null {
  if (!stop?.coordenada || typeof stop.coordenada !== 'string' || !stop.coordenada.includes(',')) return null;
  const [lat, lng] = stop.coordenada.split(',').map(Number);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

  const platforms = route && catalog ? platformNodes(stop, route, catalog) : undefined;
  return {
    nombre: stop.nombre,
    codigo: stop.codigo,
    sourceCode: stop.codigo,
    coordinate: platforms?.[0]?.coordinate ?? ([lng, lat] as [number, number]),
    direccion: stop.direccion,
    kind: stopKind(stop.codigo),
    ...(platforms ? { platforms } : {}),
  };
}

export function dedupeStops(stops: RouteListItem['stops'] | undefined): RouteStop[] {
  const seen = new Set<string>();
  const result: RouteStop[] = [];

  for (const stop of stops || []) {
    const coordinateKey = `${stop.coordinate[0].toFixed(6)},${stop.coordinate[1].toFixed(6)}`;
    const key = stop.codigo
      ? `${stop.codigo.toUpperCase()}|${coordinateKey}`
      : `${normalizeRouteText(stop.nombre)}|${coordinateKey}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(stop);
  }

  return result;
}

function isLngLatPair(value: unknown): value is number[] {
  return Array.isArray(value) &&
    value.length >= 2 &&
    Number.isFinite(Number(value[0])) &&
    Number.isFinite(Number(value[1]));
}

export function traceToGeometry(trace: number[][] | number[][][] | undefined): { paths: number[][][] } | undefined {
  if (!Array.isArray(trace) || trace.length === 0) return undefined;
  const first = trace[0];

  if (isLngLatPair(first)) {
    return trace.length > 1 ? { paths: [trace as number[][]] } : undefined;
  }

  if (Array.isArray(first) && isLngLatPair(first[0])) {
    const paths = (trace as number[][][]).filter((path) => Array.isArray(path) && path.length > 1);
    return paths.length > 0 ? { paths } : undefined;
  }

  return undefined;
}

/** Kilometres along a route's trace — what its ficha shows as "Longitud". */
export function traceKm(geometry: RouteListItem['geometry']): number | undefined {
  if (!geometry) return undefined;
  let meters = 0;
  for (const path of geometry.paths) {
    for (let i = 1; i < path.length; i++) {
      meters += haversineMeters(path[i - 1] as [number, number], path[i] as [number, number]);
    }
  }
  return meters / 1000;
}

export function routeHasDualStops(stops: any[] | undefined): boolean {
  if (!stops || stops.length === 0) return false;
  const hasStation = stops.some((stop) => isStationStopCode(stop.codigo));
  const hasStop = stops.some((stop) => !isStationStopCode(stop.codigo));
  return hasStation && hasStop;
}

/** Raw `convención hora_inicio-hora_fin` text, kept as the display fallback for
 *  rows the schedule parser cannot read (spec §5.6.2). */
function formatScheduleText(route: { horarios?: CatalogRoute['horarios'] }): string | undefined {
  return route.horarios?.data?.map((h) => `${h.convencion} ${h.hora_inicio}-${h.hora_fin}`).join(' / ');
}

/** Slug of a código, matching the prerender's URL builder (`/ruta/<slug>/`). */
function routeCodeSlug(code: string): string {
  return String(code || '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * `onlyCode` restricts the build to a single código, for a visitor who arrived on
 * `/ruta/<code>/` and needs *that* route before the rest of the network (§5.5.5):
 * the full build walks every route in the catalog, and the page they came for
 * does not depend on the other thousand. Matched on the URL slug, which is how
 * the prerender spells a código in a path.
 */
export function buildCatalogRouteList(
  catalog: MasterCatalog,
  options: { onlyCode?: string } = {}
): RouteListItem[] {
  const items: RouteListItem[] = [];
  if (!catalog.routes) return items;

  // Track seen route combinations to deduplicate. Key = baseCode|type|origin|dest
  const seen = new Map<string, number>();

  const wanted = options.onlyCode ? routeCodeSlug(options.onlyCode) : null;
  const entries = wanted
    ? Object.entries(catalog.routes).filter(([code]) => routeCodeSlug(code) === wanted)
    : Object.entries(catalog.routes);

  for (const [code, variants] of entries) {
    for (const route of variants) {
      const service = `${route.sistema} ${route.tipoServicio}`.toUpperCase();
      const isAlimentador = service.includes('ALIMENTADOR');
      const isDual = service.includes('PADRON') || routeHasDualStops(route.stops);
      const type = service.includes('ZONAL') || service.includes('TRANSMIZONAL') || isAlimentador ? 'zonal' : 'troncal';
      // Alimentador wins over the dual test, not the other way round. `isDual`
      // is partly a *heuristic* — a route that touches both estaciones and
      // paraderos (`routeHasDualStops`) — and a feeder that runs to a portal
      // trips it. Ordered the old way, alimentador 1-1 came out `subType:
      // 'dual'` and every surface that reads it called the feeder a padrón:
      // "Ruta Dual" in the panel, "TransMilenio Dual · PADRÓN" on the route
      // page. A service the catalog *names* ALIMENTADOR is one, whatever stops
      // it happens to serve.
      const subType = isAlimentador ? 'alimentador' : isDual ? 'dual' : type;

      const rawStops = route.stops || [];
      const stops = dedupeStops(rawStops.map((stop) => parseCatalogStop(stop, route, catalog)).filter((stop): stop is RouteStop => Boolean(stop)));
      const origin = route.origin || rawStops[0]?.nombre || code;
      const destination = route.destination || rawStops[rawStops.length - 1]?.nombre || route.nombre;

      // Use the official catalog name if available, otherwise fallback to the origin/dest string
      const displayName = route.nombre || `${origin} → ${destination}`;

      const baseCode = getBaseRouteCode(code);
      const normOrigin = cleanRouteText(origin);
      const normDest = cleanRouteText(destination);
      const dedupKey = `${baseCode}|${type}|${normOrigin}|${normDest}`;

      const existingIdx = seen.get(dedupKey);
      if (existingIdx !== undefined) {
        // Merge geometry/stops into existing entry
        const existing = items[existingIdx];

        // If existing is a Ciclovía variant but the new one is regular, update metadata
        const isNewCiclovia = code.toUpperCase().endsWith('CV') || isCicloviaName(displayName);
        const isExistingCiclovia = existing.code.toUpperCase().endsWith('CV') || isCicloviaName(existing.name);

        if (isExistingCiclovia && !isNewCiclovia) {
          existing.id = `catalog-${route.id || `${code}-${normalizeRouteText(route.nombre)}`}`;
          existing.code = code;
          existing.name = displayName;
          existing.origin = origin;
          existing.destination = destination;
          existing.busType = route.tipoServicio;
          // The presented route is now the regular variant, so its hours must be
          // the regular ones too — keeping the Ciclovía window would advertise a
          // weekday service as Sundays-only (spec §5.6.2).
          existing.schedule = formatScheduleText(route);
          existing.serviceSpans = parseServiceSpans(route.horarios);
        } else if (isExistingCiclovia === isNewCiclovia) {
          // Same class of variant merged into one presented route: the route
          // operates whenever either variant does.
          existing.serviceSpans = mergeServiceSpans(existing.serviceSpans, parseServiceSpans(route.horarios));
        }

        // Stops and trace must come from the SAME variant. They describe one
        // journey between them, and the planner projects one onto the other
        // (§5.6.3) — pairing variant A's stop list with variant B's `trazado`
        // put stops hundreds of metres off "their" trace and made the leg
        // unusable. So the variant that supplies the stops supplies the trace,
        // and a trace is only adopted on its own when there are no stops yet to
        // contradict it.
        const traceGeometry = traceToGeometry(route.trazado);
        if ((!existing.stops || existing.stops.length === 0) && stops.length > 0) {
          existing.stops = stops;
          existing.geometry = traceGeometry;
        } else if (!existing.geometry && !existing.stops?.length && traceGeometry) {
          existing.geometry = traceGeometry;
        }
        continue;
      }

      const geometry = traceToGeometry(route.trazado);

      const newItem: RouteListItem = {
        id: `catalog-${route.id || `${code}-${normalizeRouteText(route.nombre)}`}`,
        code,
        name: displayName,
        origin,
        destination,
        type,
        subType,
        source: 'catalog',
        busType: route.tipoServicio,
        schedule: formatScheduleText(route),
        serviceSpans: parseServiceSpans(route.horarios),
        color: type === 'troncal' ? getRouteColor(code, 'troncal') : getStopTagColor(code, route.color, 'zonal'),
        catalogNombre: route.nombre || '',
        geometry,
        stops,
      };

      seen.set(dedupKey, items.length);
      items.push(newItem);
    }
  }

  // Measured once the merges above have settled which variant's trace each
  // route carries. It used to be ArcGIS's `longitud_ruta_troncal`, a 0.9 MB
  // download for 128 numbers, troncal only; the light trace's simplification
  // shortens it by well under 1%.
  for (const item of items) item.length = traceKm(item.geometry);

  return items;
}

/**
 * Zonal stop enrichment (ArcGIS `consulta_paraderos_rutas` + `consulta_paraderos_zonales`).
 *
 * The mapping layer files BOTH directions of a route under one `ruta` code and
 * only the `orden` attribute (a direction prefix + a numeric riding sequence,
 * e.g. "CBO012" / "NOR045") distinguishes and orders them. Aggregating in
 * feature (objectid) order interleaves the two directions, which poisons the
 * journey-planner graph with arbitrary stop-to-stop edges — so stops are split
 * per direction prefix and sorted by their numeric sequence here, and each
 * route variant then picks the direction whose endpoints match its own.
 */
export function buildZonalStopGroups(zonalStops: any[], zonalMappings: any[]): Map<string, RouteStop[][]> {
  const stopLookup = new Map<string, any>();
  for (const s of zonalStops) {
    const cenefa = s.attributes?.cenefa;
    if (cenefa) stopLookup.set(cenefa, s);
  }

  // route code -> direction prefix -> [{sequence, stop}]
  const byCodeAndPrefix = new Map<string, Map<string, { sequence: number; stop: RouteStop }[]>>();
  for (const m of zonalMappings) {
    const routeCode = normalizeRouteCodeForMatch(m.attributes?.ruta);
    const cenefa = m.attributes?.cenefa;
    const stop = cenefa ? stopLookup.get(cenefa) : null;
    if (!routeCode || !stop?.geometry || stop.geometry.x == null || stop.geometry.y == null) continue;

    const orden = String(m.attributes?.orden ?? '');
    const match = orden.match(/^(\D*)(\d+)$/);
    const prefix = match ? match[1] : '';
    const sequence = match ? Number(match[2]) : Number.MAX_SAFE_INTEGER;

    let prefixes = byCodeAndPrefix.get(routeCode);
    if (!prefixes) byCodeAndPrefix.set(routeCode, (prefixes = new Map()));
    let group = prefixes.get(prefix);
    if (!group) prefixes.set(prefix, (group = []));
    group.push({
      sequence,
      stop: {
        nombre: stop.attributes?.nombre || 'Paradero',
        codigo: cenefa,
        coordinate: [stop.geometry.x, stop.geometry.y] as [number, number],
        direccion: stop.attributes?.direccion_bandera || stop.attributes?.via || '',
        kind: 'stop',
      },
    });
  }

  const groupsByCode = new Map<string, RouteStop[][]>();
  for (const [code, prefixes] of byCodeAndPrefix) {
    const groups: RouteStop[][] = [];
    for (const entries of prefixes.values()) {
      entries.sort((a, b) => a.sequence - b.sequence);
      const stops = dedupeStops(entries.map((entry) => entry.stop));
      if (stops.length > 1) groups.push(stops);
    }
    if (groups.length > 0) groupsByCode.set(code, groups);
  }
  return groupsByCode;
}

/** Loose endpoint-name match used to pair a direction group with a route variant. */
function endpointNameMatches(routeEndpoint: string, stopName: string): boolean {
  const a = cleanRouteText(routeEndpoint);
  const b = cleanRouteText(stopName);
  return Boolean(a && b && (a.includes(b) || b.includes(a)));
}

/**
 * Fills the stop list of zonal routes that lack catalog stops from the ArcGIS
 * direction groups: each variant gets the direction whose first/last stop names
 * best match its own origin/destination, falling back to the longest group.
 */
export function applyZonalStopEnrichment(routes: RouteListItem[], groupsByCode: Map<string, RouteStop[][]>): void {
  for (const route of routes) {
    if (route.type !== 'zonal' || (route.stops && route.stops.length > 0)) continue;
    const groups = groupsByCode.get(normalizeRouteCodeForMatch(route.code));
    if (!groups) continue;

    let best: RouteStop[] | null = null;
    let bestScore = -1;
    for (const group of groups) {
      const score =
        (endpointNameMatches(route.destination, group[group.length - 1].nombre) ? 2 : 0) +
        (endpointNameMatches(route.origin, group[0].nombre) ? 1 : 0);
      if (score > bestScore || (score === bestScore && group.length > (best?.length ?? 0))) {
        bestScore = score;
        best = group;
      }
    }
    if (best) route.stops = best;
  }
}

// The live lookup's name candidates live in their own dependency-free module so
// the planner can use them without loading this one (`liveNames.ts`).
export { getLiveNameCandidates } from './liveNames';

/**
 * Builds the unified route list from the catalog, enriching it with zonal stop
 * mappings when available.
 *
 * The ArcGIS troncal routes layer used to be merged in here, for a geometry no
 * catalog variant lacks and a length the trace now gives (`traceKm`); it was
 * 0.9 MB of every first visit, so it is no longer fetched.
 */
export function buildRouteList(
  catalog: MasterCatalog,
  zonalStops: any[] = [],
  zonalMappings: any[] = []
): RouteListItem[] {
  const merged = buildCatalogRouteList(catalog);
  if (zonalStops.length > 0 && zonalMappings.length > 0) {
    applyZonalStopEnrichment(merged, buildZonalStopGroups(zonalStops, zonalMappings));
  }

  return merged;
}
