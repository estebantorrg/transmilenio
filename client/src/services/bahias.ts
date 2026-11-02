/**
 * A paradero múltiple's bahías, from the plegables and from the códigos.
 *
 * A paradero's código carries its módulo (`078A12`), so the catalog alone names
 * the bahías some route uses. The icons printed on the plegables (read by
 * `scripts/ocr/paraderos.mjs`) add those it does not: 382 paraderos the catalog
 * files under a single módulo are printed with two or more.
 */

import { leerCodigoParadero } from '../../../shared/nomenclatura.js';
import { api } from './api';

let promise: Promise<boolean> | null = null;
let listas = false;
let bahias: Record<string, string[]> = {};
let dudas = new Set<string>();

export const bahiasListas = (): boolean => listas;

/** Fetched once per session; a failed fetch is asked again a minute later. */
export function loadBahias(): Promise<boolean> {
  promise ??= api
    .getParaderosPlegable()
    .then((res) => {
      if (!res.success || !res.bahias) throw new Error('paraderos-plegable');
      bahias = res.bahias;
      dudas = new Set(res.dudas);
      return (listas = true);
    })
    .catch(() => {
      window.setTimeout(() => (promise = null), 60_000);
      return false;
    });
  return promise;
}

const claveDe = (paradero: number, zona: number) =>
  `${String(paradero).padStart(3, '0')}-${String(zona).padStart(2, '0')}`;

/** Printed bahías of the paradero `code` stands at; empty until loaded, or if none are printed. */
export function bahiasImpresas(code: string): string[] {
  const c = leerCodigoParadero(code);
  return c ? bahias[claveDe(c.paradero, c.zona)] ?? [] : [];
}

/** The same paradero's stop código at another bahía: `078A12`, `C` → `078C12`. */
export function codigoEnBahia(code: string, letra: string): string {
  return `${code.slice(0, 3)}${letra}${code.slice(4)}`;
}

/**
 * "Módulo B", for a stop at a paradero with more than one, or null. A single-bahía
 * paradero has no choice to make, so it says nothing; a stop whose plegable prints
 * another módulo than its código says nothing either, since neither is known right.
 */
export function moduloTexto(code: string): string | null {
  const c = leerCodigoParadero(code);
  if (!c || dudas.has(code)) return null;
  return c.modulo !== 'A' || bahiasImpresas(code).length > 1 ? `Módulo ${c.modulo}` : null;
}
