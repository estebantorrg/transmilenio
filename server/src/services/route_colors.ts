/**
 * The colour a service's chip is drawn in — the app's palette, not the catalog's.
 *
 * **A deliberate mirror of `client/src/utils/routeColors.ts`; change both
 * together.** The two packages compile separately (`rootDir: ./src`), so the
 * server cannot import the client's copy, and the alternative — letting the
 * prerendered pages and the social cards fall back to the raw catalog colour —
 * is what put the two surfaces out of step: measured over the 1 755 services
 * filed on the 139 estación pages, **1 622 (92.4%)** were drawn in a different
 * colour from the app's chip for the same route. Most are near-misses the
 * catalog ships for the same corridor (`#009CDE` against the palette's
 * `#00B0E8`), but the rutas fáciles are a hard disagreement: códigos 1–8 are a
 * TRONCAL family the app paints **black**, while the catalog gives each variant
 * its own colour — which is why one código could appear in two colours on the
 * same station page (spec §5.4.3: both clients render the same transit
 * semantics, and these pages are a third surface onto the same network).
 */

/** Corridor letter → colour. Keep in step with the client's TRONCAL_COLORS. */
export const TRONCAL_COLORS: Record<string, string> = {
  A: '#0C3A95', B: '#75C347', C: '#FFB741', D: '#6867B4', E: '#B76416',
  F: '#FB2C17', G: '#00B0E8', H: '#FF8525', J: '#E49DAA', K: '#D3AA78',
  L: '#00B0A9', M: '#852D89', P: '#25206F', T: '#808000', RF: '#000000',
  Z: '#EAB308',
};

const ALIMENTADOR_COLOR = '#009944';
const DEFAULT_ZONAL_COLOR = '#00608B';
const RUTA_FACIL_CODES = new Set(['1', '2', '3', '4', '5', '6', '7', '8']);
const ROUTE_ZONE_PREFIX_RE = /^(MP|RF|[A-HJ-MPTZ]{1,2})(?=\d|-|\b)/;

function normalizeRouteCodeForMatch(value: string | null | undefined): string {
  return (value ?? '')
    .trim()
    .replace(/\s+/g, ' ')
    .toUpperCase()
    .normalize('NFD')
    // Combining-mark range U+0300–U+036F, same as the client's copy.
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s*\([^)]*\)\s*$/g, '')
    .replace(/\s+/g, '');
}

/** Rejects malformed hex and near-white, which is invisible on this background. */
function validHexColor(value: string | null | undefined): string | null {
  const color = value?.trim() ?? '';
  if (!/^#[0-9A-F]{6}$/i.test(color)) return null;
  const r = parseInt(color.slice(1, 3), 16);
  const g = parseInt(color.slice(3, 5), 16);
  const b = parseInt(color.slice(5, 7), 16);
  return r > 240 && g > 240 && b > 240 ? null : color;
}

/**
 * `RF` is a TRONCAL family, so the network is part of the test: the catalog
 * files zonal services under bare números too (código `7` is both a ruta fácil
 * and a SITP service), and only the troncal one is black.
 */
function isRutaFacil(normalized: string, zonal: boolean): boolean {
  if (zonal) return false;
  return RUTA_FACIL_CODES.has(normalized) || normalized.includes('RUTAFACIL');
}

/** The chip colour for a service, given its código, catalog colour and network. */
export function stopTagColor(code: string, catalogColor: string | null | undefined, zonal: boolean): string {
  const normalized = normalizeRouteCodeForMatch(code);
  if (isRutaFacil(normalized, zonal)) return TRONCAL_COLORS.RF;

  // `12-1` and friends are alimentadores, whose colour is the network's, not a
  // corridor's — the leading digits would otherwise match no letter at all.
  if (/^\d+-\d+$/.test(normalized)) return ALIMENTADOR_COLOR;

  const prefix = normalized.match(ROUTE_ZONE_PREFIX_RE)?.[1];
  if (prefix) {
    if (prefix === 'RF') return zonal ? DEFAULT_ZONAL_COLOR : TRONCAL_COLORS.RF;
    // `MP` is the one two-letter prefix that names two corridors; the client
    // takes the first, so this does too.
    const letters = prefix === 'MP' ? ['M', 'P'] : Array.from(prefix).filter((l) => l in TRONCAL_COLORS);
    if (letters.length > 0) return TRONCAL_COLORS[letters[0]];
  }

  return validHexColor(catalogColor) ?? DEFAULT_ZONAL_COLOR;
}
