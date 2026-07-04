/**
 * Master-catalog → RouteListItem builder (shared, presentation-agnostic).
 *
 * This is the single source of truth for turning the raw master catalog (+ the
 * optional ArcGIS troncal geometries and zonal stop mappings) into the unified
 * `RouteListItem[]` both front-ends consume. The website (`main.ts`) and the
 * native mobile app (`mobile/`) import it verbatim so the two clients can never
 * drift in how a route is deduped, colored, or named (spec §1.1 R2 — no
 * duplicated logic). It is intentionally free of any MapLibre / DOM dependency.
 */

import { getRouteColor, getStopTagColor, normalizeRouteCodeForMatch } from '../utils/routeColors';
import type { RouteListItem, TroncalRouteFeature } from '../types/transmilenio';
import type { CatalogRoute, MasterCatalog } from '../types/catalog';

export type RouteStop = NonNullable<RouteListItem['stops']>[number];

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

interface SplitStopNode {
  code: string;
  sourceCode: string;
  name: string;
  direccion: string;
  coordinate: [number, number];
  wagons: Set<string>;
}

const VERIFIED_SPLIT_STOP_NODES: SplitStopNode[] = [
  {
    code: '09110',
    sourceCode: 'TM0013',
    name: 'AV. Jimenez - Caracas',
    direccion: 'CL 13 - CL 11',
    coordinate: [-74.08042807, 4.60287397],
    wagons: new Set(['A', 'B', 'C']),
  },
  {
    code: '14003',
    sourceCode: 'TM0013',
    name: 'AV. Jimenez - CL 13',
    direccion: 'CL 13 - Caracas',
    coordinate: [-74.07910861, 4.60304793],
    wagons: new Set(['D', 'E']),
  },
  {
    code: '07111',
    sourceCode: 'TM0069',
    name: 'Ricaurte - NQS',
    direccion: 'KR 30 - CL 10',
    coordinate: [-74.09386888, 4.6116862],
    wagons: new Set(['A', 'B', 'C']),
  },
  {
    code: '12003',
    sourceCode: 'TM0069',
    name: 'Ricaurte - CL 13',
    direccion: 'CL 13 - KR 28',
    coordinate: [-74.09048002, 4.61301485],
    wagons: new Set(['D', 'E', 'F']),
  },
];

export function isStationStopCode(code: string | null | undefined): boolean {
  return /^TM\d+$/i.test(String(code || '').trim());
}

function stopKind(code: string | null | undefined): 'station' | 'stop' {
  return isStationStopCode(code) ? 'station' : 'stop';
}

function catalogRouteMatches(left: CatalogRoute, right: CatalogRoute): boolean {
  if (left.id && right.id && String(left.id) === String(right.id)) return true;
  return normalizeRouteCodeForMatch(left.codigo) === normalizeRouteCodeForMatch(right.codigo) &&
    cleanRouteText(left.nombre) === cleanRouteText(right.nombre);
}

function splitNodeForRouteStop(
  stop: any,
  route: CatalogRoute | null | undefined,
  catalog: MasterCatalog
): SplitStopNode | null {
  if (!route || !stop?.codigo) return null;

  const sourceCode = String(stop.codigo).toUpperCase();
  const splitNodes = VERIFIED_SPLIT_STOP_NODES.filter((node) => node.sourceCode === sourceCode);
  if (splitNodes.length === 0) return null;

  const sourceStation = catalog.stations?.[sourceCode];
  if (!sourceStation?.wagons) return null;

  for (const [wagonLabel, routes] of Object.entries(sourceStation.wagons)) {
    const splitNode = splitNodes.find((node) => node.wagons.has(wagonLabel));
    if (!splitNode) continue;
    if (routes.some((candidate) => catalogRouteMatches(candidate, route))) return splitNode;
  }

  return null;
}

