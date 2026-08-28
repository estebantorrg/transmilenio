/**
 * El rutero — the LED destination sign a TransMilenio bus carries above its
 * windscreen — drawn from a dot-matrix font instead of set in a typeface.
 *
 * Why a bitmap font and not `font-family: monospace`: the sign is not text in a
 * condensed face, it is ~1 300 discrete LEDs. Riders recognise a route by that
 * grid — the gaps between dots, the two-to-one letter proportion, the halo each
 * lit LED throws onto the black panel. Approximating it with a web font gets the
 * words right and the object wrong, and this surface exists precisely so a rider
 * can match what the page shows against what is coming down the busway.
 *
 * ── Where the geometry comes from ─────────────────────────────────────────
 *
 * The grid is **measured**, on one photograph good enough to resolve individual
 * LEDs — including the *unlit* ones, which is what makes the lattice fittable
 * rather than inferred from lit strokes:
 *
 *   "2019 Bogotá – Estación Parque Tercer Milenio – Buses de Transmilenio en la
 *   avenida Caracas", Felipe Restrepo Acosta, CC BY-SA 4.0, Wikimedia Commons,
 *   5006×3338, near-frontal bi-articulated, sign reading "Hola TransMiCable".
 *
 * Autocorrelating the column profile peaked cleanly at lags 9/17/26; a comb fit
 * then pinned pitch and phase, and each letter was sampled on its own vertical
 * phase so the sign's tilt could not smear a row. Result:
 *
 *   • dot pitch **8.68 px horizontal, 8.70 px vertical** — a square lattice.
 *   • **cap height 11 rows**: the stems of H, M, C and T span 96–98 px, i.e.
 *     11.05–11.28 pitches. (An earlier read of 12 counted a row of bloom.)
 *   • **strokes are 2 dots** — every stem 2 columns, every bar 2 rows.
 *   • **caps are 6 columns** (H, C) and the advance is **7** (H→o and o→l both
 *     measure 7). M is 7 columns, `l` is 2 with a 3-column advance: the real
 *     face is proportional. We render fixed at 6, which is the dominant cap
 *     width — see the note on M and W in the table.
 *   • x-height 9 rows, and lowercase exists. Route displays are all caps, so
 *     only the capitals are drawn here.
 *
 * This corrects the first pass, which read the 2-dot stems as 1-dot and so came
 * out at 5 columns on a 6 advance — too light and too narrow. The reconciliation
 * is exact: a "3 px stem at 9.3 px character pitch", measured off the low-res
 * crops below, *is* a 2-dot stem at 1.33 px/dot on a 7-column advance.
 *
 * ── What the low-res catalogue still settles ──────────────────────────────
 *
 * `TmRuteroCatalog/` — six crops, 130–195 px wide, of screenshots of
 * photographs — cannot resolve a lattice, but it is the record of the fleet
 * this app describes, and these hold at any quality:
 *   • ALL CAPS and no diacritics — the F23 unit reads "PORTAL AMERICAS" for a
 *     destination the catalog spells "Portal Américas". Legible at any blur, and
 *     it *contradicts* the brand manual (§5.5.5), so it is an observation rather
 *     than an assumption inherited from the spec.
 *   • On the units in `TmRuteroCatalog/`, lit LEDs sample to a cool white
 *     (≈ rgb(200, 220, 228)) over a panel near rgb(8, 15, 25). The manual
 *     mandates that colour: "leds de color blanco sobre fondo negro".
 *     **Amber units also exist** — every TransMilenio bus found on Wikimedia
 *     Commons carries an amber display, including articulated troncales. Both
 *     generations run. White is drawn here because it is what the catalogued
 *     photographs show and what the manual specifies, not because it is the
 *     only colour in service.
 *   • The panel holds about 20 characters — a character *count*, not a
 *     measurement ("F23 PORTAL AMERICAS" is 19 and fills it).
 *   • The layout rule below. It is a **ratio inside one image**, so perspective
 *     and scale cancel: 4 px of gap for "M83" + 14 characters against 25 px for
 *     "D21" + 9 is the same relationship however badly the photo was taken.
 *
 * A second Commons photograph ("Bog - Bus TransMileni dando la curva Avenida
 * 30", same author, CC BY-SA 3.0) shows a live route display reading
 * "J16 CC SANTAFE" — all caps, código left, destination offset — confirming the
 * casing and the layout rule on hardware other than the catalogued units.
 *
 * ── Still drawn, not traced ───────────────────────────────────────────────
 *
 * H, C, T and M are transcribed off the reference photograph. The rest of the
 * table is drawn to match their construction — 2-dot stems, 2-row bars, corners
 * cut by one on the round caps — because one promotional message does not
 * contain the alphabet. If a photograph of a route display ever resolves at this
 * quality, the remaining glyphs are worth re-cutting against it.
 *
 * The manual names no typeface for these panels and neither of its two mockup
 * faces matches the hardware (§5.5.5), so there is no authority to defer to.
 *
 * Layout rule: the código is flush left and the destination is centred **on the
 * whole panel**, shifted right only far enough to keep one blank column after
 * the código.
 *
 * Plain ES module with a `.d.ts` sidecar on purpose: the website (Vite) and the
 * SEO prerender (tsx, `server/`) both draw this sign, and their tsconfigs each
 * pin `rootDir` to their own `src`. A `.ts` file here would fail TS6059 on both
 * sides; a `.js` + `.d.ts` pair is type-checked at every call site while staying
 * outside either program — one font, one renderer, two surfaces (spec §1.1 R2).
 */

