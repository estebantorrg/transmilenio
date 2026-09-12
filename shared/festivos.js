/**
 * The Colombian public-holiday calendar, shared by every surface that needs it
 * (spec §5.6.2, §5.6.5).
 *
 * Festivos are law, not a guess: six fixed dates, seven Emiliani dates (Ley 51
 * de 1983 — observed the following Monday), and five Easter-relative dates.
 * Computed, not tabulated, so the calendar never expires.
 *
 * It lives here rather than in the client's `schedule.ts` because the server
 * needs the same answer: the arrivals board reads a bus speed that depends on
 * the day type, and a festivo that runs a Sunday service must not be costed as
 * a Monday. One implementation, two consumers.
 */

/** @type {Array<[number, number, string]>} */
const FIXED_HOLIDAYS = [
  [1, 1, 'Año Nuevo'],
  [5, 1, 'Día del Trabajo'],
  [7, 20, 'Día de la Independencia'],
  [8, 7, 'Batalla de Boyacá'],
  [12, 8, 'Inmaculada Concepción'],
  [12, 25, 'Navidad'],
];

/** @type {Array<[number, number, string]>} */
const EMILIANI_HOLIDAYS = [
  [1, 6, 'Día de los Reyes Magos'],
  [3, 19, 'Día de San José'],
  [6, 29, 'San Pedro y San Pablo'],
  [8, 15, 'Asunción de la Virgen'],
  [10, 12, 'Día de la Raza'],
  [11, 1, 'Todos los Santos'],
  [11, 11, 'Independencia de Cartagena'],
];

/** Easter Sunday (Gregorian, Meeus/Jones/Butcher). */
function easterSunday(year) {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(Date.UTC(year, month - 1, day));
}

function keyOf(date) {
  return `${date.getUTCFullYear()}-${date.getUTCMonth() + 1}-${date.getUTCDate()}`;
}

/** Same date, or the following Monday when it falls on any other weekday. */
function nextMonday(date) {
  const dow = date.getUTCDay();
  if (dow === 1) return date;
  const shift = (8 - dow) % 7;
  return new Date(date.getTime() + shift * 86_400_000);
}

const holidayCache = new Map();

function holidaysForYear(year) {
  const cached = holidayCache.get(year);
  if (cached) return cached;

  const holidays = new Map();
  const add = (date, name) => holidays.set(keyOf(date), name);

  for (const [month, day, name] of FIXED_HOLIDAYS) add(new Date(Date.UTC(year, month - 1, day)), name);
  for (const [month, day, name] of EMILIANI_HOLIDAYS) add(nextMonday(new Date(Date.UTC(year, month - 1, day))), name);

  const easter = easterSunday(year);
  const fromEaster = (days) => new Date(easter.getTime() + days * 86_400_000);
  add(fromEaster(-3), 'Jueves Santo');
  add(fromEaster(-2), 'Viernes Santo');
  add(fromEaster(43), 'Ascensión del Señor'); // Thursday +39, observed Monday
  add(fromEaster(64), 'Corpus Christi'); //      Thursday +60, observed Monday
  add(fromEaster(71), 'Sagrado Corazón'); //     Friday   +68, observed Monday

  holidayCache.set(year, holidays);
  return holidays;
}

/** Colombian public-holiday name for a date, or `undefined` on a normal day. */
export function festivoName(year, month, day) {
  return holidaysForYear(year).get(`${year}-${month}-${day}`);
}

export function isFestivo(year, month, day) {
  return holidaysForYear(year).has(`${year}-${month}-${day}`);
}
