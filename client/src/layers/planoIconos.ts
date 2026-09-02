/**
 * The station furniture, drawn as TransMilenio draws it.
 *
 * These are traced from the *Convenciones* block the operator prints down the
 * left edge of every plano de ubicación, not borrowed from an icon set. Two
 * earlier passes used hand-drawn glyphs and then Material Symbols, and both
 * failed the same way: a rider cannot match them against the wall, because the
 * marks on the wall look nothing like them. Material has no turnstile at all,
 * and its nearest stand-in for a pedestrian ramp is a wheelchair — where the
 * operator draws a slope with an arrow at each end.
 *
 * What the sheets actually draw, and therefore what these are:
 *
 *   taquilla    a tilted square with a hand reaching into it
 *   torniquete  two pillars, notched at the top, with the arm between them
 *   rampa       a slope, with an arrow up one way and down the other
 *   escalera    the same two arrows, over steps instead of a slope
 *   emergencia  a running figure, WHITE ON GREEN — the only green mark
 *   ascensor    a wheelchair, WHITE ON BLUE
 *   bici        a T with a bicycle at its foot
 *   cable       a cabin seen head-on
 *   zonal       the front of a bus
 *
 * Colour is part of the mark, so each carries its own: the operator prints them
 * as black tiles with white glyphs, except the two that are colour-coded by
 * law. On the sheet those tiles sit on a light grey plan; here they sit on a
 * dark one, so each keeps a hairline border to hold its edge.
 */

export interface PlanoIcono {
  label: string;
  /** The tile behind the glyph, as the operator prints it. */
  bg: string;
  /** SVG body on a 24×24 grid, glyph only — the tile is drawn for it. */
  svg: string;
}

const W = '#FFFFFF';

