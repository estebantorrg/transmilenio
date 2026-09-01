import type { RouteListItem } from '../types/transmilenio';

export const TRONCAL_COLORS: Record<string, string> = {
  A: '#0C3A95',
  B: '#75C347',
  C: '#FFB741',
  D: '#6867B4',
  E: '#B76416',
  F: '#FB2C17',
  G: '#00B0E8',
  H: '#FF8525',
  J: '#E49DAA',
  K: '#D3AA78',
  L: '#00B0A9',
  M: '#852D89',
  P: '#25206F',
  T: '#808000',
  RF: '#000000',
  // Same red as `F`, deliberately: the `Z…` services are the second direction of
  // the Américas family (`F63`/`Z63` on the Bosa–Tibanica extension), so they
  // ride and colour the same trunk. A colour of their own split one corridor into
  // two on the map.
  Z: '#FB2C17',
  // Same cyan as `G`, for the same reason. The `S…` services (S41…S48) are the
  // Soacha extension — everything running past Portal Sur to Bosa, La Despensa,
  // León XIII, Terreros and San Mateo — and they ride the NQS Sur trunk out of
  // the city. The stations get their own corridor NAME on the estación page
  // ("Soacha", `station_corridors.json`), because that is what the signage and
  // the rider call it; the trunk they ride is still G's, so giving S its own
  // colour would draw one busway in two.
  S: '#00B0E8',
};

/** The two networks a service can belong to — `RouteListItem['type']`. */
export type RouteNetwork = 'troncal' | 'zonal';

export const ALIMENTADOR_COLOR = '#009944';
export const RUTA_FACIL_COLOR = '#000000';
export const DEFAULT_TRONCAL_COLOR = '#FB2C17';
export const DEFAULT_ZONAL_COLOR = '#00608B';

// Shared map/system semantic colors so the website and the mobile app render the
// SAME transit semantics (spec §5.4.3): troncal estación = red, zonal paradero =
// blue, TransMiCable = orange. Per-client chrome/theme stays distinct (§5.2.1b).
export const STATION_COLOR = DEFAULT_TRONCAL_COLOR; // troncal estación (red)
export const PARADERO_COLOR = '#3B82F6';            // zonal paradero (blue)
export const CABLE_COLOR = '#F97316';               // TransMiCable (orange)

// Letters that name a corridor/zone, i.e. exactly the keys of TRONCAL_COLORS.
// `Z` used to be missing here while the palette (and spec §5.4.3) declared
// `Z: #EAB308`, so Z-coded routes could never reach their own colour and the
// entry was unreachable config. `S` was missing the same way the day the Soacha
// services appeared, which would have drawn S41…S48 in the default red instead
// of their trunk's cyan. Keep this class and TRONCAL_COLORS in step.
const ROUTE_ZONE_PREFIX_RE = /^(MP|RF|[A-HJ-MPSTZ]{1,2})(?=\d|-|\b)/;
const RUTA_FACIL_CODES = new Set(['1', '2', '3', '4', '5', '6', '7', '8']);

function validHexColor(value: string | null | undefined): string | null {
  const color = value?.trim() ?? '';
  if (!/^#[0-9A-F]{6}$/i.test(color)) return null;
  // Reject white / near-white — invisible on dark backgrounds
  const r = parseInt(color.slice(1, 3), 16);
  const g = parseInt(color.slice(3, 5), 16);
  const b = parseInt(color.slice(5, 7), 16);
  if (r > 240 && g > 240 && b > 240) return null;
  return color;
}

export function normalizeRouteCode(value: string | null | undefined): string {
  return (value ?? '').trim().replace(/\s+/g, ' ').toUpperCase();
}

export function normalizeRouteCodeForMatch(value: string | null | undefined): string {
  return normalizeRouteCode(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s*\([^)]*\)\s*$/g, '')
    .replace(/\s+/g, '');
}

/**
 * `RF` is a TRONCAL service family, so the network is part of the test — the
 * número alone is not. The catalog files four variants under código `7`: the two
 * rutas fáciles (`7 Portal Suba`, `7 Polo FINCOMERCIO`, `TransMilenio/TRONCAL`)
 * **and** two SITP zonal services (`7 Palmitas`, `7 Consuelo`,
 * `TransMiZonal/URBANO`). A code-only test called all four rutas fáciles: the
 * zonal pair wore the black RF badge and answered the "Fácil" filter.
 *
 * Pass `network` (or use `isRutaFacilRoute`) wherever it is known; omitting it
 * keeps the code-shape-only answer and is correct only in troncal-only contexts.
 */
