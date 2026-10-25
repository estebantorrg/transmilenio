/**
 * How full a live bus is, as the live feed reports it (`ocupacion_bus`, spec §5.8):
 * VACIO, MEDIO or LLENO.
 *
 * Measured 2026-10-24: 0 % of buses filled it that morning, 70 % that evening —
 * every bus with a five-digit number (T, K, U, A, S, M fleets) and none with a
 * four-digit one (E, D, N), which send an empty string. So a missing reading is
 * the norm for a third of the fleet and means "no reading", never "empty": where
 * there is a level it is shown, and where there is none nothing is. The feed
 * dropping the field, sending it empty, or sending a value not listed here all
 * read as none — nothing downstream depends on it being there.
 */

const NIVELES = { VACIO: 'Vacío', MEDIO: 'Medio lleno', LLENO: 'Lleno' };

/** The bus's level — 'VACIO' | 'MEDIO' | 'LLENO' — or null when it sent none. */
export function ocupacionDe(bus) {
  const value = String(bus?.ocupacion_bus ?? '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .trim()
    .toUpperCase();
  return Object.hasOwn(NIVELES, value) ? value : null;
}

/** "Lleno", or null for no reading. */
export function ocupacionTexto(nivel) {
  return nivel && Object.hasOwn(NIVELES, nivel) ? NIVELES[nivel] : null;
}
