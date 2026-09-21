// horarios.mjs — ¿está operando una ruta ahora? (hora de Bogotá)
//
// Uso: routeOpenNow(apiRoute.horarios) con el objeto `horarios` que ya trae
// cada ruta de `searchRutaByTipo` → { data: [{ convencion, hora_inicio, hora_fin }] }.
//
// Self-contained on purpose (scripts are copied around standalone), so it
// mirrors client/src/services/schedule.ts and shared/festivos.js instead of
// importing them; tests/horarios-script.spec.ts pins the two to agree.

// Margen alrededor del horario publicado. Los buses arrancan un poco antes y el
// último sigue rodando después de `hora_fin`; ajústelo con datos reales.
const MARGIN_BEFORE_MIN = 15;
const MARGIN_AFTER_MIN = 60;

// ─── Días ────────────────────────────────────────────────────────────────
const SUN = 1 << 0, MON = 1 << 1, TUE = 1 << 2, WED = 1 << 3, THU = 1 << 4, FRI = 1 << 5, SAT = 1 << 6;
const FESTIVO = 1 << 7;
const WEEKDAYS = MON | TUE | WED | THU | FRI;
const DAY_BIT = [SUN, MON, TUE, WED, THU, FRI, SAT]; // índice = Date#getDay()

const CONVENCION = {
  'L-V': WEEKDAYS,
  'L-S': WEEKDAYS | SAT,
  'L-D': WEEKDAYS | SAT | SUN | FESTIVO,
  L: MON,
  S: SAT,
  D: SUN,
  'D-F': SUN | FESTIVO,
  'D-F-A': SUN | FESTIVO,
  F: FESTIVO,
};

// ─── Horas ("4:30 AM", "04:00 am", "2:00 pm") → minutos desde medianoche ──
function parseClock(value) {
  const m = /^(\d{1,2}):(\d{2})\s*(AM|PM)?$/.exec(String(value ?? '').trim().toUpperCase().replace(/\./g, ''));
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2]);
  if (min > 59) return null;
  if (m[3]) {
    if (h < 1 || h > 12) return null;
    h = (h % 12) + (m[3] === 'PM' ? 12 : 0);
  } else if (h > 23) return null;
  return h * 60 + min;
}

/** `horarios` → [{ mask, start, end }] o null si no se puede leer (= tratar como abierta). */
export function parseHorarios(horarios) {
  const rows = horarios?.data;
  if (!Array.isArray(rows)) return null;
  const spans = [];
  for (const row of rows) {
    const mask = CONVENCION[String(row?.convencion ?? '').toUpperCase().replace(/[\s.]/g, '')] ?? 0;
    const start = parseClock(row?.hora_inicio);
    const rawEnd = parseClock(row?.hora_fin);
    if (!mask || start === null || rawEnd === null) continue;
    // "4:30 AM – 12:30 AM" cierra 30 min después de medianoche, no 20 h antes.
    spans.push({ mask, start, end: rawEnd <= start ? rawEnd + 1440 : rawEnd });
  }
  return spans.length ? spans : null;
}

// ─── Festivos de Colombia (fijos + Ley Emiliani + los que dependen de Pascua) ─
const FIXED = [[1, 1], [5, 1], [7, 20], [8, 7], [12, 8], [12, 25]];
const EMILIANI = [[1, 6], [3, 19], [6, 29], [8, 15], [10, 12], [11, 1], [11, 11]];
const holidayCache = new Map();
function easter(y) {
  const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4;
  const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31), day = ((h + l - 7 * m + 114) % 31) + 1;
  return Date.UTC(y, month - 1, day);
}
function holidays(y) {
  if (holidayCache.has(y)) return holidayCache.get(y);
  const set = new Set();
  const key = (t) => new Date(t).toISOString().slice(0, 10);
  const nextMonday = (t) => t + ((8 - new Date(t).getUTCDay()) % 7) * 86400000;
  for (const [mo, d] of FIXED) set.add(key(Date.UTC(y, mo - 1, d)));
  for (const [mo, d] of EMILIANI) set.add(key(nextMonday(Date.UTC(y, mo - 1, d))));
  const e = easter(y);
  for (const days of [-3, -2, 43, 64, 71]) set.add(key(e + days * 86400000));
  holidayCache.set(y, set);
  return set;
}
function isFestivo(y, mo, d) {
  return holidays(y).has(`${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`);
}

// ─── Reloj de Bogotá (UTC-5 fijo, Colombia no tiene horario de verano) ─────
function bogotaDay(date, offsetDays = 0) {
  const t = new Date(date.getTime() - 5 * 3600000 + offsetDays * 86400000);
  const y = t.getUTCFullYear(), mo = t.getUTCMonth() + 1, d = t.getUTCDate();
  return { mask: DAY_BIT[t.getUTCDay()], festivo: isFestivo(y, mo, d), minute: t.getUTCHours() * 60 + t.getUTCMinutes() };
}

/** ¿La ruta está operando en `date`? Horario ilegible → true (mejor consultar que perderla). */
export function routeOpenAt(horarios, date = new Date(), { before = MARGIN_BEFORE_MIN, after = MARGIN_AFTER_MIN } = {}) {
  const spans = parseHorarios(horarios);
  if (!spans) return true;
  const allMask = spans.reduce((acc, s) => acc | s.mask, 0);
  const now = bogotaDay(date).minute;
  // Ayer (por los horarios que pasan de medianoche) y hoy.
  for (const [offset, shift] of [[-1, -1440], [0, 0]]) {
    const day = bogotaDay(date, offset);
    let mask = day.mask;
    // Festivo: aplica su propio horario (D-F, L-D, F), nunca el de L-V. Si la
    // ruta no publica horario de festivo, usa el del domingo.
    if (day.festivo) mask = FESTIVO | (day.mask === SUN || !(allMask & FESTIVO) ? SUN : 0);
    for (const s of spans) {
      if (!(s.mask & mask)) continue;
      if (now >= shift + s.start - before && now <= shift + s.end + after) return true;
    }
  }
  return false;
}

export const routeOpenNow = (horarios) => routeOpenAt(horarios, new Date());