/** Dot columns in one glyph. */
export const GLYPH_COLUMNS = 6;
/** Dot rows in one glyph. */
export const GLYPH_ROWS = 11;
/** Glyph columns + the blank column that separates two characters. */
export const CHAR_ADVANCE = GLYPH_COLUMNS + 1;
/** Characters a real panel fits before it has to be widened. */
export const PANEL_CHARS = 20;
/** Dark dot rows above and below the text, as the panels show them. */
export const PANEL_PAD_ROWS = 1;
/** Dark dot columns at each end of the panel. */
export const PANEL_PAD_COLUMNS = 2;

/**
 * 6×11 uppercase dot-matrix face, drawn with **two-dot strokes**. One string per
 * dot row, `#` lit.
 *
 * Every stem is 2 columns and every bar 2 rows, because that is what the sign
 * does — see `H` below, which is transcribed dot-for-dot off the reference
 * photograph, and `C`, `T` and `M`, which are transcribed as far as a 6-column
 * box allows. The real face is *proportional* (`H` 6 columns, `M` 7, `l` 2), and
 * a 6-wide box is the dominant cap width; `M` and `W` are the two letters it
 * compresses.
 */
const GLYPHS = {
  ' ': ['......', '......', '......', '......', '......', '......', '......', '......', '......', '......', '......'],
  A: ['.####.', '######', '##..##', '##..##', '######', '######', '##..##', '##..##', '##..##', '##..##', '##..##'],
  B: ['#####.', '######', '##..##', '##..##', '######', '#####.', '##..##', '##..##', '##..##', '######', '#####.'],
  // Transcribed from the reference photograph.
  C: ['.####.', '######', '##....', '##....', '##....', '##....', '##....', '##....', '##..##', '######', '.####.'],
  D: ['#####.', '######', '##..##', '##..##', '##..##', '##..##', '##..##', '##..##', '##..##', '######', '#####.'],
  E: ['######', '######', '##....', '##....', '##....', '#####.', '#####.', '##....', '##....', '######', '######'],
  F: ['######', '######', '##....', '##....', '##....', '#####.', '#####.', '##....', '##....', '##....', '##....'],
  G: ['.####.', '######', '##....', '##....', '##....', '##.###', '##.###', '##..##', '##..##', '######', '.####.'],
  // Transcribed dot-for-dot from the reference photograph.
  H: ['##..##', '##..##', '##..##', '##..##', '######', '######', '##..##', '##..##', '##..##', '##..##', '##..##'],
  I: ['######', '######', '..##..', '..##..', '..##..', '..##..', '..##..', '..##..', '..##..', '######', '######'],
  J: ['..####', '..####', '....##', '....##', '....##', '....##', '....##', '##..##', '##..##', '######', '.####.'],
  K: ['##..##', '##.##.', '##.##.', '####..', '####..', '####..', '####..', '##.##.', '##.##.', '##..##', '##..##'],
  L: ['##....', '##....', '##....', '##....', '##....', '##....', '##....', '##....', '##....', '######', '######'],
  // M, N and W all have to render a diagonal through the two columns a 6-wide
  // box leaves between its stems, so each is distinguished by *where* the middle
  // fills: M high (the shoulders meeting near the top), W low, N a two-step
  // diagonal crossing at mid-height. The sign itself draws M and W 7 columns
  // wide and has room for a true vertex; this is the nearest 6-wide reading.
  M: ['##..##', '######', '######', '######', '##..##', '##..##', '##..##', '##..##', '##..##', '##..##', '##..##'],
  N: ['##..##', '###.##', '###.##', '###.##', '###.##', '######', '##.###', '##.###', '##.###', '##.###', '##..##'],
  'Ñ': ['.####.', '......', '##..##', '###.##', '###.##', '######', '######', '##.###', '##.###', '##..##', '##..##'],
  O: ['.####.', '######', '##..##', '##..##', '##..##', '##..##', '##..##', '##..##', '##..##', '######', '.####.'],
  P: ['#####.', '######', '##..##', '##..##', '##..##', '######', '#####.', '##....', '##....', '##....', '##....'],
  Q: ['.####.', '######', '##..##', '##..##', '##..##', '##..##', '##..##', '##.###', '##.###', '######', '.#####'],
  R: ['#####.', '######', '##..##', '##..##', '##..##', '######', '#####.', '##.##.', '##.##.', '##..##', '##..##'],
  S: ['.####.', '######', '##..##', '##....', '###...', '.#####', '....##', '....##', '##..##', '######', '.####.'],
  // Transcribed from the reference photograph.
  T: ['######', '######', '..##..', '..##..', '..##..', '..##..', '..##..', '..##..', '..##..', '..##..', '..##..'],
  U: ['##..##', '##..##', '##..##', '##..##', '##..##', '##..##', '##..##', '##..##', '##..##', '######', '.####.'],
  V: ['##..##', '##..##', '##..##', '##..##', '##..##', '##..##', '##..##', '.####.', '.####.', '..##..', '..##..'],
  W: ['##..##', '##..##', '##..##', '##..##', '##..##', '##..##', '##..##', '######', '######', '######', '##..##'],
  X: ['##..##', '##..##', '.####.', '.####.', '..##..', '..##..', '..##..', '.####.', '.####.', '##..##', '##..##'],
  Y: ['##..##', '##..##', '.####.', '.####.', '..##..', '..##..', '..##..', '..##..', '..##..', '..##..', '..##..'],
  Z: ['######', '######', '....##', '...##.', '...##.', '..##..', '.##...', '.##...', '##....', '######', '######'],
  // No slashed zero: the photographed panels print a plain O-shaped 0, and the
  // código sits beside a destination in the same face, so a slash would read as
  // a different glyph than the one on the bus.
  0: ['.####.', '######', '##..##', '##..##', '##..##', '##..##', '##..##', '##..##', '##..##', '######', '.####.'],
  1: ['..##..', '.###..', '####..', '..##..', '..##..', '..##..', '..##..', '..##..', '..##..', '######', '######'],
  2: ['.####.', '######', '##..##', '....##', '....##', '...##.', '..##..', '.##...', '##....', '######', '######'],
  3: ['.####.', '######', '##..##', '....##', '..###.', '..###.', '....##', '....##', '##..##', '######', '.####.'],
  4: ['...##.', '..###.', '.####.', '##.##.', '##.##.', '######', '######', '...##.', '...##.', '...##.', '...##.'],
  5: ['######', '######', '##....', '##....', '#####.', '######', '....##', '....##', '##..##', '######', '.####.'],
  6: ['..###.', '.####.', '##....', '##....', '#####.', '######', '##..##', '##..##', '##..##', '######', '.####.'],
  7: ['######', '######', '....##', '....##', '...##.', '...##.', '..##..', '..##..', '.##...', '.##...', '.##...'],
  8: ['.####.', '######', '##..##', '##..##', '######', '.####.', '##..##', '##..##', '##..##', '######', '.####.'],
  9: ['.####.', '######', '##..##', '##..##', '##..##', '######', '.#####', '....##', '....##', '.####.', '.###..'],
  '-': ['......', '......', '......', '......', '######', '######', '......', '......', '......', '......', '......'],
  '.': ['......', '......', '......', '......', '......', '......', '......', '......', '......', '.##...', '.##...'],
  ',': ['......', '......', '......', '......', '......', '......', '......', '......', '.##...', '.##...', '##....'],
  ':': ['......', '......', '.##...', '.##...', '......', '......', '......', '.##...', '.##...', '......', '......'],
  '/': ['....##', '....##', '...##.', '...##.', '..##..', '..##..', '..##..', '.##...', '.##...', '##....', '##....'],
  '(': ['..###.', '.###..', '.##...', '##....', '##....', '##....', '##....', '##....', '.##...', '.###..', '..###.'],
  ')': ['.###..', '..###.', '...##.', '....##', '....##', '....##', '....##', '....##', '...##.', '..###.', '.###..'],
  "'": ['.##...', '.##...', '.##...', '......', '......', '......', '......', '......', '......', '......', '......'],
  '+': ['......', '......', '......', '..##..', '..##..', '######', '######', '..##..', '..##..', '......', '......'],
  '&': ['.###..', '##.##.', '##.##.', '.###..', '.###..', '##.###', '##.###', '##..##', '##.###', '######', '.###.#'],
};

