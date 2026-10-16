/**
 * Types for `resumen.js` — the search question a route or station page answers
 * in a sentence. Hand-written beside the module, as the rest of shared/.
 */

export interface Resumen {
  /** The question as a rider types it: "¿Dónde para el B11?". */
  pregunta: string;
  /** Its answer in one sentence, from the page's own data. */
  respuesta: string;
}

export function resumenRuta(codigo: string, paradas: string[]): Resumen | null;

/** `horario`: the catalog schedule as printed, `L-V 5:00 AM-9:00 PM / S …`. */
export function horarioRuta(codigo: string, horario: string | undefined): Resumen | null;

/** `troncal`: the corridor's name; a leading "Troncal" is dropped. */
export function ubicacionEstacion(nombre: string, direccion?: string, troncal?: string): Resumen | null;

/** `zonales`: alimentador and zonal códigos, listed after the troncal ones. */
export function resumenEstacion(nombre: string, troncales: string[], zonales?: string[]): Resumen | null;
