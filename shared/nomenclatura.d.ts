/**
 * Types for `nomenclatura.js` — TransMiZonal nomenclature as TRANSMILENIO
 * defines it (Manual de imagen y normas gráficas V.6). Hand-written beside the
 * module, like `rutero.d.ts`.
 */

export type ZonaLetra = 'A' | 'B' | 'C' | 'D' | 'F' | 'G' | 'H' | 'K' | 'L';

export interface Zona {
  nombre: string;
  color: string;
  /** [desde, hasta, área] — H has two: Ciudad Bolívar and Usme. */
  rangos: Array<[number, number, string]>;
}

export const ZONAS: Record<ZonaLetra, Zona>;

export function zonaPorNumero(numero: number | string): { letra: ZonaLetra; area: string } | null;

export interface ServicioZonal {
  codigo: string;
  numero: number;
  destino: ZonaLetra;
  destinoNombre: string;
  origen: ZonaLetra | null;
  origenArea: string | null;
}

export function leerCodigoZonal(code: string): ServicioZonal[] | null;

export interface ZonaDeRuta {
  letra: ZonaLetra;
  /** The zone's name, or its area where the número names one (H: Usme, Ciudad Bolívar). */
  nombre: string;
  color: string;
}

export function zonasDeRuta(
  code: string,
  existe: (codigo: string) => boolean
): { origen: ZonaDeRuta; destino: ZonaDeRuta; dentro: boolean } | null;

export function leerCodigoParadero(code: string): { paradero: number; modulo: string; zona: number } | null;

export const MAX_CARACTERES_NOMBRE: number;

export const ABREVIATURAS: {
  vias: Array<[string, string]>;
  indicaciones: Array<[string, string]>;
  hitosGenericos: Array<[string, string]>;
  hitosPropios: Array<[string, string]>;
};

export function normalizarCorredor(raw: string): string | null;

/** `AC 13` → "Avenida Calle 13": a corredor as it is said. */
export function expandirCorredor(corredor: string): string;

/** The streets a run of stops holds three in a row, the `max` longest, in ride order. */
export function corredoresRecorridos(direcciones: ReadonlyArray<string | null | undefined>, max?: number): string[];

export function expandirHito(text: string): string;
