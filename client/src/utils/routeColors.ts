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
  Z: '#EAB308',
};

export const ALIMENTADOR_COLOR = '#009944';
export const RUTA_FACIL_COLOR = '#000000';
export const DEFAULT_TRONCAL_COLOR = '#FB2C17';
export const DEFAULT_ZONAL_COLOR = '#00608B';

const ROUTE_ZONE_PREFIX_RE = /^(MP|RF|[A-HJ-MPT]{1,2})(?=\d|-|\b)/;
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

export function isRutaFacilCode(value: string | null | undefined): boolean {
  const normalized = normalizeRouteCodeForMatch(value);
  if (!normalized) return false;
  return RUTA_FACIL_CODES.has(normalized) || normalized.includes('RUTAFACIL');
}

export function getRouteZoneLetters(value: string | null | undefined): string[] {
  const normalized = normalizeRouteCodeForMatch(value);
  if (!normalized) return [];
  if (isRutaFacilCode(normalized)) return ['RF'];

  const prefix = normalized.match(ROUTE_ZONE_PREFIX_RE)?.[1];
  if (!prefix) return [];
  if (prefix === 'RF') return ['RF'];
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

  const letter = normalized.match(/\b(RF|[A-HJ-MPT])\b/);
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
  if (isRutaFacilCode(route.code)) return RUTA_FACIL_COLOR;

  if (route.type === 'troncal') {
    const routeLetters = getRouteZoneLetters(route.code);
    if (routeLetters.length > 0) return getTroncalColor(route.code);
    return validHexColor(route.color) ?? getTroncalColor(route.code);
  }

  return getStopTagColor(route.code, route.color);
}

/**
 * Color for a stop/paradero route tag.
 * Uses the route code to derive a zone-based color, falling back to a
 * validated catalog color, then to the default zonal color.
 * This is the SINGLE source of truth for paradero popup route badge colors.
 */
export function getStopTagColor(code: string, catalogColor?: string | null): string {
  if (isRutaFacilCode(code)) return RUTA_FACIL_COLOR;

  const normalized = normalizeRouteCodeForMatch(code);
  if (/^\d+-\d+$/.test(normalized)) return ALIMENTADOR_COLOR;

  const routeLetters = getRouteZoneLetters(code);
  if (routeLetters.length > 0) return getTroncalColor(code);

  const catalog = validHexColor(catalogColor);
  if (catalog) return catalog;

  return DEFAULT_ZONAL_COLOR;
}
