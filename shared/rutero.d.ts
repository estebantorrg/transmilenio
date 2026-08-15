/**
 * Types for `rutero.js`.
 *
 * The implementation is plain ESM so that the Vite client and the tsx-run SEO
 * prerender can both import one copy of the font without either tsconfig's
 * `rootDir` rejecting it (TS6059). This sidecar is a declaration file, which is
 * never emitted and therefore not bound by `rootDir` — so every call site is
 * still fully type-checked. See the header of `rutero.js`.
 */

export declare const GLYPH_COLUMNS: number;
export declare const GLYPH_ROWS: number;
export declare const CHAR_ADVANCE: number;
export declare const PANEL_CHARS: number;
export declare const SIDE_PANEL_CHARS: number;
export declare const PANEL_PAD_ROWS: number;
export declare const PANEL_PAD_COLUMNS: number;

/** Whether this catalog `tipoServicio` names a fleet that carries a rutero. */
export declare function carriesRutero(tipoServicio: unknown): boolean;

/** Uppercase, diacritic-folded (Ñ survives), collapsed to glyphs the face has. */
export declare function normalizeRuteroText(value: unknown): string;

export interface RuteroLayout {
  /** Character columns the panel ends up being, ≥ `PANEL_CHARS`. */
  columns: number;
  /** The código as the panel prints it. */
  code: string;
  /** The destination as the panel prints it. */
  destination: string;
  /** Character column the código starts at (always 0). */
  codeAt: number;
  /** Character column the destination starts at. */
  destinationAt: number;
}

export declare function ruteroLayout(
  code: string,
  destination: string,
  panelChars?: number
): RuteroLayout;

export interface RuteroOptions {
  /** Route código, e.g. `F23`. */
  code: string;
  /** Where the bus is headed, e.g. `Portal Américas`. */
  destination: string;
  /** Nominal panel width in characters; defaults to `PANEL_CHARS` (20). */
  panelChars?: number;
  /** Unique suffix for the SVG's internal ids — one per sign on the page. */
  uid?: string;
  /** Overrides the generated `aria-label`. */
  label?: string;
}

/** The front sign as a self-contained SVG string (no external refs, no script). */
export declare function ruteroSvg(options: RuteroOptions): string;

export interface RuteroSideLayout {
  /** Character columns the panel ends up being. */
  columns: number;
  /** The código as the panel prints it. */
  code: string;
  /** Character column the código starts at — always centred. */
  codeAt: number;
}

export declare function ruteroSideLayout(
  code: string,
  panelChars?: number
): RuteroSideLayout;

export interface RuteroSideOptions {
  /** Route código, e.g. `F23`. The side panel shows nothing else. */
  code: string;
  /** Nominal panel width in characters; defaults to `SIDE_PANEL_CHARS`. */
  panelChars?: number;
  /** Unique suffix for the SVG's internal ids — one per sign on the page. */
  uid?: string;
  /** Overrides the generated `aria-label`. */
  label?: string;
}

/** The side/rear sign — código only, centred — as a self-contained SVG. */
export declare function ruteroSideSvg(options: RuteroSideOptions): string;
