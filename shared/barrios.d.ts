/** Types for `barrios.js` (plain ESM shared by client and tests; see `rutero.d.ts`). */

export function textoBarrio(nombre: string): string;
export function palabrasBarrio(consulta: string): string[] | null;
export function coincideBarrio(texto: string, palabras: string[]): boolean;