/** Anything with no glyph prints as the panel's blank cell rather than as tofu. */
const FALLBACK = ' ';

/** U+0303. The one combining mark the fold below keeps, because Ñ is a letter. */
const COMBINING_TILDE = 0x303;

/**
 * The catalog `tipoServicio` values whose buses carry this sign.
 *
 * A rutero is TransMilenio troncal kit: the articulated fleet (`TRONCAL`,
 * including the number-coded rutas fáciles) and the padrones that share the
 * busway (`PADRON`). The alimentadores (`ALIMENTADOR`, `ALIMENTADOR_V`) and the
 * SITP zonal fleet (`URBANO`, `COMPLEMENTARIO`, `ESPECIAL`) do not — they carry
 * a different sign, and drawing this one for them would state something about a
 * bus that is not true (spec §1, Certainty).
 */
const RUTERO_SERVICES = new Set(['TRONCAL', 'PADRON']);

/**
 * Whether a route's buses carry a rutero, from its catalog `tipoServicio`.
 *
 * One predicate for both surfaces — the website reads it off `RouteListItem`'s
 * `busType` (which is exactly `tipoServicio`, `buildCatalogRouteList`) and the
 * prerender off the light catalog's variant. Two copies of this list is two
 * chances to print a sign on an alimentador page (spec §1.1 R2).
 *
 * @param {unknown} tipoServicio
 * @returns {boolean}
 */
