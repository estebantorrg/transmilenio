/**
 * Operator notices — a vagón or an access closed, services that skip a stop,
 * services moved to another vagón — and whether one is in force right now
 * (spec §5.5.6).
 *
 * The data is `server/src/data/avisos.json`, copied from TransMilenio's own
 * notices. It is decided HERE, in the reader's browser, and not when the
 * catalog is built: the catalog is built once and served for days, and a
 * nightly closure is on and off twice in that time. The server only drops a
 * notice whose end has passed.
 *
 * Every window is Bogotá time, UTC-5 all year: Colombia keeps no daylight
 * saving, so a fixed offset is the whole of the timezone and no tz database is
 * needed to read "de 10:00 p. m. a 4:00 a. m." correctly from anywhere.
 */

const BOGOTA_OFFSET_MS = -5 * 60 * 60 * 1000;
const TODOS_LOS_DIAS = [0, 1, 2, 3, 4, 5, 6];

/** "22:00" → 1320, or NaN when it is not a time of day. */
function minutosDelDia(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm ?? '').trim());
  if (!m) return NaN;
  const h = Number(m[1]);
  const min = Number(m[2]);
  return h <= 24 && min < 60 ? h * 60 + min : NaN;
}

/**
 * Whether one notice is in force at `fecha`.
 *
 * `desde` is required and `hasta` is not: a notice with no end runs until it is
 * taken out of the file, which is how the operator words an open-ended change.
 * A date that does not parse makes the notice NOT in force — a notice shown at
 * the wrong time sends a rider to a closed vagón, and one that is not shown
 * only leaves them where the sheet already put them.
 *
 * A `franja` crossing midnight belongs to the day it STARTS on, as the operator
 * writes it: "de lunes a viernes, de 10:00 p. m. a 4:00 a. m." includes Friday
 * night into Saturday morning, and not Sunday night into Monday.
 */
export function avisoVigente(aviso, fecha = new Date()) {
  if (!aviso) return false;
  const t = fecha instanceof Date ? fecha.getTime() : Number(fecha);
  if (!Number.isFinite(t)) return false;
  const desde = Date.parse(aviso.desde);
  if (!(t >= desde)) return false;
  if (aviso.hasta != null && !(t < Date.parse(aviso.hasta))) return false;

  const franja = aviso.franja;
  if (!franja) return true;
  const inicio = minutosDelDia(franja.desde);
  const fin = minutosDelDia(franja.hasta);
  if (!Number.isFinite(inicio) || !Number.isFinite(fin) || inicio === fin) return false;
  const dias = Array.isArray(franja.dias) && franja.dias.length ? franja.dias : TODOS_LOS_DIAS;

  const local = new Date(t + BOGOTA_OFFSET_MS);
  const dia = local.getUTCDay();
  const minuto = local.getUTCHours() * 60 + local.getUTCMinutes();
  if (inicio < fin) return dias.includes(dia) && minuto >= inicio && minuto < fin;
  // Crosses midnight: the evening half is today's window, the morning half is
  // yesterday's.
  if (minuto >= inicio) return dias.includes(dia);
  if (minuto < fin) return dias.includes((dia + 6) % 7);
  return false;
}

/**
 * Everything the notices in force say about a station at `fecha`, merged: the
 * notices themselves (for the banner), and what they close, skip and move (for
 * the drawing). Vagón numbers are the ones on the platform signs; service
 * códigos come back upper-cased.
 */
export function estadoAvisos(avisos, fecha = new Date()) {
  const vigentes = (Array.isArray(avisos) ? avisos : []).filter((a) => avisoVigente(a, fecha));
  const vagones = new Set();
  const accesos = new Set();
  const omiten = new Set();
  const traslados = {};
  for (const aviso of vigentes) {
    for (const v of aviso.cierra?.vagones ?? []) vagones.add(String(v).trim());
    for (const a of aviso.cierra?.accesos ?? []) accesos.add(String(a).trim());
    for (const c of aviso.omiten ?? []) omiten.add(String(c).trim().toUpperCase());
    for (const [de, a] of Object.entries(aviso.trasladan ?? {})) traslados[String(de).trim()] = String(a).trim();
  }
  return {
    vigentes,
    vagones: [...vagones],
    accesos: [...accesos],
    omiten: [...omiten],
    traslados,
  };
}
