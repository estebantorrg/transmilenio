/**
 * A zonal direction's scheduled service, as riders read it (spec §5.5.10): how
 * often the bus comes through the day, its first and last bus, and when it
 * first and last passes each paradero. Read from `server/src/data/gtfs_zonal.json`
 * (TRANSMILENIO's GTFS, built by `sync_gtfs.ts`) and worded here once, for both
 * the prerendered route page and the bundle's, so they say the same thing.
 *
 * It is the plan, not the operation, and says so: "programado".
 */

import { escapeHtml } from './plano.js';

/** Day types in the order a rider reads them, and how a column names each. */
export const DIAS = [
  ['LV', 'Lun a vie'],
  ['S', 'Sábados'],
  ['DF', 'Dom y festivos'],
];

/** `gtfs_zonal.json`'s periods, in words. */
export const PERIODOS = ['Antes de las 6 a. m.', '6 a 9 a. m.', '9 a. m. a 4 p. m.', '4 a 7 p. m.', '7 a 10 p. m.', 'Después de las 10 p. m.'];

/** Above this, "cada N min" stops meaning anything: the number of buses is the answer. */
const CADA_MAX = 60;

/**
 * The direction a catalog variant names. A Sunday Ciclovía detour is the same
 * direction as the service it detours; NFC first, because the catalog spells
 * "Ciclovía" with a combining accent.
 */
export function destinoDe(nombre) {
  return String(nombre ?? '').normalize('NFC').replace(/\s*ciclov[ií]a\s*/i, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * The schedule of the direction a catalog variant runs, or null. Never for the
 * Ciclovía variant itself: it is a Sunday-morning detour, and the direction's
 * schedule is the whole week's.
 */
export function sentidoDe(sentidos, nombre) {
  if (!sentidos || /ciclov/i.test(String(nombre ?? '').normalize('NFC'))) return null;
  const destino = destinoDe(nombre);
  return sentidos.find((s) => s.destino === destino) ?? null;
}

/** Minutes after midnight (past 1440 = after midnight) → "5:12 a. m.", spaced as `shared/resumen.js` writes it. */
export function hora(minute) {
  const m = ((Math.round(minute) % 1440) + 1440) % 1440;
  const h = Math.floor(m / 60);
  return `${h % 12 === 0 ? 12 : h % 12}:${String(m % 60).padStart(2, '0')} ${h < 12 ? 'a. m.' : 'p. m.'}`;
}

/** One period of `cada`: "cada 8–10 min", or the number of buses when they are too few for a frequency. */
export function cadaTexto(periodo) {
  if (!periodo) return null;
  const [n, low, high] = periodo;
  if (low === null || high > CADA_MAX) return n === 1 ? '1 bus' : `${n} buses`;
  return low === high ? `cada ${low} min` : `cada ${low}–${high} min`;
}

/** First and last pass at a paradero on a day type, or null where none stops. */
export function pasoEn(sentido, dia, codigo) {
  const i = sentido?.paradas.indexOf(codigo) ?? -1;
  return i < 0 ? null : (sentido.dias[dia]?.pasos[i] ?? null);
}

/**
 * "5:12 a.m. – 10:41 p.m.": the first and last bus at a paradero on weekdays.
 * Weekdays only, and said once over the list (`PASO_NOTA`) — a label per row
 * switching day types would be noise across sixty paradas.
 */
export function pasoTexto(sentido, codigo) {
  const paso = pasoEn(sentido, 'LV', codigo);
  return paso ? `${hora(paso[0])} – ${hora(paso[1])}` : null;
}

export const PASO_NOTA = 'Junto a cada parada, su primer y último bus de lunes a viernes.';

/**
 * "¿Cada cuánto pasa el A153?" — the question a search for the route's
 * frequency asks, answered from its busiest direction on weekdays, in the
 * `{ pregunta, respuesta }` shape of `shared/resumen.js`.
 */
export function resumenFrecuencia(codigo, sentidos) {
  const sentido = (sentidos ?? []).find((s) => cadaPico(s));
  if (!sentido) return null;
  const d = sentido.dias.LV;
  return {
    pregunta: `¿Cada cuánto pasa el ${codigo}?`,
    // No closing period: the hour already ends in one ("p. m.").
    respuesta:
      `Hacia ${sentido.destino}, de lunes a viernes en hora pico, el ${codigo} pasa ${cadaPico(sentido)}, según el horario programado de TRANSMILENIO; ` +
      `su primer bus sale a las ${hora(d.primera)} y el último a las ${hora(d.ultima)}`,
  };
}

/**
 * The weekday rush-hour frequency (6–9 a.m., 4–7 p.m.), for a summary line:
 * "cada 8–10 min". Given every direction of a código, the range across them.
 */
export function cadaPico(sentidos) {
  const pico = (Array.isArray(sentidos) ? sentidos : [sentidos])
    .flatMap((sentido) => [sentido?.dias.LV?.cada[1], sentido?.dias.LV?.cada[3]])
    .filter((p) => p && p[1] !== null && p[2] <= CADA_MAX);
  if (!pico.length) return null;
  const low = Math.min(...pico.map((p) => p[1]));
  const high = Math.max(...pico.map((p) => p[2]));
  return low === high ? `cada ${low} min` : `cada ${low}–${high} min`;
}

/**
 * The direction's table: first and last bus, then how often it comes in each
 * period, a column per day type. A day type the feed does not run gets no
 * column, and a period no day runs gets no row.
 *
 * `nombreParada(codigo)` names the paradero the departures are counted at, when
 * that is not the first one listed (`DiaHorario.desde`).
 */
export function programadoHtml(sentido, nombreParada = () => '') {
  const dias = DIAS.filter(([dia]) => sentido?.dias[dia]);
  if (!dias.length) return '';
  const fila = (th, celda) => `<tr><th scope="row">${escapeHtml(th)}</th>${dias.map(([dia]) => `<td>${escapeHtml(celda(sentido.dias[dia]) ?? '—')}</td>`).join('')}</tr>`;
  const periodos = PERIODOS.map((label, i) =>
    dias.some(([dia]) => sentido.dias[dia].cada[i]) ? fila(label, (d) => cadaTexto(d.cada[i])) : ''
  ).join('');
  const desde = sentido.dias[dias[0][0]].desde;
  const lugar = desde > 0 ? nombreParada(sentido.paradas[desde]) : '';
  return (
    `<table class="programado"><thead><tr><td></td>${dias.map(([, label]) => `<th scope="col">${escapeHtml(label)}</th>`).join('')}</tr></thead><tbody>` +
    fila('Primer bus', (d) => hora(d.primera)) +
    fila('Último bus', (d) => hora(d.ultima)) +
    fila('Buses al día', (d) => String(d.salidas)) +
    periodos +
    `</tbody></table>` +
    (lugar ? `<p class="programado-nota">Primer y último bus contados en ${escapeHtml(lugar)}.</p>` : '')
  );
}
