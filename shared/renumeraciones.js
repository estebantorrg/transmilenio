/**
 * Zonal routes TRANSMILENIO renumbered, so a rider who still knows the old
 * código finds the route under its new one: searching `39` offers H439 and
 * F439 ("antes 39"), and an old link or bookmark to `/ruta/39/` opens them.
 *
 * Source: TRANSMILENIO's own change log, "Cambios KE Zonal", delivered in
 * answer to radicado 2026-ER-53567 (October 2026) — the rows that carry a
 * "Nuevo Código". Each was checked against the official route finder on
 * 2026-10-08: the old código is no longer listed, the new ones are.
 *
 * The log writes the new código the way TRANSMILENIO's planning files do,
 * origin letter + destination letter + number (`FH439`). On the street that is
 * two públicos, one per sentido: H439 towards zone H and F439 towards zone F.
 * Both are listed here, since the old código named the route both ways. Where
 * the two letters are the same (`LL822`) there is one código.
 *
 * Not here on purpose: `HH715 → HK715`. H715 is still a live código (the sentido
 * towards El Uval); only the other sentido changed, to K715. An alias from H715
 * would send a rider looking for a route that exists to a different one.
 *
 * Plain ESM with a `.d.ts` sidecar, like `rutero.js`: the website, the app and
 * the scripts share one copy.
 */

/** @type {ReadonlyArray<{ antes: string, ahora: readonly string[], desde: string }>} */
export const RENUMERACIONES = Object.freeze([
  { antes: '3-6', ahora: ['H728'], desde: '2024-11-02' },
  { antes: 'T07', ahora: ['L822'], desde: '2025-02-17' },
  { antes: 'C135', ahora: ['A535', 'G535'], desde: '2025-06-24' },
  { antes: '344', ahora: ['B109', 'C109'], desde: '2025-06-24' },
  { antes: 'C123', ahora: ['A427', 'F427'], desde: '2025-08-19' },
  { antes: 'K803', ahora: ['H803', 'L803'], desde: '2025-09-08' },
  { antes: '256', ahora: ['L856', 'A856'], desde: '2025-10-06' },
  { antes: '367', ahora: ['A567', 'G567'], desde: '2025-10-27' },
  { antes: 'A815', ahora: ['L815'], desde: '2025-11-18' },
  { antes: 'C29', ahora: ['A547', 'G547'], desde: '2026-02-02' },
  { antes: 'K122', ahora: ['D122', 'C122'], desde: '2026-02-09' },
  { antes: '120', ahora: ['A520', 'G520'], desde: '2026-02-23' },
  { antes: 'C80', ahora: ['A680', 'H680'], desde: '2026-03-02' },
  { antes: '787A', ahora: ['A587', 'G587'], desde: '2026-03-16' },
  { antes: 'TC6', ahora: ['K337'], desde: '2026-05-11' },
  { antes: 'C401', ahora: ['B401', 'F401'], desde: '2026-05-19' },
  { antes: '742A', ahora: ['K646', 'H646'], desde: '2026-05-25' },
  { antes: '39', ahora: ['H439', 'F439'], desde: '2026-06-22' },
  { antes: '953', ahora: ['H453', 'F453'], desde: '2026-06-22' },
]);

const clave = (codigo) => String(codigo ?? '').trim().toUpperCase();

const POR_ANTES = new Map(RENUMERACIONES.map((r) => [clave(r.antes), r]));
const POR_AHORA = new Map();
for (const r of RENUMERACIONES) {
  for (const codigo of r.ahora) POR_AHORA.set(clave(codigo), [...(POR_AHORA.get(clave(codigo)) ?? []), r.antes]);
}

/** The códigos a retired one became (`39` → `['H439', 'F439']`); empty if it was never renumbered. */
export function codigosActuales(codigoAnterior) {
  return [...(POR_ANTES.get(clave(codigoAnterior))?.ahora ?? [])];
}

/** The código(s) this one replaced (`H439` → `['39']`); empty for a route that was never renumbered. */
export function codigosAnteriores(codigoActual) {
  return [...(POR_AHORA.get(clave(codigoActual)) ?? [])];
}
