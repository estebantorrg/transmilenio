/** Types for `tabla_rutero.js` (plain ESM shared by client and prerender; see `rutero.d.ts`). */

/** `[corredor | null, destacado 0/1, hito]` — one printed row. `destacado` is the dark chip, or, on a row without one, a dark band. */
export type FilaRutero = readonly [string | null, number, string];

export interface SentidoRutero {
  destino: string;
  /** Set when the table only runs on some days, e.g. `domingos y festivos`. */
  operacion?: string;
  filas: ReadonlyArray<FilaRutero>;
}

export interface RuteroTradicional {
  formato: 'tabla' | 'digital';
  /** The colour the piece prints the código in (`#rrggbb`): an alimentador's portal line, which its rutero takes. */
  color?: string;
  sentidos: SentidoRutero[];
}

/** `server/src/data/ruteros_tradicionales.json`. */
export interface RuterosTradicionales {
  fuente: string;
  rutas: Record<string, RuteroTradicional>;
}

export const HITOS_DE_ESTACION: Record<string, string[]>;
/** The estación a printed hito names, or null when it names none. */
export function estacionDeHito(hito: string): string | null;
/** The route códigos whose printed rutero names this estación, in order. */
export function rutasQueLleganA(rutas: Record<string, RuteroTradicional>, estacion: string): string[];

export interface GrupoCorredor {
  corredor: string | null;
  destacado: boolean;
  hitos: string[];
}

/** Consecutive rows on the same corredor (and chip colour) as one group. */
export declare function agruparFilas(filas: ReadonlyArray<FilaRutero>): GrupoCorredor[];

/** The corredores the sentidos print, the main one first, each once, at most `max`. */
export declare function corredoresDe(sentidos: ReadonlyArray<SentidoRutero>, max?: number): string[];

/** The sentidos headed for `destino`; empty when none matches. */
export declare function sentidosHacia(ruta: RuteroTradicional | null | undefined, destino: unknown): SentidoRutero[];

export declare function tablaRuteroHtml(options: { codigo: string; color: string; formato?: 'tabla' | 'digital'; sentido: SentidoRutero; estacionHref?: (codigo: string) => string | null }): string;

/** The table's stylesheet (inlined by the prerender). */
export declare const TABLA_RUTERO_CSS: string;

/** Adds `TABLA_RUTERO_CSS` to the document once. */
export declare function ensureTablaRuteroStyle(): void;

/** Shrinks any label wider than its cell (client only; see the implementation). */
export declare function ajustarTablasRutero(root: ParentNode): void;
