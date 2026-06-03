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
import { normalizeRouteCodeForMatch } from './routeColors';

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

let index: Map<string, RouteServiceType> = new Map();

/** Rebuilds the code → service-type index from the loaded catalog. */
export function setRouteTypeIndex(catalog: MasterCatalog): void {
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

  index = next;
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