export const ICONOS: Record<string, PlanoIcono> = {
  taquilla: {
    label: 'Taquilla',
    bg: '#0E0E10',
    svg:
      `<g transform="rotate(-20 12 11)">` +
      `<rect x="5.6" y="4.4" width="12.8" height="12.8" rx="0.9" fill="none" stroke="${W}" stroke-width="2"/>` +
      `</g>` +
      `<path d="M11.6 11.1c0-.75.6-1.35 1.35-1.35s1.35.6 1.35 1.35v2.85l1.5-.85c.6-.34 1.36-.13 1.7.47.34.6.13 1.36-.47 1.7l-3.3 1.9c-.3.17-.63.26-.97.26h-2.2c-1.05 0-1.9-.85-1.9-1.9v-3.05c0-.75.6-1.35 1.35-1.35h1.59z" fill="${W}"/>`,
  },
  torniquete: {
    label: 'Torniquetes',
    bg: '#0E0E10',
    svg:
      `<rect x="4.6" y="7.6" width="4.6" height="11.4" rx="1.3" fill="${W}"/>` +
      `<rect x="14.8" y="7.6" width="4.6" height="11.4" rx="1.3" fill="${W}"/>` +
      `<path d="M5.3 10.6 6.9 7.9 8.5 10.6z" fill="#0E0E10"/>` +
      `<path d="M15.5 10.6 17.1 7.9 18.7 10.6z" fill="#0E0E10"/>` +
      `<path d="M9.4 13.1 14.6 15.6" stroke="${W}" stroke-width="1.5" stroke-linecap="round"/>`,
  },
  rampa: {
    label: 'Rampa peatonal',
    bg: '#0E0E10',
    svg:
      `<path d="M4.4 19.2 19.6 5.6" stroke="${W}" stroke-width="2.1" stroke-linecap="round"/>` +
      `<path d="M4.2 8.6 8.4 4.6M8.4 4.6H5.3M8.4 4.6v3.1" stroke="${W}" stroke-width="1.6" ` +
      `stroke-linecap="round" stroke-linejoin="round" fill="none"/>` +
      `<path d="M19.8 16.2 15.6 20.2M15.6 20.2h3.1M15.6 20.2v-3.1" stroke="${W}" stroke-width="1.6" ` +
      `stroke-linecap="round" stroke-linejoin="round" fill="none"/>`,
  },
  escalera: {
    label: 'Escalera peatonal',
    bg: '#0E0E10',
    svg:
      `<path d="M4.4 19.4h3.6v-3.6h3.6v-3.6h3.6V8.6h3.6" stroke="${W}" stroke-width="2.1" ` +
      `fill="none" stroke-linejoin="round"/>` +
      `<path d="M4.2 8.6 8.4 4.6M8.4 4.6H5.3M8.4 4.6v3.1" stroke="${W}" stroke-width="1.6" ` +
      `stroke-linecap="round" stroke-linejoin="round" fill="none"/>` +
      `<path d="M19.8 16.2 15.6 20.2M15.6 20.2h3.1M15.6 20.2v-3.1" stroke="${W}" stroke-width="1.6" ` +
      `stroke-linecap="round" stroke-linejoin="round" fill="none"/>`,
  },
  emergencia: {
    label: 'Salida de emergencia',
    bg: '#2E9E4F',
    svg:
      `<circle cx="13.6" cy="4.9" r="2" fill="${W}"/>` +
      `<path d="M12.9 8.1c-.5.15-.95.45-1.3.85l-2.5 2.9c-.35.4-.35 1 .05 1.35.4.35 1 .3 1.35-.1l1.5-1.7.75 2.4-2.6 2.9c-.2.25-.3.55-.25.85l.6 3.3c.1.55.6.9 1.15.8.55-.1.9-.6.8-1.15l-.5-2.75 2.35-2.6 1.15 3.05c.1.3.35.55.65.65l2.6.75c.55.15 1.1-.15 1.25-.7.15-.55-.15-1.1-.7-1.25l-2.1-.6-1.7-4.7c-.2-.6-.55-1.1-1-1.5l-1.55-1.35c-.4-.35-.9-.5-1.45-.4z" fill="${W}"/>` +
      `<path d="M8.2 8.6 5.1 9.8" stroke="${W}" stroke-width="1.7" stroke-linecap="round"/>`,
  },
  ascensor: {
    label: 'Ascensor prioritario',
    bg: '#1B5FA8',
    svg:
      `<circle cx="11.4" cy="4.8" r="2" fill="${W}"/>` +
      `<path d="M9.6 8.2v5.1c0 .7.55 1.25 1.25 1.25h3.6l2.5 5.3" stroke="${W}" stroke-width="2" ` +
      `fill="none" stroke-linecap="round" stroke-linejoin="round"/>` +
      `<path d="M15.9 13.6a5.4 5.4 0 1 1-6.6-4.1" stroke="${W}" stroke-width="1.9" fill="none" stroke-linecap="round"/>`,
  },
  bici: {
    label: 'TransMiBici',
    bg: '#0E0E10',
    svg:
      `<path d="M4.4 5.9h10.2M9.5 5.9v12.4" stroke="${W}" stroke-width="2.4" stroke-linecap="round"/>` +
      `<circle cx="14.6" cy="16.4" r="2.9" fill="none" stroke="${W}" stroke-width="1.5"/>` +
      `<circle cx="20.1" cy="16.4" r="2.9" fill="none" stroke="${W}" stroke-width="1.5"/>` +
      `<path d="M14.6 16.4 16.6 11.9h2.4" stroke="${W}" stroke-width="1.4" fill="none" stroke-linecap="round"/>`,
  },
  cable: {
    label: 'Conexión con TransMiCable',
    bg: '#0E0E10',
    svg:
      `<path d="M8.2 4.8h7.6l3.4 3.4v7.6l-3.4 3.4H8.2L4.8 15.8V8.2z" fill="none" stroke="${W}" stroke-width="1.8" stroke-linejoin="round"/>` +
      `<path d="M12.4 5.2h3.4l3.4 3.4v7.2l-3.4 3.4h-3.4z" fill="${W}"/>`,
  },
  zonal: {
    label: 'Conexión con servicio zonal',
    bg: '#0E0E10',
    svg:
      `<rect x="4.6" y="4.6" width="14.8" height="12.4" rx="1.6" fill="none" stroke="${W}" stroke-width="1.8"/>` +
      `<path d="M4.6 9.4h14.8" stroke="${W}" stroke-width="1.6"/>` +
      `<path d="M7.4 17.2v2.2M16.6 17.2v2.2" stroke="${W}" stroke-width="1.8" stroke-linecap="round"/>`,
  },
};
