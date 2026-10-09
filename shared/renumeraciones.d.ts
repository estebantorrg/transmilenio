/** Types for `renumeraciones.js` (plain ESM shared by the website, the app and scripts; see `rutero.d.ts`). */

export interface Renumeracion {
  /** The retired código, as riders knew it. */
  antes: string;
  /** The público código(s) it became — one per sentido. */
  ahora: readonly string[];
  /** Date the change took effect (`YYYY-MM-DD`), from TRANSMILENIO's change log. */
  desde: string;
}

export declare const RENUMERACIONES: ReadonlyArray<Renumeracion>;

/** The códigos a retired one became (`39` → `['H439', 'F439']`); empty if never renumbered. */
export declare function codigosActuales(codigoAnterior: unknown): string[];

/** The código(s) this one replaced (`H439` → `['39']`); empty if never renumbered. */
export declare function codigosAnteriores(codigoActual: unknown): string[];
