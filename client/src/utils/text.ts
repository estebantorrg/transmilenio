/**
 * Spanish sentence helpers for UI copy, shared by both clients (spec §1.1 R2).
 *
 * The empty states name the filter in effect ("dentro de el filtro Troncal"),
 * and Spanish contracts `de + el` into `del`. Doing that at every call site is
 * how one of them ends up ungrammatical.
 */

/** `de` + a noun phrase, contracting `de el` → `del`. */
export function de(phrase: string): string {
  return phrase.startsWith('el ') ? `del ${phrase.slice(3)}` : `de ${phrase}`;
}
