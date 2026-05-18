import type { CatalogRoute, CatalogStation, MasterCatalog } from '../types/catalog';
import type { TroncalStationFeature } from '../types/transmilenio';

const APP_STOP_CODE_RE = /^TM\d+$/i;
const TERMINAL_PLATFORM_RADIUS_M = 180;
const NAME_MATCH_RADIUS_M = 450;
const NEARBY_AUDIT_RADIUS_M = 700;

interface LngLat {
  lng: number;
  lat: number;
}

interface ResolverIndexes {
  appStops: CatalogStation[];
  platformFragments: CatalogStation[];
  byStopCode: Map<string, CatalogStation>;
  byStopId: Map<string, CatalogStation[]>;
}

interface SourceSelection {
  station: CatalogStation;
  allowedWagons?: Set<string>;
}

interface VerifiedSplit {
  matchMethod: string;
  sourceStopCode: string;
  wagons: string[];
  stationNodes: string[];
  stationNames: string[];
  note: string;
}

export interface ResolvedCatalogRoute extends CatalogRoute {
  sourceStopCode?: string;
  sourceStopId?: string;
  sourceStopName?: string;
  sourceStopAddress?: string;
}

export interface ResolvedCatalogWagons {
  [wagonLabel: string]: ResolvedCatalogRoute[];
}

export interface ResolvedSourceStop {
  id: string;
  codigo: string;
  nombre: string;
  direccion: string;
  coordenada: string;
  distanceMeters: number | null;
}

export interface NearbyAppStop {
  id: string;
  codigo: string;
  nombre: string;
  distanceMeters: number;
}

export interface StationCatalogAudit {
  stationKey: string;
  stationName: string;
  stationCode: string;
  stationNode: string;
  matchMethod: string;
  sourceStopIds: string[];
  sourceStopCodes: string[];
  sourceStopCount: number;
  wagonCount: number;
  routeCount: number;
  routeMappingCount: number;
  nearestUnusedAppStops: NearbyAppStop[];
  notes: string[];
}

export interface ResolvedCatalogStation {
  stationKey: string;
  stationName: string;
  stationCode: string;
  stationNode: string;
  matchMethod: string;
  wagons: ResolvedCatalogWagons;
  sourceStops: ResolvedSourceStop[];
  audit: StationCatalogAudit;
}

export interface StationCatalogResolution {
  stationsByKey: Record<string, ResolvedCatalogStation>;
  audit: StationCatalogAudit[];
}

const VERIFIED_SPLITS: VerifiedSplit[] = [
  {
    matchMethod: 'verified-split:av-jimenez-caracas',
    sourceStopCode: 'TM0013',
    wagons: ['A', 'B', 'C'],
    stationNodes: ['9110'],
    stationNames: ['AVJIMENEZCARACAS'],
    note: 'Official app stop TM0013 combines Avenida Jimenez; ArcGIS exposes Caracas as its own 3-wagon point.',
  },
  {
    matchMethod: 'verified-split:av-jimenez-cl13',
    sourceStopCode: 'TM0013',
    wagons: ['D', 'E'],
    stationNodes: ['14003'],
    stationNames: ['AVJIMENEZCL13'],
    note: 'Official app stop TM0013 combines Avenida Jimenez; ArcGIS exposes Calle 13 as its own 2-wagon point.',
  },
  {
    matchMethod: 'verified-split:ricaurte-nqs',
    sourceStopCode: 'TM0069',
    wagons: ['A', 'B', 'C'],
    stationNodes: ['7111'],
    stationNames: ['RICAURTENQS'],
    note: 'Official app stop TM0069 combines Ricaurte; ArcGIS exposes NQS as its own 3-wagon point.',
  },
  {
    matchMethod: 'verified-split:ricaurte-cl13',
    sourceStopCode: 'TM0069',
    wagons: ['D', 'E', 'F'],
    stationNodes: ['12003'],
    stationNames: ['RICAURTECL13'],
    note: 'Official app stop TM0069 combines Ricaurte; ArcGIS exposes Calle 13 as its own 3-wagon point.',
  },
];