export function parseCatalogStop(stop: any, route?: CatalogRoute, catalog?: MasterCatalog): RouteStop | null {
  if (!stop?.coordenada || typeof stop.coordenada !== 'string' || !stop.coordenada.includes(',')) return null;
  const [lat, lng] = stop.coordenada.split(',').map(Number);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

  const splitNode = catalog ? splitNodeForRouteStop(stop, route, catalog) : null;
  if (splitNode) {
    return {
      nombre: splitNode.name,
      codigo: splitNode.code,
      sourceCode: splitNode.sourceCode,
      coordinate: splitNode.coordinate,
      direccion: splitNode.direccion,
      kind: 'station',
    };
  }

  return {
    nombre: stop.nombre,
    codigo: stop.codigo,
    sourceCode: stop.codigo,
    coordinate: [lng, lat] as [number, number],
    direccion: stop.direccion,
    kind: stopKind(stop.codigo),
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

export function routeHasDualStops(stops: any[] | undefined): boolean {
  if (!stops || stops.length === 0) return false;
  const hasStation = stops.some((stop) => isStationStopCode(stop.codigo));
  const hasStop = stops.some((stop) => !isStationStopCode(stop.codigo));
  return hasStation && hasStop;
}

export function buildCatalogRouteList(catalog: MasterCatalog): RouteListItem[] {
  const items: RouteListItem[] = [];
  if (!catalog.routes) return items;

  // Track seen route combinations to deduplicate. Key = baseCode|type|origin|dest
  const seen = new Map<string, number>();

  for (const [code, variants] of Object.entries(catalog.routes)) {
    for (const route of variants) {
      const service = `${route.sistema} ${route.tipoServicio}`.toUpperCase();
      const isAlimentador = service.includes('ALIMENTADOR');
      const isDual = service.includes('PADRON') || routeHasDualStops(route.stops);
      const type = service.includes('ZONAL') || service.includes('TRANSMIZONAL') || isAlimentador ? 'zonal' : 'troncal';
      const subType = isDual ? 'dual' : isAlimentador ? 'alimentador' : type;

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
        }

        const traceGeometry = traceToGeometry(route.trazado);
        if (!existing.geometry && traceGeometry) {
          existing.geometry = traceGeometry;
        }

        if ((!existing.stops || existing.stops.length === 0) && stops.length > 0) {
          existing.stops = stops;
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
        schedule: route.horarios?.data?.map((h) => `${h.convencion} ${h.hora_inicio}-${h.hora_fin}`).join(' / '),
        color: type === 'troncal' ? getRouteColor(code, 'troncal') : getStopTagColor(code, route.color),
        catalogNombre: route.nombre || '',
        geometry,
        stops,
      };

      seen.set(dedupKey, items.length);
      items.push(newItem);
    }
  }

  return items;
}

function addUniqueLiveName(candidates: string[], value: unknown): void {
  const text = String(value || '').trim();
  if (!text) return;

  const parts = text.split(/\s+[-–—]\s+/).map((part) => part.trim()).filter(Boolean);
  for (const part of parts.length > 1 ? [...parts].reverse() : parts) {
    const clean = part.trim();
    if (clean && !candidates.some((candidate) => candidate.toLowerCase() === clean.toLowerCase())) {
      candidates.push(clean);
    }
  }

  if (!candidates.some((candidate) => candidate.toLowerCase() === text.toLowerCase())) {
    candidates.push(text);
  }
}

export function getLiveNameCandidates(route: RouteListItem): string[] {
  const candidates: string[] = [];
  addUniqueLiveName(candidates, route.destination);
  addUniqueLiveName(candidates, route.catalogNombre);
  addUniqueLiveName(candidates, route.name);
  addUniqueLiveName(candidates, route.origin);
  route.stops?.slice(0, 1).forEach((stop) => addUniqueLiveName(candidates, stop.nombre));
  route.stops?.slice(-1).forEach((stop) => addUniqueLiveName(candidates, stop.nombre));
  return candidates;
}

/**
 * Builds the unified route list from the catalog, enriching it with ArcGIS
 * troncal geometries and (optionally) zonal stop mappings when available.
 */
export function buildRouteList(
  troncalRoutes: TroncalRouteFeature[],
  catalog: MasterCatalog,
  zonalStops: any[] = [],
  zonalMappings: any[] = []
): RouteListItem[] {
  // 1. Build authoritative catalog items
  const catalogItems = buildCatalogRouteList(catalog);
  const mergedRoutes = new Map<string, RouteListItem>();
  const catalogItemsByBaseAndType = new Map<string, RouteListItem[]>();

  const indexCatalogRoute = (route: RouteListItem) => {
    const indexKey = `${getBaseRouteCode(route.code)}|${route.type}`;
    const routes = catalogItemsByBaseAndType.get(indexKey) ?? [];
    routes.push(route);
    catalogItemsByBaseAndType.set(indexKey, routes);
  };

  const endpointMatches = (left: string, right: string) =>
    Boolean(left && right && (left.includes(right) || right.includes(left)));

  const findCatalogRouteForArcgis = (
    baseCode: string,
    type: 'troncal' | 'zonal',
    normOrigin: string,
    normDest: string
  ): RouteListItem | undefined => {
    const candidates = catalogItemsByBaseAndType.get(`${baseCode}|${type}`) ?? [];
    if (candidates.length === 0) return undefined;

    return candidates.find((candidate) => {
      const candidateOrigin = cleanRouteText(candidate.origin);
      const candidateDest = cleanRouteText(candidate.destination);
      return endpointMatches(candidateOrigin, normOrigin) && endpointMatches(candidateDest, normDest);
    }) ?? (candidates.length === 1 ? candidates[0] : undefined);
  };

  // Add all catalog items keyed by a unified baseCode|type|origin|dest key
  catalogItems.forEach((catRoute) => {
    const baseCode = getBaseRouteCode(catRoute.code);
    const normOrigin = cleanRouteText(catRoute.origin);
    const normDest = cleanRouteText(catRoute.destination);
    const key = `${baseCode}|${catRoute.type}|${normOrigin}|${normDest}`;

    mergedRoutes.set(key, catRoute);
    indexCatalogRoute(catRoute);
  });

  // 2. Process Troncal geometries from ArcGIS to enrich catalog items
  troncalRoutes.forEach((r) => {
    let code = r.attributes.route_name_ruta_troncal;
    if (!code) return;

    const baseCode = getBaseRouteCode(code.replace(/-\d$/, ''));
    const origin = r.attributes.origen_ruta_troncal || '';
    const destination = r.attributes.destino_ruta_troncal || '';
    const normOrigin = cleanRouteText(origin);
    const normDest = cleanRouteText(destination);

    const key = `${baseCode}|troncal|${normOrigin}|${normDest}`;

    const existing = mergedRoutes.get(key) ?? findCatalogRouteForArcgis(baseCode, 'troncal', normOrigin, normDest);
    if (existing) {
      if (r.geometry) existing.geometry = r.geometry;
      if (!existing.length && r.attributes.longitud_ruta_troncal) {
        existing.length = r.attributes.longitud_ruta_troncal;
      }
    }
  });

  // 3. Enrich Zonal routes with stops from mappings if missing
  if (zonalStops.length > 0 && zonalMappings.length > 0) {
    const stopLookup = new Map<string, any>();
    zonalStops.forEach(s => {
      const cenefa = s.attributes?.cenefa;
      if (cenefa) stopLookup.set(cenefa, s);
    });

    const routeToStops = new Map<string, any[]>();
    zonalMappings.forEach(m => {
      const routeCode = normalizeRouteCodeForMatch(m.attributes?.ruta);
      const cenefa = m.attributes?.cenefa;
      if (routeCode && cenefa && stopLookup.has(cenefa)) {
        const stop = stopLookup.get(cenefa);
        if (!stop?.geometry || stop.geometry.x == null || stop.geometry.y == null) return;
        if (!routeToStops.has(routeCode)) routeToStops.set(routeCode, []);
        routeToStops.get(routeCode)!.push({
          nombre: stop.attributes?.nombre || 'Paradero',
          codigo: cenefa,
          coordinate: [stop.geometry.x, stop.geometry.y] as [number, number],
          direccion: stop.attributes?.direccion_bandera || stop.attributes?.via || '',
          kind: 'stop',
        });
      }
    });

    // Apply to mergedRoutes
    for (const route of mergedRoutes.values()) {
      if (route.type === 'zonal' && (!route.stops || route.stops.length === 0)) {
        const stops = routeToStops.get(normalizeRouteCodeForMatch(route.code));
        if (stops) {
          route.stops = dedupeStops(stops);
        }
      }
    }
  }

  return Array.from(mergedRoutes.values());
}
