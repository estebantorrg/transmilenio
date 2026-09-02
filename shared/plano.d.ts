/**
 * Types for `plano.js` — the station plan, drawn once for every surface that
 * draws it. Hand-written beside the module, the same way `rutero.d.ts` is: the
 * source is plain JS so the server can import it without leaving its rootDir,
 * and the browser still gets it typed.
 */

export interface PlanoRoute {
  id?: string;
  codigo: string;
  nombre: string;
  color?: string;
  tipoServicio?: string;
  sistema?: string;
}

export interface PlanoIcono {
  label: string;
  /** The tile behind the glyph, as the operator prints it. */
  bg: string;
  /** SVG body — the tile is drawn for it. */
  svg: string;
  /** Its own viewBox, where the artwork is not on a 24×24 grid. The taquilla is
   *  the operator's own file and comes on 41×55. */
  vb?: string;
}

export interface BuildSheetPlanoInput {
  wagons: Record<string, PlanoRoute[]>;
  /** `planoLayout`. Without one there is no sheet to draw and the call
   *  returns null, leaving each caller its own fallback. */
  layout?: unknown;
  /** `planoDetalle` — the furniture, where it has been read. */
  detalle?: unknown;
  wagonPlan?: Record<string, Array<{ sentido?: string | null; ids?: string[] }>>;
  sentidos?: { positive: string; negative: string };
  /** Narrows the drawing to one platform of a station the catalog files as one
   *  stop (Ricaurte, Av. Jiménez). Omit to draw the whole stop. */
  presentWagons?: Set<string>;
  /** The colour a chip is painted. Each surface answers this its own way. */
  tagColor: (route: PlanoRoute) => string;
  isZonal: (route: PlanoRoute) => boolean;
  /** Given, chips become real anchors — which is how the prerendered page keeps
   *  a station linked to the routes that serve it. Omit in the browser, which
   *  wires a click handler to the span instead. */
  routeHref?: (route: PlanoRoute) => string | null;
}

export interface SheetPlano {
  html: string;
  /** True when the FULL station was drawn — accesses, taquillas, torniquetes
   *  and salidas — rather than the platforms alone. */
  detallado: boolean;
  /** Every código the drawing placed, so the caller can list the rest. */
  placed: Set<string>;
}

export declare const DIVIDER_NAMES: Record<string, string>;
export declare const ICONOS: Record<string, PlanoIcono>;
export declare function escapeHtml(value: unknown): string;
export declare function normalizeName(value: unknown): string;

/** The station drawn from its sheet, or null where no sheet has been read. */
export declare function buildSheetPlano(input: BuildSheetPlanoInput): SheetPlano | null;
