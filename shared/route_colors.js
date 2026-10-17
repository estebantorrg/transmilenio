/**
 * The colour a service is drawn in — the app's palette, one copy for the three
 * surfaces that draw it: the website, the APK (both through
 * `client/src/utils/routeColors.ts`) and the server's prerendered pages and
 * social cards (`server/src/services/route_colors.ts`, spec §5.4.3).
 *
 * The server used to keep a hand mirror of this, "change both together", with
 * no test holding them together, and it had drifted: it coloured a two-letter
 * prefix by its first letter while the app took the last, so SE10/SE14 and
 * TC10/TC14/TC30 wore one colour on their station pages and another in the app.
 */

// The official corridor colours — Manual de imagen y normas gráficas V.6
// (Resolución 511 de 2025), "Colores – identificación de servicios", which gives
// each letter its Pantone, CMYK, RGB and hex. The catalog's own troncal routes
// carry these exact values, all thirteen letters, so the manual is not a design
// aspiration here but what TRANSMILENIO's own systems use. The palette it replaces
// was not invented: A `#0C3A95` and H `#FF8525` are what the October 2022 route
// plegables still print (`#0c3b96` / `#ff8525` in their vector fills). The printed
// pieces lag the manual; the manual and the catalog agree, so they win. It also
// gave M a purple and P a navy that the manual colours differently — M takes
// Carrera 10's teal. Zonal zones reuse the same letters and colours by design: a
// zonal service is coloured by its DESTINATION zone.
/** @type {Record<string, string>} */
export const TRONCAL_COLORS = {
  A: '#26358C', // Caracas / Centro — Pantone Reflex Blue C
  B: '#80BA27', // Norte / Usaquén — Pantone 368 C
  C: '#FCBD1B', // Suba
  D: '#8064A9', // Calle 80 / Engativá
  E: '#AE6B00', // NQS Central — Pantone 724 C
  F: '#DC0814', // Américas / Kennedy
  G: '#009CDE', // NQS Sur / Bosa
  H: '#F18500', // Caracas Sur / Usme–Ciudad Bolívar — Pantone Orange 021 C
  J: '#E1A2AC', // Eje Ambiental — Pantone 507 C
  K: '#D5B079', // Calle 26 / Fontibón — Pantone 465 C
  L: '#009A9D', // Carrera 10 / San Cristóbal
  M: '#009A9D', // Carrera 7 — the manual gives it Carrera 10's teal, not a colour of its own
  P: '#A80F79', // Avenida 68
  T: '#808000',
  RF: '#000000',
  // Same red as `F`, deliberately: the `Z…` services are the second direction of
  // the Américas family (`F63`/`Z63` on the Bosa–Tibanica extension), so they
  // ride and colour the same trunk. A colour of their own split one corridor into
  // two on the map.
  Z: '#DC0814',
  // Same cyan as `G`, for the same reason. The `S…` services (S41…S48) are the
  // Soacha extension — everything running past Portal Sur to Bosa, La Despensa,
  // León XIII, Terreros and San Mateo — and they ride the NQS Sur trunk out of
  // the city. The stations get their own corridor NAME on the estación page
  // ("Soacha", `station_corridors.json`), because that is what the signage and
  // the rider call it; the trunk they ride is still G's, so giving S its own
  // colour would draw one busway in two.
  S: '#009CDE',
};

export const ALIMENTADOR_COLOR = '#009944';
export const RUTA_FACIL_COLOR = '#000000';
export const DEFAULT_TRONCAL_COLOR = '#FB2C17';
export const DEFAULT_ZONAL_COLOR = '#00608B';

// Letters that name a corridor/zone, i.e. exactly the keys of TRONCAL_COLORS.
// `Z` used to be missing here while the palette (and spec §5.4.3) declared
// `Z: #EAB308`, so Z-coded routes could never reach their own colour and the
// entry was unreachable config. `S` was missing the same way the day the Soacha
// services appeared, which would have drawn S41…S48 in the default red instead
// of their trunk's cyan. Keep this class and TRONCAL_COLORS in step.
const ROUTE_ZONE_PREFIX_RE = /^(MP|RF|[A-HJ-MPSTZ]{1,2})(?=\d|-|\b)/;
const RUTA_FACIL_CODES = new Set(['1', '2', '3', '4', '5', '6', '7', '8']);

/** The colour if it is a usable hex; white and near-white are invisible on the dark map. */
export function validHexColor(value) {
  const color = value?.trim() ?? '';
  if (!/^#[0-9A-F]{6}$/i.test(color)) return null;
  const r = parseInt(color.slice(1, 3), 16);
  const g = parseInt(color.slice(3, 5), 16);
  const b = parseInt(color.slice(5, 7), 16);
  if (r > 240 && g > 240 && b > 240) return null;
  return color;
}

export function normalizeRouteCode(value) {
  return (value ?? '').trim().replace(/\s+/g, ' ').toUpperCase();
}

export function normalizeRouteCodeForMatch(value) {
  return normalizeRouteCode(value)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
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
 * Pass `network` wherever it is known; omitting it keeps the code-shape-only
 * answer and is correct only in troncal-only contexts.
 */
export function isRutaFacilCode(value, network) {
  if (network === 'zonal') return false;
  const normalized = normalizeRouteCodeForMatch(value);
  if (!normalized) return false;
  return RUTA_FACIL_CODES.has(normalized) || normalized.includes('RUTAFACIL');
}

export function getRouteZoneLetters(value, network) {
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

export function getTroncalLetter(value) {
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

export function getTroncalColor(value) {
  const letter = getTroncalLetter(value);
  return letter ? TRONCAL_COLORS[letter] ?? DEFAULT_TRONCAL_COLOR : DEFAULT_TRONCAL_COLOR;
}

/**
 * Color for a stop/paradero route tag — and for a service's chip anywhere.
 * Uses the route code to derive a zone-based color, falling back to a
 * validated catalog color, then to the default zonal color.
 *
 * `network` is the network the tag is being rendered FOR (the popup's own stop,
 * the route item's own type) — a zonal service is never a ruta fácil no matter
 * what its número looks like.
 */
export function getStopTagColor(code, catalogColor, network) {
  if (isRutaFacilCode(code, network)) return RUTA_FACIL_COLOR;

  const normalized = normalizeRouteCodeForMatch(code);
  if (/^\d+-\d+$/.test(normalized)) return ALIMENTADOR_COLOR;

  const routeLetters = getRouteZoneLetters(code, network);
  if (routeLetters.length > 0) return getTroncalColor(code);

  return validHexColor(catalogColor) ?? DEFAULT_ZONAL_COLOR;
}
