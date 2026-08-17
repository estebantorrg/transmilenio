/**
 * Route service-type classification.
 *
 * The master catalog attaches a route to a stop purely by stop `codigo`, with
 * no guard on whether the route's network matches the stop's network. As a
 * result feeder/zonal routes leak into troncal *station* popups and troncal
 * routes leak into zonal *paradero* popups. The popups read this index to keep
 * each popup showing only the routes that actually belong to its network.
 *
 * Classification is derived from every variant of a route in `catalog.routes`,
 * which is the only place that always carries `sistema`/`tipoServicio`.
 */

import type { MasterCatalog } from '../types/catalog';
import { normalizeRouteCodeForMatch, type RouteNetwork } from './routeColors';

export type RouteServiceType = 'troncal' | 'zonal' | 'dual';

/**
 * A service belongs to the zonal network if its system or service type names
 * the zonal network (`TransMiZonal`, `…ZONAL`) or the feeder buses
 * (`ALIMENTADOR`). `TRANSMIZONAL` already contains the `ZONAL` substring.
 */
export function isZonalService(sistema?: string | null, tipoServicio?: string | null): boolean {
  const service = `${sistema ?? ''} ${tipoServicio ?? ''}`.toUpperCase();
  return service.includes('ZONAL') || service.includes('ALIMENTADOR');
}

/**
 * The network ONE catalog entry belongs to. Every `stations.wagons` entry and
 * every `catalog.routes` variant carries `sistema`/`tipoServicio`, so a tag can
 * be resolved exactly instead of guessing from the código — which is ambiguous
 * wherever the two networks reuse a número (código `7`, see `isRutaFacilCode`).
 */
export function catalogRouteNetwork(route: { sistema?: string | null; tipoServicio?: string | null }): RouteNetwork {
  return isZonalService(route.sistema, route.tipoServicio) ? 'zonal' : 'troncal';
}

let index: Map<string, RouteServiceType> = new Map();
let stationCodes: Set<string> = new Set();

/**
 * Rebuilds the catalog-derived indexes: código → service type, and which nodes
 * are estaciones (`station.estacion`, stamped server-side from the official
 * register, §5.1.4). Both clients call this once per catalog load, which is why
 * the station index lives here rather than beside its reader — a station that
 * opens without a TM code (Tibanica - Primavera, Los Laureles, Islandia) is
 * then an estación on every surface at once, with no code change (§5.5.6).
 */
export function setCatalogIndexes(catalog: MasterCatalog): void {
  const next = new Map<string, RouteServiceType>();

  for (const [code, variants] of Object.entries(catalog.routes || {})) {
    const key = normalizeRouteCodeForMatch(code);
    if (!key) continue;

    let troncal = false;
    let zonal = false;
    for (const variant of variants) {
      if (isZonalService(variant.sistema, variant.tipoServicio)) zonal = true;
      else troncal = true;
    }

    next.set(key, troncal && zonal ? 'dual' : zonal ? 'zonal' : 'troncal');
  }

  const nextStations = new Set<string>();
  for (const [key, station] of Object.entries(catalog.stations || {})) {
    if (!station?.estacion) continue;
    const code = String(station.codigo || key).trim().toUpperCase();
    if (code) nextStations.add(code);
  }

  index = next;
  stationCodes = nextStations;
}

/** True when the loaded catalog stamped this node as an estación. */
export function isStampedStationCode(code: string | null | undefined): boolean {
  const key = String(code ?? '').trim().toUpperCase();
  return key !== '' && stationCodes.has(key);
}

export function getRouteServiceType(code: string | null | undefined): RouteServiceType | undefined {
  return index.get(normalizeRouteCodeForMatch(code));
}

/**
 * Whether a route may appear in a zonal **paradero** popup. Dual routes serve
 * paraderos too, so only purely-troncal routes are excluded. Codes unknown to
 * the index (e.g. zonal-only ArcGIS mappings) are kept.
 *
 * Station popups use a different, wagon-aware rule (see `stations.ts`): the
 * feeder/integration platform legitimately carries zonal & feeder routes, so
 * the test there is the boarding platform, not the route code alone.
 */
export function servesZonal(code: string): boolean {
  const type = getRouteServiceType(code);
  return type ? type !== 'troncal' : true;
}