export function normalizeStationName(value: string | null | undefined): string {
  if (!value) return '';
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

function normalizeNumericId(value: string | number | null | undefined): string {
  const text = String(value ?? '').trim();
  if (!text) return '';
  return /^\d+$/.test(text) ? text.replace(/^0+/, '') || '0' : text.toUpperCase();
}

function appStopKey(code: string): string {
  return code.trim().toUpperCase();
}

function isAppStop(station: CatalogStation): boolean {
  return APP_STOP_CODE_RE.test(station.codigo);
}

function finiteNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function stationName(feature: TroncalStationFeature): string {
  return feature.attributes.nombre_estacion || '';
}

function stationCode(feature: TroncalStationFeature): string {
  return String(feature.attributes.numero_estacion ?? '').trim();
}

export function stationNode(feature: TroncalStationFeature): string {
  const node = feature.attributes.codigo_nodo_estacion;
  return normalizeNumericId(node ?? feature.attributes.numero_estacion);
}

export function buildStationKey(feature: TroncalStationFeature): string {
  return stationCode(feature) || stationNode(feature) || normalizeStationName(stationName(feature));
}

function stationPoint(feature: TroncalStationFeature): LngLat | null {
  const lat = finiteNumber(feature.attributes.latitud_estacion);
  const lng = finiteNumber(feature.attributes.longitud_estacion);
  if (lat !== null && lng !== null) return { lat, lng };

  const geomLng = finiteNumber(feature.geometry.x);
  const geomLat = finiteNumber(feature.geometry.y);
  return geomLat !== null && geomLng !== null
    ? { lat: geomLat, lng: geomLng }
    : null;
}

function catalogPoint(station: CatalogStation): LngLat | null {
  const [latText, lngText] = station.coordenada.split(',');
  const lat = finiteNumber(latText);
  const lng = finiteNumber(lngText);
  return lat !== null && lng !== null ? { lat, lng } : null;
}

function distanceMeters(a: LngLat | null, b: LngLat | null): number | null {
  if (!a || !b) return null;
  const toRad = (degrees: number) => (degrees * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(h));
}

function buildIndexes(catalog: MasterCatalog): ResolverIndexes {
  const stations = Object.values(catalog) as CatalogStation[];
  const appStops = stations.filter(isAppStop);
  const platformFragments = stations.filter((station) => !isAppStop(station));
  const byStopCode = new Map<string, CatalogStation>();
  const byStopId = new Map<string, CatalogStation[]>();

  for (const station of stations) {
    byStopCode.set(appStopKey(station.codigo), station);

    const id = normalizeNumericId(station.id);
    if (!id) continue;
    const entries = byStopId.get(id) ?? [];
    entries.push(station);
    byStopId.set(id, entries);
  }

  return { appStops, platformFragments, byStopCode, byStopId };
}

function routeIdentity(route: CatalogRoute): string {
  return [
    route.id ?? '',
    normalizeStationName(route.codigo),
    normalizeStationName(route.nombre),
  ].join('|');
}

function mergeWagons(target: ResolvedCatalogWagons, selection: SourceSelection): void {
  for (const [wagonLabel, routes] of Object.entries(selection.station.wagons)) {
    if (selection.allowedWagons && !selection.allowedWagons.has(wagonLabel)) continue;
    const targetRoutes = target[wagonLabel] ?? [];
    const seen = new Set(targetRoutes.map(routeIdentity));

    for (const route of routes) {
      const resolvedRoute: ResolvedCatalogRoute = {
        ...route,
        sourceStopCode: selection.station.codigo,
        sourceStopId: selection.station.id,
        sourceStopName: selection.station.nombre,
        sourceStopAddress: selection.station.direccion,
      };
      const key = routeIdentity(resolvedRoute);
      if (seen.has(key)) continue;
      seen.add(key);
      targetRoutes.push(resolvedRoute);
    }

    target[wagonLabel] = targetRoutes;
  }
}

function sourceStopSummary(feature: TroncalStationFeature, station: CatalogStation): ResolvedSourceStop {
  const distance = distanceMeters(stationPoint(feature), catalogPoint(station));
  return {
    id: station.id,
    codigo: station.codigo,
    nombre: station.nombre,
    direccion: station.direccion,
    coordenada: station.coordenada,
    distanceMeters: distance === null ? null : Math.round(distance),
  };
}

function countUniqueRoutes(wagons: ResolvedCatalogWagons): number {
  const routes = new Set<string>();
  Object.values(wagons).forEach((wagonRoutes) => {
    wagonRoutes.forEach((route) => routes.add(routeIdentity(route)));
  });
  return routes.size;
}

function countRouteMappings(wagons: ResolvedCatalogWagons): number {
  return Object.values(wagons).reduce((sum, routes) => sum + routes.length, 0);
}

function nearbyUnusedAppStops(
  feature: TroncalStationFeature,
  indexes: ResolverIndexes,
  usedStopCodes: Set<string>
): NearbyAppStop[] {
  const origin = stationPoint(feature);
  if (!origin) return [];

  return indexes.appStops
    .map((station) => {
      const distance = distanceMeters(origin, catalogPoint(station));
      return distance === null
        ? null
        : {
            id: station.id,
            codigo: station.codigo,
            nombre: station.nombre || station.direccion || station.codigo,
            distanceMeters: Math.round(distance),
          };
    })
    .filter((station): station is NearbyAppStop =>
      Boolean(
        station &&
          station.distanceMeters <= NEARBY_AUDIT_RADIUS_M &&
          !usedStopCodes.has(station.codigo)
      )
    )
    .sort((a, b) => a.distanceMeters - b.distanceMeters)
    .slice(0, 6);
}

function makeResolvedStation(
  feature: TroncalStationFeature,
  matchMethod: string,
  selections: SourceSelection[],
  indexes: ResolverIndexes,
  notes: string[] = []
): ResolvedCatalogStation {
  const wagons: ResolvedCatalogWagons = {};
  selections.forEach((selection) => mergeWagons(wagons, selection));

  const sourceStops = selections.map((selection) => sourceStopSummary(feature, selection.station));
  const sourceStopCodes = sourceStops.map((stop) => stop.codigo);
  const sourceStopIds = sourceStops.map((stop) => stop.id);
  const usedStopCodes = new Set(sourceStopCodes);

  const audit: StationCatalogAudit = {
    stationKey: buildStationKey(feature),
    stationName: stationName(feature),
    stationCode: stationCode(feature),
    stationNode: stationNode(feature),
    matchMethod,
    sourceStopIds,
    sourceStopCodes,
    sourceStopCount: sourceStops.length,
    wagonCount: Object.keys(wagons).length,
    routeCount: countUniqueRoutes(wagons),
    routeMappingCount: countRouteMappings(wagons),
    nearestUnusedAppStops: nearbyUnusedAppStops(feature, indexes, usedStopCodes),
    notes,
  };

  return {
    stationKey: audit.stationKey,
    stationName: audit.stationName,
    stationCode: audit.stationCode,
    stationNode: audit.stationNode,
    matchMethod,
    wagons,
    sourceStops,
    audit,
  };
}

function unresolvedStation(feature: TroncalStationFeature, indexes: ResolverIndexes): ResolvedCatalogStation {
  return makeResolvedStation(feature, 'unmatched', [], indexes, [
    'No safe official app stop match found for this ArcGIS station.',
  ]);
}

function stationMatches(feature: TroncalStationFeature, split: VerifiedSplit): boolean {
  const node = stationNode(feature);
  const normalizedName = normalizeStationName(stationName(feature));
  return split.stationNodes.includes(node) || split.stationNames.includes(normalizedName);
}

function resolveVerifiedSplit(
  feature: TroncalStationFeature,
  indexes: ResolverIndexes
): ResolvedCatalogStation | null {
  const split = VERIFIED_SPLITS.find((candidate) => stationMatches(feature, candidate));
  if (!split) return null;

  const sourceStop = indexes.byStopCode.get(appStopKey(split.sourceStopCode));
  if (!sourceStop) return null;

  return makeResolvedStation(
    feature,
    split.matchMethod,
    [{ station: sourceStop, allowedWagons: new Set(split.wagons) }],
    indexes,
    [split.note]
  );
}

function resolveTerminalPlatformCluster(
  feature: TroncalStationFeature,
  indexes: ResolverIndexes
): ResolvedCatalogStation | null {
  const normalizedName = normalizeStationName(stationName(feature));
  const node = stationNode(feature);
  if (node !== '2502' && normalizedName !== 'TERMINAL') return null;

  const origin = stationPoint(feature);
  const selections: SourceSelection[] = [];
  const coreStop =
    indexes.byStopId.get('2502')?.find(isAppStop) ??
    indexes.byStopCode.get(appStopKey('TM0031'));

  if (coreStop) selections.push({ station: coreStop });

  const platformFragments = indexes.platformFragments
    .map((station) => ({
      station,
      distance: distanceMeters(origin, catalogPoint(station)),
    }))
    .filter(({ station, distance }) => {
      const looksLikeTerminal =
        normalizeStationName(station.direccion) === 'TERMINAL' ||
        normalizeStationName(station.codigo).startsWith('TERMINAL') ||
        normalizeStationName(station.nombre) === 'TERMINAL';
      return looksLikeTerminal && distance !== null && distance <= TERMINAL_PLATFORM_RADIUS_M;
    })
    .sort((a, b) => (a.distance ?? Number.POSITIVE_INFINITY) - (b.distance ?? Number.POSITIVE_INFINITY));

  for (const fragment of platformFragments) {
    if (!selections.some((selection) => selection.station.codigo === fragment.station.codigo)) {
      selections.push({ station: fragment.station });
    }
  }

  return selections.length > 0
    ? makeResolvedStation(feature, 'platform-cluster:terminal', selections, indexes, [
        'Terminal uses official app platform fragments in addition to the TM0031 station stop.',
      ])
    : null;
}

function resolveByExactAppStopId(
  feature: TroncalStationFeature,
  indexes: ResolverIndexes
): ResolvedCatalogStation | null {
  const ids = [stationNode(feature), normalizeNumericId(stationCode(feature))].filter(Boolean);
  const uniqueIds = Array.from(new Set(ids));

  for (const id of uniqueIds) {
    const candidates = indexes.byStopId.get(id)?.filter(isAppStop) ?? [];
    if (candidates.length === 0) continue;

    const origin = stationPoint(feature);
    const best = candidates
      .map((station) => ({ station, distance: distanceMeters(origin, catalogPoint(station)) }))
      .sort((a, b) => (a.distance ?? Number.POSITIVE_INFINITY) - (b.distance ?? Number.POSITIVE_INFINITY))[0];

    return makeResolvedStation(feature, 'app-stop-id', [{ station: best.station }], indexes);
  }

  return null;
}

function baseName(value: string): string {
  return normalizeStationName(value.split('-')[0].replace(/^ESTACION\s+/i, ''));
}

function resolveByNameAndDistance(
  feature: TroncalStationFeature,
  indexes: ResolverIndexes
): ResolvedCatalogStation | null {
  const origin = stationPoint(feature);
  if (!origin) return null;

  const exactName = normalizeStationName(stationName(feature));
  const shortName = baseName(stationName(feature));

  const candidates = indexes.appStops
    .map((station) => {
      const candidateNames = [
        normalizeStationName(station.nombre),
        baseName(station.nombre),
        baseName(station.direccion),
      ];
      const nameMatches = candidateNames.includes(exactName) || candidateNames.includes(shortName);
      const distance = distanceMeters(origin, catalogPoint(station));
      return { station, distance, nameMatches };
    })
    .filter(({ distance, nameMatches }) =>
      Boolean(nameMatches && distance !== null && distance <= NAME_MATCH_RADIUS_M)
    )
    .sort((a, b) => (a.distance ?? Number.POSITIVE_INFINITY) - (b.distance ?? Number.POSITIVE_INFINITY));

  return candidates[0]
    ? makeResolvedStation(feature, 'name-and-distance', [{ station: candidates[0].station }], indexes)
    : null;
}

function resolveOne(feature: TroncalStationFeature, indexes: ResolverIndexes): ResolvedCatalogStation {
  return (
    resolveTerminalPlatformCluster(feature, indexes) ??
    resolveVerifiedSplit(feature, indexes) ??
    resolveByExactAppStopId(feature, indexes) ??
    resolveByNameAndDistance(feature, indexes) ??
    unresolvedStation(feature, indexes)
  );
}

export function resolveStationCatalog(
  stations: TroncalStationFeature[],
  catalog: MasterCatalog
): StationCatalogResolution {
  const indexes = buildIndexes(catalog);
  const stationsByKey: Record<string, ResolvedCatalogStation> = {};
  const audit: StationCatalogAudit[] = [];

  for (const station of stations) {
    const resolved = resolveOne(station, indexes);
    stationsByKey[resolved.stationKey] = resolved;
    audit.push(resolved.audit);
  }

  return { stationsByKey, audit };
}
