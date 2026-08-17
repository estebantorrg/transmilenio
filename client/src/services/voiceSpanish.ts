/**
 * Spanish speech tables for the voice flow (spec §5.9) — the one place that
 * knows how a Bogotá rider *says* a route code and how we say a time back.
 *
 * Used from both ends of the flow (`voiceMatch.ts` parses, `voiceAnswer.ts`
 * generates), so the letter table lives here rather than in either of them
 * (spec §1.1 R2).
 *
 * These are speech helpers, not UI ones: `utils/geo.ts` already formats "3,2 km"
 * for the screen, but an abbreviation is not what a rider should hear, so the
 * spoken forms are spelled out here instead of reusing the display formatters.
 */

import { MINUTES_PER_DAY } from './schedule';

/** Accent/case fold + punctuation to spaces. ASR output is free text — treat it
 *  as untrusted like any other external string (spec §3.3). */
export function normalizeUtterance(value: string): string {
  return String(value ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * The comparable words of a place name — folded, punctuation gone, one- and
 * two-letter connectors dropped ("de", "la", "Av") but digits always kept, since
 * a Bogotá stop is very often only distinguished by its number ("Calle 100" vs
 * "Calle 106").
 *
 * One implementation, used wherever the rider's words are matched against a stop
 * or destination name (`routeEta.matchStopByName`, `voiceStops`) — two copies of
 * this would drift into two different ideas of what "Calle 100" matches
 * (spec §1.1 R2).
 */
/**
 * Words that name nothing in this network. The one- and two-letter connectors
 * ("de", "la", "av") fall out of the length rule below; these are the ones long
 * enough to survive it and still carry no information — a rider says "los
 * laureles" for the station the catalog files as "Laureles", and requiring that
 * extra word to appear sent them to "Br. Los Laureles", the paradero across the
 * road. Dropped from **both** sides, since every caller tokenises the rider's
 * words and the stop's name through this same function.
 */
const NAME_STOPWORDS = new Set(['los', 'las', 'del']);

export function nameTokens(value: string): string[] {
  return normalizeUtterance(value)
    .split(' ')
    .filter((token) => (token.length > 2 && !NAME_STOPWORDS.has(token)) || /^\d+$/.test(token));
}

// ─── Letters ──────────────────────────────────────────────
// Written → spoken, for reading a código out loud. "F19" as-is is read by
// Android TTS as an English-ish "F"; "efe 19" is unambiguous in es-CO.
const LETTER_SPOKEN: Record<string, string> = {
  A: 'a', B: 'be', C: 'ce', D: 'de', E: 'e', F: 'efe', G: 'ge', H: 'hache',
  I: 'i', J: 'jota', K: 'ka', L: 'ele', M: 'eme', N: 'ene', O: 'o', P: 'pe',
  Q: 'cu', R: 'erre', S: 'ese', T: 'te', U: 'u', V: 'uve', W: 'doble u',
  X: 'equis', Y: 'ye', Z: 'zeta',
};

// Spoken → written, with the variants a recognizer actually returns: regional
// letter names ("ve"/"uve"), and the homophones es-CO speakers produce because
// the language is seseante ("seta" for zeta, "se" for ce).
const LETTER_WRITTEN: Record<string, string> = {
  a: 'A', be: 'B', 'be larga': 'B', ce: 'C', se: 'C', de: 'D', e: 'E', efe: 'F',
  ge: 'G', je: 'G', hache: 'H', ache: 'H', i: 'I', jota: 'J', ka: 'K', ca: 'K',
  ele: 'L', eme: 'M', ene: 'N', o: 'O', pe: 'P', cu: 'Q', ku: 'Q', erre: 'R',
  ere: 'R', ese: 'S', te: 'T', u: 'U', uve: 'V', ve: 'V', 've corta': 'V',
  'doble u': 'W', 'doble ve': 'W', 'uve doble': 'W', equis: 'X', ye: 'Y',
  'i griega': 'Y', zeta: 'Z', seta: 'Z',
};

/** Longest-first so "doble u" wins over "u" when both could start a match. */
const LETTER_PHRASES = Object.keys(LETTER_WRITTEN).sort((a, b) => b.length - a.length);

/** The written letter a spoken word (or two-word phrase) stands for, else null. */
export function letterFromSpoken(phrase: string): string | null {
  return LETTER_WRITTEN[phrase] ?? null;
}

export function isLetterPhraseStart(token: string): boolean {
  return LETTER_PHRASES.some((phrase) => phrase === token || phrase.startsWith(`${token} `));
}

/**
 * The letter a clipped token stands for, when exactly one letter name starts
 * with it — "ef" → F. Recognizers routinely drop the final vowel of a letter
 * name, and an ambiguous prefix ("e" → e/efe/ele/eme/…) resolves to nothing
 * rather than to a guess.
 */
export function letterFromPartial(token: string): string | null {
  if (token.length < 2) return null;
  const matches = LETTER_PHRASES.filter((phrase) => phrase.startsWith(token));
  if (matches.length === 0) return null;
  const letters = new Set(matches.map((phrase) => LETTER_WRITTEN[phrase]));
  return letters.size === 1 ? (letters.values().next().value ?? null) : null;
}

/**
 * "F19" → "efe 19"; "1" → "1"; "8-1" → "8 1". Digits are left alone — TTS reads
 * them fine — but the hyphen in an alimentador código is not punctuation a rider
 * says: es-CO TTS reads "8-1" as "ocho menos uno", which is arithmetic, not a bus.
 * Riders say "la ocho uno", so the separator becomes a pause.
 */
export function speakRouteCode(code: string): string {
  const parts: string[] = [];
  let digits = '';
  for (const char of String(code ?? '').toUpperCase().replace(/-/g, ' ')) {
    const spoken = LETTER_SPOKEN[char];
    if (spoken) {
      if (digits) {
        parts.push(digits);
        digits = '';
      }
      parts.push(spoken);
    } else {
      digits += char;
    }
  }
  if (digits) parts.push(digits);
  return parts.join(' ').trim() || String(code ?? '');
}

// ─── Numbers ──────────────────────────────────────────────
// Route códigos run to three digits, so 0–999 is the whole range that matters.

const UNITS: Record<string, number> = {
  cero: 0, un: 1, uno: 1, una: 1, dos: 2, tres: 3, cuatro: 4,
  cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9,
};

const TEENS: Record<string, number> = {
  diez: 10, once: 11, doce: 12, trece: 13, catorce: 14, quince: 15,
  dieciseis: 16, diecisiete: 17, dieciocho: 18, diecinueve: 19,
  veinte: 20, veintiuno: 21, veintiun: 21, veintiuna: 21, veintidos: 22,
  veintitres: 23, veinticuatro: 24, veinticinco: 25, veintiseis: 26,
  veintisiete: 27, veintiocho: 28, veintinueve: 29,
};

const TENS: Record<string, number> = {
  treinta: 30, cuarenta: 40, cincuenta: 50, sesenta: 60,
  setenta: 70, ochenta: 80, noventa: 90,
};

const HUNDREDS: Record<string, number> = {
  cien: 100, ciento: 100, doscientos: 200, trescientos: 300, cuatrocientos: 400,
  quinientos: 500, seiscientos: 600, setecientos: 700, ochocientos: 800, novecientos: 900,
};

export interface NumberRun {
  value: number;
  /** Index just past the last token consumed. */
  next: number;
  /** True when the run was a single 0–9 word, so "seis dos ocho" can also be
   *  read as the digit string 628 — riders spell zonal códigos both ways. */
  singleDigit: boolean;
}

/**
 * Read one Spanish number starting at `tokens[i]` ("ochenta y seis" → 86), or a
 * literal digit group ("86" → 86). Returns null when the token is not numeric.
 */
export function readNumber(tokens: string[], i: number): NumberRun | null {
  const token = tokens[i];
  if (token === undefined) return null;

  if (/^\d{1,3}$/.test(token)) {
    return { value: Number(token), next: i + 1, singleDigit: token.length === 1 };
  }

  let value = 0;
  let index = i;
  let consumed = false;

  if (HUNDREDS[tokens[index]] !== undefined) {
    value += HUNDREDS[tokens[index]];
    index++;
    consumed = true;
  }

  if (TENS[tokens[index]] !== undefined) {
    value += TENS[tokens[index]];
    index++;
    consumed = true;
    // "treinta y uno" — the conjunction only joins a tens word to a unit.
    if (tokens[index] === 'y' && UNITS[tokens[index + 1]] !== undefined) {
      value += UNITS[tokens[index + 1]];
      index += 2;
    }
  } else if (TEENS[tokens[index]] !== undefined) {
    value += TEENS[tokens[index]];
    index++;
    consumed = true;
  } else if (UNITS[tokens[index]] !== undefined) {
    const unit = UNITS[tokens[index]];
    value += unit;
    index++;
    return { value, next: index, singleDigit: !consumed };
  }

  return consumed ? { value, next: index, singleDigit: false } : null;
}

// ─── Spoken output ────────────────────────────────────────

/** "4:30 de la mañana" / "10:00 de la noche" / "mediodía". Digits are kept —
 *  es-CO TTS reads "4:30" correctly; it is the a.m./p.m. abbreviation that does
 *  not survive being spoken, so the period is a phrase. */
export function speakClock(minute: number): string {
  const normalized = ((Math.round(minute) % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  if (normalized === 0) return 'medianoche';
  if (normalized === 720) return 'mediodía';

  const hour24 = Math.floor(normalized / 60);
  const mins = normalized % 60;
  const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
  const period =
    hour24 < 5 ? 'de la madrugada' : hour24 < 12 ? 'de la mañana' : hour24 < 19 ? 'de la tarde' : 'de la noche';
  return `${hour12}:${String(mins).padStart(2, '0')} ${period}`;
}

/** "240 metros" / "3,2 kilómetros" — the spoken twin of `formatDistance`. */
export function speakDistance(meters: number): string {
  if (!Number.isFinite(meters)) return '';
  if (meters < 1000) {
    const rounded = Math.max(10, Math.round(meters / 10) * 10);
    return `${rounded} metros`;
  }
  const km = (meters / 1000).toFixed(1).replace('.', ',');
  return `${km.replace(/,0$/, '')} kilómetros`;
}

/**
 * A station/destination name as it should be read out. The catalog joins compound
 * names with dashes ("Suba - Tv. 91", "Portal El Dorado – C.C Nuestro Bogotá");
 * a comma is the pause a listener expects there, where a dash is either silence
 * or a literal "guión". Nothing else is rewritten — abbreviations are upstream
 * data and guessing at their expansion would put words in the operator's mouth.
 */
export function speakPlace(name: string): string {
  return String(name ?? '')
    .replace(/\s*[–—]\s*/g, ', ')
    .replace(/\s+-\s+/g, ', ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** "1 minuto" / "7 minutos" — agreement matters more than it looks when spoken. */
export function speakMinutes(minutes: number): string {
  const value = Math.max(0, Math.round(minutes));
  return value === 1 ? '1 minuto' : `${value} minutos`;
}
