import type { RouteListItem } from '../types/transmilenio';
import {
  ALIMENTADOR_COLOR,
  DEFAULT_TRONCAL_COLOR,
  DEFAULT_ZONAL_COLOR,
  RUTA_FACIL_COLOR,
  getRouteZoneLetters,
  getStopTagColor,
  getTroncalColor,
  isRutaFacilCode,
  normalizeRouteCode,
  validHexColor,
  type RouteNetwork,
} from '../../../shared/route_colors.js';

// The palette and the código → colour rules are `shared/route_colors.js`, which
// the server's prerendered pages read too, so a chip cannot be one colour in the
// app and another on its station page. What stays here needs the client's types.
export {
  ALIMENTADOR_COLOR,
  DEFAULT_TRONCAL_COLOR,
  DEFAULT_ZONAL_COLOR,
  RUTA_FACIL_COLOR,
  TRONCAL_COLORS,
  getRouteZoneLetters,
  getStopTagColor,
  getTroncalColor,
  getTroncalLetter,
  isRutaFacilCode,
  normalizeRouteCode,
  normalizeRouteCodeForMatch,
} from '../../../shared/route_colors.js';
export type { RouteNetwork };

// Shared map/system semantic colors so the website and the mobile app render the
// SAME transit semantics (spec §5.4.3): troncal estación = red, zonal paradero =
// blue, TransMiCable = orange. Per-client chrome/theme stays distinct (§5.2.1b).
export const STATION_COLOR = DEFAULT_TRONCAL_COLOR; // troncal estación (red)
export const PARADERO_COLOR = '#3B82F6';            // zonal paradero (blue)
export const CABLE_COLOR = '#F97316';               // TransMiCable (orange)

/** The unambiguous form of `isRutaFacilCode`: a route item always carries its own network. */
export function isRutaFacilRoute(route: Pick<RouteListItem, 'code' | 'type'>): boolean {
  return isRutaFacilCode(route.code, route.type);
}

export function getZonalRouteColor(code?: string | null): string {
  const normalized = normalizeRouteCode(code);

  if (/^\d+-\d+$/.test(normalized)) {
    return ALIMENTADOR_COLOR;
  }

  return DEFAULT_ZONAL_COLOR;
}

export function getRouteColor(code: string, type: RouteNetwork): string {
  return type === 'troncal' ? getTroncalColor(code) : getZonalRouteColor(code);
}

export function isAlimentadorRoute(route: Pick<RouteListItem, 'subType' | 'busType'>): boolean {
  const subType = normalizeRouteCode(route.subType);
  const busType = normalizeRouteCode(route.busType);
  return subType === 'ALIMENTADOR' || busType.includes('ALIMENTADOR');
}

export function getRouteAccentColor(
  route: Pick<RouteListItem, 'code' | 'type' | 'subType' | 'busType' | 'color'>
): string {
  if (isAlimentadorRoute(route)) return ALIMENTADOR_COLOR;
  if (isRutaFacilRoute(route)) return RUTA_FACIL_COLOR;

  if (route.type === 'troncal') {
    const routeLetters = getRouteZoneLetters(route.code, 'troncal');
    if (routeLetters.length > 0) return getTroncalColor(route.code);
    return validHexColor(route.color) ?? getTroncalColor(route.code);
  }

  return getStopTagColor(route.code, route.color, 'zonal');
}
