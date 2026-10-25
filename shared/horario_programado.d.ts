export type Dia = 'LV' | 'S' | 'DF';
export type Periodo = [salidas: number, low: number | null, high: number | null];

export interface DiaHorario {
  /** The `paradas` index departures are counted at (`referencia`, gtfs_zonal.ts) — 0 unless the first stops go unserved. */
  desde: number;
  /** Buses that day. */
  salidas: number;
  /** First and last bus at `desde`, minutes after midnight (past 1440 = after midnight). */
  primera: number;
  ultima: number;
  /**
   * Per period: [departures in it, usual gap low, high] — the gap is the middle
   * half of those ending in the period, null when there is none (a lone first
   * departure) — or null with no departure at all.
   */
  cada: Array<Periodo | null>;
  /** Per `paradas`: first and last scheduled pass, or null where no bus of the day stops. */
  pasos: Array<[number, number] | null>;
}

/**
 * One direction of a código. A código is not always one direction: 731 files
 * both ("Bosa San José" and "Palermo") under the same código, so the unit is
 * the destination, as the catalog names it.
 */
export interface SentidoHorario {
  /** The catalog variant's `nombre`, without the "Ciclovía" its Sunday detour adds. */
  destino: string;
  /** Catalog stop codes in the order it runs them — the variant most buses follow. */
  paradas: string[];
  dias: Partial<Record<Dia, DiaHorario>>;
}

export declare const DIAS: Array<[Dia, string]>;
export declare const PERIODOS: string[];
export declare function destinoDe(nombre: string): string;
export declare function sentidoDe(sentidos: SentidoHorario[] | null | undefined, nombre: string): SentidoHorario | null;
export declare function hora(minute: number): string;
export declare function cadaTexto(periodo: Periodo | null): string | null;
export declare function pasoEn(sentido: SentidoHorario | null, dia: Dia, codigo: string): [number, number] | null;
export declare function pasoTexto(sentido: SentidoHorario | null, codigo: string): string | null;
export declare function cadaPico(sentidos: SentidoHorario | SentidoHorario[] | null | undefined): string | null;
export declare const PASO_NOTA: string;
export declare function resumenFrecuencia(
  codigo: string,
  sentidos: SentidoHorario[] | null | undefined
): { pregunta: string; respuesta: string } | null;
export declare function programadoHtml(sentido: SentidoHorario | null, nombreParada?: (codigo: string) => string): string;