export function carriesRutero(tipoServicio) {
  return RUTERO_SERVICES.has(String(tipoServicio ?? '').trim().toUpperCase());
}

/**
 * Folds a catalog label into what the panel can actually light: uppercase, no
 * diacritics, single spaces, and no character the face has no glyph for.
 *
 * The fold is the sign's own behaviour, not a limitation we are working around
 * — the F23 unit photographed reads "PORTAL AMERICAS" for a destination the
 * catalog spells "Portal Américas".
 *
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeRuteroText(value) {
  return String(value ?? '')
    .normalize('NFD')
    // Drop every combining mark except the tilde that makes an Ñ: on these
    // panels Ñ is a letter with its own glyph, while É/Á are simply not printed.
    .replace(/\p{M}/gu, (mark, offset, whole) =>
      mark.codePointAt(0) === COMBINING_TILDE && /[Nn]/.test(whole[offset - 1] || '') ? mark : ''
    )
    .normalize('NFC')
    .toUpperCase()
    .split('')
    .map((ch) => (Object.prototype.hasOwnProperty.call(GLYPHS, ch) ? ch : FALLBACK))
    .join('')
    // After the fold, not before: a character with no glyph becomes a blank
    // cell, and "PORTAL AMÉRICAS · MUÑOZ" would otherwise light a hole where the
    // interpunct was.
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * What the sign says, for the destinations the catalog spells longer than the
 * bus does.
 *
 * A terminus carries its sponsor or its qualifier in the catalog — `Toberín-
 * Foundever`, `Héroes - Colmena Seguros`, `Universidades CityU`, `Portal El
 * Dorado – C.C Nuestro Bogotá` — and none of that reaches the panel: the bus is
 * signed `TOBERIN`, `HEROES`, `UNIVERSIDADES`, `PORTAL EL DORADO`. The qualifier
 * need not be a sponsor to be absent from the sign: `Guatoque - Veraguas` names
 * two barrios and the bus still shows only `GUATOQUE`. This is the same kind of fact as the diacritic fold below it
 * (the panel's own behaviour, not a limit we work around), so it lives here and
 * applies to every surface that draws a sign rather than being fixed on one of
 * them.
 *
 * Keyed on the folded, punctuation-free name so a catalog that adds or drops a
 * space still matches. Deliberately a list of answered cases, not a rule that
 * strips everything after a dash: `AK 68 - CL 12A` is a whole name, and
 * inventing a shorter sign for it would be a wrong answer of exactly the kind
 * this file exists to avoid (§1 Certainty). `Guatoque - Veraguas` was the other
 * example of that until the maintainer answered it — the bus is signed
 * `GUATOQUE` — which is the difference this list is built on: the answer comes
 * from someone who has seen the sign, never from the shape of the name.
 */