export function isRutaFacilCode(value: string | null | undefined, network?: RouteNetwork): boolean {
  if (network === 'zonal') return false;
  const normalized = normalizeRouteCodeForMatch(value);
  if (!normalized) return false;
  return RUTA_FACIL_CODES.has(normalized) || normalized.includes('RUTAFACIL');
}

/** The unambiguous form: a route item always carries its own network. */
export function isRutaFacilRoute(route: Pick<RouteListItem, 'code' | 'type'>): boolean {
  return isRutaFacilCode(route.code, route.type);
}

export function getRouteZoneLetters(value: string | null | undefined, network?: RouteNetwork): string[] {
  const normalized = normalizeRouteCodeForMatch(value);
  if (!normalized) return [];
  if (isRutaFacilCode(normalized, network)) return ['RF'];

  const prefix = normalized.match(ROUTE_ZONE_PREFIX_RE)?.[1];
  if (!prefix) return [];
  // Same rule as above: the RF family is troncal-only, so a zonal service never
  // carries it. Every other letter is shared by both networks on purpose — a
  // zonal `T25` and a troncal `T…` are the same corridor colour (spec §5.4.3).
  if (prefix === 'RF') return network === 'zonal' ? [] : ['RF'];
  if (prefix === 'MP') return ['M', 'P'];

  return Array.from(prefix).filter((letter) => letter in TRONCAL_COLORS);
}

export function getTroncalLetter(value: string | null | undefined): string | null {
  const normalized = normalizeRouteCode(value);
  if (!normalized) return null;

  if (isRutaFacilCode(normalized)) return 'RF';

  // AV. 1 de Mayo belongs visually to the Carrera 10 trunk (L), not to the
  // first "A" in "AV." or the occasional "G" prefix in source data.
  if (/(^|\b)(AV\.?\s*)?1(\s+DE)?\s+MAYO\b/.test(normalized) || /\b(CARRERA|CRA|KR)\s*10\b/.test(normalized)) {
    return 'L';
  }

  const routeLetters = getRouteZoneLetters(normalized);
  if (routeLetters.length > 0) return routeLetters[routeLetters.length - 1];

  const letter = normalized.match(/\b(RF|[A-HJ-MPTZ])\b/);
  return letter ? letter[1] : null;
}

export function getTroncalColor(value: string | null | undefined): string {
  const letter = getTroncalLetter(value);
  return letter ? TRONCAL_COLORS[letter] ?? DEFAULT_TRONCAL_COLOR : DEFAULT_TRONCAL_COLOR;
}

export function getZonalRouteColor(code?: string | null): string {
  const normalized = normalizeRouteCode(code);

  if (/^\d+-\d+$/.test(normalized)) {
    return ALIMENTADOR_COLOR;
  }

  return DEFAULT_ZONAL_COLOR;
}

export function getRouteColor(code: string, type: 'troncal' | 'zonal'): string {
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

/**
 * Color for a stop/paradero route tag.
 * Uses the route code to derive a zone-based color, falling back to a
 * validated catalog color, then to the default zonal color.
 * This is the SINGLE source of truth for paradero popup route badge colors.
 *
 * `network` is the network the tag is being rendered FOR (the popup's own stop,
 * the route item's own type) — a zonal service is never a ruta fácil no matter
 * what its número looks like.
 */
export function getStopTagColor(code: string, catalogColor?: string | null, network?: RouteNetwork): string {
  if (isRutaFacilCode(code, network)) return RUTA_FACIL_COLOR;

  const normalized = normalizeRouteCodeForMatch(code);
  if (/^\d+-\d+$/.test(normalized)) return ALIMENTADOR_COLOR;

  const routeLetters = getRouteZoneLetters(code, network);
  if (routeLetters.length > 0) return getTroncalColor(code);

  const catalog = validHexColor(catalogColor);
  if (catalog) return catalog;

  return DEFAULT_ZONAL_COLOR;
}
