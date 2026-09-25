/** Types for `tabla_rutero.js` (plain ESM shared by client and prerender; see `rutero.d.ts`). */

/** `[corredor | null, destacado 0/1, hito]` — one printed row. */
export type FilaRutero = readonly [string | null, number, string];

export interface SentidoRutero {
  destino: string;
  /** Set when the table only runs on some days, e.g. `domingos y festivos`. */
  operacion?: string;
  filas: ReadonlyArray<FilaRutero>;
}

export interface RuteroTradicional {
  formato: 'tabla' | 'digital';
  sentidos: SentidoRutero[];
}

/** `server/src/data/ruteros_tradicionales.json`. */
export interface RuterosTradicionales {
  fuente: string;
  rutas: Record<string, RuteroTradicional>;
}

export interface GrupoCorredor {
  corredor: string | null;
  destacado: boolean;
  hitos: string[];
}

/** Consecutive rows on the same corredor (and chip colour) as one group. */
export declare function agruparFilas(filas: ReadonlyArray<FilaRutero>): GrupoCorredor[];

/** The sentidos headed for `destino`; empty when none matches. */
export declare function sentidosHacia(ruta: RuteroTradicional | null | undefined, destino: unknown): SentidoRutero[];

export declare function tablaRuteroHtml(options: { codigo: string; color: string; formato?: 'tabla' | 'digital'; sentido: SentidoRutero }): string;

/** The table's stylesheet (inlined by the prerender). */
export declare const TABLA_RUTERO_CSS: string;

/** Adds `TABLA_RUTERO_CSS` to the document once. */
export declare function ensureTablaRuteroStyle(): void;

/** Shrinks any label wider than its cell (client only; see the implementation). */
export declare function ajustarTablasRutero(root: ParentNode): void;