const SIGN_DESTINATIONS = new Map([
  ['ALCALACOLEGIOSTOMASDOMINICOS', 'Alcalá'],
  ['GUATOQUEVERAGUAS', 'Guatoque'],
  ['HEROESCOLMENASEGUROS', 'Héroes'],
  ['POLOFINCOMERCIO', 'Polo'],
  ['PORTALELDORADOCCNUESTROBOGOTA', 'Portal El Dorado'],
  ['PRADERAPLAZACENTRAL', 'Pradera'],
  ['TIBANICAPRIMAVERA', 'Tibanica'],
  ['TOBERINFOUNDEVER', 'Toberín'],
  ['UNIVERSIDADESCITYU', 'Universidades'],
]);

/**
 * The destination as the panel shows it — the catalog's name unless the sign is
 * known to be shorter (see {@link SIGN_DESTINATIONS}).
 *
 * @param {unknown} value
 * @returns {string}
 */
export function ruteroDestination(value) {
  const key = normalizeRuteroText(value).replace(/[^A-ZÑ0-9]/g, '');
  return SIGN_DESTINATIONS.get(key) ?? String(value ?? '');
}

/**
 * Where each character lands on the panel, in character columns.
 *
 * The código is flush left; the destination is centred on the **whole** panel
 * and then pushed right if that would leave it touching the código. A panel too
 * narrow for both is widened rather than truncated: a rutero that drops the tail
 * of "PORTAL EL DORADO" is a wrong answer, and no sign does that — they scroll.
 *
 * @param {string} code
 * @param {string} destination
 * @param {number} [panelChars]
 * @returns {{ columns: number, code: string, destination: string, codeAt: number, destinationAt: number }}
 */
export function ruteroLayout(code, destination, panelChars = PANEL_CHARS) {
  const c = normalizeRuteroText(code);
  // Shortened first, folded second: the sign's wording is decided before the
  // panel's glyph fold, and the layout (and therefore the panel width every
  // sign on the page is sized to) must be measured on what will actually light.
  const d = normalizeRuteroText(ruteroDestination(destination));
  // One blank column between them at the very least; widen the panel when the
  // pair cannot fit the nominal 20.
  const minimum = c.length + (d.length ? 1 + d.length : 0);
  const columns = Math.max(panelChars, minimum);
  const centred = Math.round((columns - d.length) / 2);
  const earliest = c.length ? c.length + 1 : 0;
  return {
    columns,
    code: c,
    destination: d,
    codeAt: 0,
    destinationAt: Math.max(centred, earliest),
  };
}

/** @param {string} value */
function escapeXml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Lit dot coordinates, in dot units, for a set of `[text, characterColumn]`
 * placements.
 *
 * @param {Array<[string, number]>} placements
 * @returns {Array<[number, number]>}
 */
function litDots(placements) {
  /** @type {Array<[number, number]>} */
  const dots = [];
  for (const [text, at] of placements) {
    for (let i = 0; i < text.length; i++) {
      const glyph = GLYPHS[text[i]] || GLYPHS[FALLBACK];
      const originX = PANEL_PAD_COLUMNS + (at + i) * CHAR_ADVANCE;
      for (let row = 0; row < GLYPH_ROWS; row++) {
        const bits = glyph[row];
        for (let col = 0; col < GLYPH_COLUMNS; col++) {
          if (bits[col] === '#') dots.push([originX + col, PANEL_PAD_ROWS + row]);
        }
      }
    }
  }
  return dots;
}

