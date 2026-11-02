/**
 * "¿Qué bus me lleva a Modelia?": matching a typed barrio or landmark against the
 * names of the places a route passes, its catalog stops and its printed hitos.
 *
 * By word start, not anywhere in the text: "ria" must not find Br. María Paz. All
 * words must be there, in any order: "hospital kennedy" finds `Hsp. Occ. Kennedy`.
 * Plain JS so the website and, later, the app read a query the same way.
 */

import { expandirHito } from './nomenclatura.js';

/** What a rider says that no sign prints: "barrio modelia" is Br. Modelia, and "Ricaurte" is the estación's whole name. */
const SIN_SENTIDO = new Set(['barrio', 'br', 'estacion', 'est', 'paradero']);

// The dots go first, so "C.C." is the one word "cc"; every other mark splits words.
const pliega = (texto) =>
  String(texto ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\./g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/** A place's name as a search reads it: folded, printed and spelled out. Leading space: see `coincideBarrio`. */
export function textoBarrio(nombre) {
  return ` ${pliega(`${nombre} ${expandirHito(nombre)}`)}`;
}

/** The words a query looks for, or null when it is too short to name a place. */
export function palabrasBarrio(consulta) {
  const palabras = pliega(consulta).split(' ').filter((p) => p && !SIN_SENTIDO.has(p));
  return palabras.join('').length >= 3 ? palabras : null;
}

/** Every word starts a word of the place's name (`textoBarrio`). */
export function coincideBarrio(texto, palabras) {
  return palabras.every((p) => texto.includes(` ${p}`));
}