/**
 * The lit lattice as one path of zero-length subpaths.
 *
 * Each LED is `M<x> <y>h0` — a degenerate segment that a round line cap renders
 * as a disc of the stroke width. Six characters per dot against the ~55 an arc
 * pair costs, which matters at ~720 lit LEDs on a full panel: the same sign
 * drawn with real circles is 85 kB of path data, this is under 5 kB. The dots
 * land on integer coordinates because the caller translates the layer by half a
 * unit, so no subpath carries a decimal.
 *
 * @param {Array<[number, number]>} dots
 * @returns {string}
 */
function dotsPath(dots) {
  return dots.map(([x, y]) => `M${x} ${y}h0`).join('');
}

/**
 * The rutero — the sign over the windscreen — as a self-contained SVG string.
 *
 * Front panel only. A side/rear panel was drawn here for a while, from the
 * manual's rule that it carries the código alone, always centred
 * (`ManualDeIdentidad.pdf` p. 49). It was removed: **the side signs are not one
 * thing.** Different buses in the fleet carry visibly different ones, so any
 * single drawing of "the" lateral rutero asserts something about a bus that
 * isn't true — the certainty violation priority 1 exists to prevent. The front
 * panel is consistent enough across the fleet to draw; that one is not.
 *
 * Both the bloom and the LED cores are single `<path>`s, and the *unlit* grid is
 * a one-tile `<pattern>`. Two-dot strokes put ~720 lit LEDs on a full panel, and
 * two `<use>` elements each — plus the ~1 900 dark dots as elements — would put
 * more nodes on the page than the rest of the route view combined, for something
 * the eye reads as texture. Four elements draw the whole sign (spec §1 priority
 * 2). The bloom is a flat low-opacity layer rather than a per-dot gradient for
 * the same reason: a gradient fill on a shared path resolves against the path's
 * bounding box, not each dot, and at the sizes this renders the falloff is not
 * separable from a flat halo anyway.
 *
 * @param {{ code: string, destination: string, panelChars?: number, uid?: string, label?: string }} options
 * @returns {string}
 */
export function ruteroSvg(options) {
  const layout = ruteroLayout(options.code, options.destination, options.panelChars);
  const label =
    options.label ||
    `Rutero: ${[layout.code, layout.destination].filter(Boolean).join(' ')}`;
  const safeUid = String(options.uid || 'rutero').replace(/[^A-Za-z0-9_-]/g, '');
  const width = layout.columns * CHAR_ADVANCE - 1 + PANEL_PAD_COLUMNS * 2;
  const height = GLYPH_ROWS + PANEL_PAD_ROWS * 2;
  const dots = litDots([
    [layout.code, layout.codeAt],
    [layout.destination, layout.destinationAt],
  ]);

  return (
    `<svg class="rutero-svg" viewBox="0 0 ${width} ${height}" preserveAspectRatio="xMidYMid meet" ` +
    `role="img" aria-label="${escapeXml(label)}" focusable="false">` +
    '<defs>' +
    `<pattern id="rt-o-${safeUid}" width="1" height="1" patternUnits="userSpaceOnUse">` +
    '<circle cx=".5" cy=".5" r=".3" fill="#161d26"/>' +
    '</pattern>' +
    `<path id="rt-l-${safeUid}" d="${dotsPath(dots)}" fill="none" stroke-linecap="round"/>` +
    '</defs>' +
    `<rect width="${width}" height="${height}" fill="#05080c"/>` +
    `<rect width="${width}" height="${height}" fill="url(#rt-o-${safeUid})"/>` +
    // Both layers are the same path at two stroke widths. The bloom stays under
    // one pitch wide: strokes are two dots, and a wider halo fuses the pair into
    // a bar instead of the two LEDs the sign shows.
    '<g transform="translate(.5 .5)">' +
    `<use href="#rt-l-${safeUid}" stroke="#9ed2ef" stroke-opacity=".26" stroke-width="1.32"/>` +
    `<use href="#rt-l-${safeUid}" stroke="#e9f6ff" stroke-width=".66"/>` +
    '</g>' +
    '</svg>'
  );
}
