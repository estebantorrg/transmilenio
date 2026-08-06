/**
 * Utterance → route código (spec §5.9).
 *
 * A recognizer never hands back "F19". It hands back "efe diecinueve", "la efe
 * 19", "f 19", "ef19", or the route's destination because that is what the rider
 * actually said. This resolves any of those to a código in `voice_index.json`,
 * with a confidence the caller can refuse to act on — a wrong route answered
 * confidently is worse than "no te entendí" (spec §1, certainty).
 *
 * Deliberately no NLU: the search space is 783 códigos and a handful of naming
 * conventions, so a letter/number table plus edit distance beats a model on both
 * accuracy and the latency budget. Measured at ~5 ms per utterance over the whole
 * index — the edit-distance sweep dominates, and it is what catches a recognizer
 * that hears "efe diecinueve" as one glyph off (spec §1, sub-100 ms).
 */

import { getBaseRouteCode } from '../data/routeCatalog';
import { normalizeRouteCodeForMatch } from '../utils/routeColors';
import {
  isLetterPhraseStart,
  letterFromPartial,
  letterFromSpoken,
  normalizeUtterance,
  readNumber,
} from './voiceSpanish';
import type { VoiceIndex } from '../types/voice';

/** Below this, the flow must ask rather than answer. */
export const MIN_VOICE_CONFIDENCE = 0.5;

/**
 * Below {@link MIN_VOICE_CONFIDENCE} but worth naming out loud.
 *
 * "No te entendí" with nothing after it makes the rider guess what the app can
 * hear. A reading this weak must never be *answered* — that is the certainty rule
 * (spec §1) — but offering it as a question ("¿el F19 o el F60?") costs one tap
 * and turns a dead end into an answer, which is the whole difference between a
 * flow that works and one a rider gives up on.
 */
export const SUGGEST_VOICE_CONFIDENCE = 0.3;

export interface VoiceMatch {
  code: string;
  /** 0–1. 1 = the utterance contained this código outright. */
  confidence: number;
  via: 'codigo' | 'nombre';
  /** The fragment that produced the match, for a "¿el F19?" confirmation line. */
  matched: string;
}

// Words that carry the question rather than the answer. Dropped from BOTH the
// utterance and the route names before comparing, so "el portal de suba" still
// matches "Portal Suba".
const STOPWORDS = new Set([
  'que', 'tan', 'cerca', 'esta', 'estan', 'queda', 'cuanto', 'cuanta', 'falta',
  'para', 'por', 'donde', 'cuando', 'pasa', 'llega', 'viene', 'hora', 'demora',
  'tarda', 'proximo', 'proxima', 'siguiente', 'bus', 'buses', 'ruta', 'rutas',
  'alimentador', 'el', 'la', 'los', 'las', 'un', 'una', 'de', 'del', 'al', 'a',
  'mi', 'me', 'se', 'y', 'en', 'hacia', 'hasta', 'desde', 'mas', 'muy', 'ya',
]);

function contentTokens(value: string): string[] {
  return normalizeUtterance(value)
    .split(' ')
    .filter((token) => token.length > 0 && !STOPWORDS.has(token));
}

/** Edit distance, abandoned as soon as it exceeds `max` — we only ever care
 *  whether two códigos are one slip apart, never how far apart they really are. */
function withinEditDistance(a: string, b: string, max: number): boolean {
  if (Math.abs(a.length - b.length) > max) return false;
  if (a === b) return true;

  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const curr = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
      if (curr[j] < rowMin) rowMin = curr[j];
    }
    if (rowMin > max) return false;
    prev = curr;
  }
  return prev[b.length] <= max;
}

/**
 * Every código the utterance could plausibly be, most literal first.
 *
 * A letter word is only read as a letter when a number follows it, because half
 * the letter names are ordinary Spanish words — "de", "se", "a", "ese". Requiring
 * the letter+number shape of a real código is what keeps "cuánto falta **de** mi
 * casa" from being read as route D.
 */
function codeCandidates(utterance: string): string[] {
  const tokens = normalizeUtterance(utterance).split(' ').filter(Boolean);
  const out: string[] = [];
  const push = (value: string) => {
    const code = normalizeRouteCodeForMatch(value);
    if (code && !out.includes(code)) out.push(code);
  };

  let i = 0;
  while (i < tokens.length) {
    // Already-joined forms the recognizer sometimes returns outright: "f19".
    if (/^[a-z]{1,2}\d{1,3}$/.test(tokens[i])) {
      push(tokens[i]);
      i++;
      continue;
    }

    // A letter name is one token ("efe") or two ("doble u", "i griega").
    let letter: string | null = null;
    let after = i;
    // `weak` = the letter was inferred from a clipped or bare token rather than
    // read from a real letter name. Those readings stay speculative: the number
    // beside them is also offered on its own, so "el treinta y siete" can still
    // resolve to route 37 even though "el" looks like a spoken "E".
    let weak = false;
    const pair = letterFromSpoken(`${tokens[i]} ${tokens[i + 1] ?? ''}`);
    if (pair) {
      letter = pair;
      after = i + 2;
    } else if (isLetterPhraseStart(tokens[i])) {
      letter = letterFromSpoken(tokens[i]);
      if (letter !== null) after = i + 1;
    }
    // Clipped ("ef" → F) or bare glyph ("f 19"), but never an ordinary Spanish
    // word: "el", "la" and "de" precede a route far more often than they name a
    // letter, and reading them as one swallows the código that follows.
    if (letter === null && /^[a-z]{1,2}$/.test(tokens[i]) && !STOPWORDS.has(tokens[i])) {
      letter = letterFromPartial(tokens[i]) ?? tokens[i].toUpperCase();
      after = i + 1;
      weak = true;
    }

    const first = letter === null ? null : readNumber(tokens, after);
    if (letter !== null && first) {
      // "efe diecinueve" → F19.
      push(`${letter}${first.value}`);
      if (weak) push(String(first.value));
      let consumedTo = first.next;
      // "a seis dos ocho" → A628: zonal códigos get spelled digit by digit just
      // as often as they get read as a number.
      if (first.singleDigit) {
        let digits = String(first.value);
        let cursor = first.next;
        for (;;) {
          const next = readNumber(tokens, cursor);
          if (!next || !next.singleDigit || digits.length >= 3) break;
          digits += String(next.value);
          cursor = next.next;
          consumedTo = cursor;
          push(`${letter}${digits}`);
        }
      }
      // Skip the number we just read. Re-reading it as a bare código would let
      // "ka ochenta y seis" also propose route 86 — and a bare número scores as
      // high as the real match, so the right answer would lose the tie-break.
      i = consumedTo;
      continue;
    }

    // Bare numeric códigos exist ("1", "7", "37").
    const bare = letter === null ? readNumber(tokens, i) : null;
    if (bare) {
      push(String(bare.value));
      i = bare.next;
      continue;
    }
    i++;
  }

  return out;
}

/**
 * The searchable words of every route, derived once per index.
 *
 * Rebuilding these per comparison meant re-tokenising 783 route names for every
 * reading the recognizer offered — the dominant cost of the whole module, paid
 * again on every question. The index object is immutable for the life of the app,
 * so a `WeakMap` keyed on it is exact and costs nothing to invalidate.
 */
const haystacks = new WeakMap<VoiceIndex, Map<string, Set<string>>>();

function nameHaystacks(index: VoiceIndex): Map<string, Set<string>> {
  const cached = haystacks.get(index);
  if (cached) return cached;
  const built = new Map<string, Set<string>>();
  for (const [code, route] of Object.entries(index?.routes || {})) {
    built.set(
      code,
      new Set(
        contentTokens(
          [route.nombre, ...Object.values(route.dirs || {}).flatMap((d) => [d.origin, d.destination])].join(' ')
        )
      )
    );
  }
  haystacks.set(index, built);
  return built;
}

function scoreByName(needle: string[], haystack: Set<string> | undefined): number {
  if (needle.length === 0 || !haystack || haystack.size === 0) return 0;

  const hits = needle.filter((token) => haystack.has(token));
  // A single shared word is a coincidence unless it is long enough to be a place
  // ("banderas"); "casa" in "cuánto falta de mi casa" is not a route name.
  if (hits.length === 0) return 0;
  if (hits.length === 1 && hits[0].length < 6) return 0;
  const coverage = hits.length / needle.length;
  return coverage >= 0.6 ? 0.5 + 0.25 * coverage : 0;
}

/**
 * Resolve what the rider said to route códigos, best first.
 *
 * Returns an empty list rather than a guess when nothing clears
 * {@link MIN_VOICE_CONFIDENCE} — the caller says "no te entendí" and the rider
 * repeats, which costs one second; answering the wrong route costs a bus.
 */
export function matchRouteCode(
  utterance: string | string[],
  index: VoiceIndex,
  limit = 3,
  minConfidence = MIN_VOICE_CONFIDENCE
): VoiceMatch[] {
  const routes = index?.routes || {};
  const codes = Object.keys(routes);
  if (codes.length === 0) return [];

  const byConfidence = new Map<string, VoiceMatch>();
  const offer = (match: VoiceMatch) => {
    const existing = byConfidence.get(match.code);
    if (!existing || match.confidence > existing.confidence) byConfidence.set(match.code, match);
  };

  // Every reading the recognizer offered, not just its favourite. The códigos
  // table is a much better judge of "efe 19" vs "fe 19" than the recognizer's own
  // ranking is, and the alternatives are free — they came back in the same result.
  const readings = (Array.isArray(utterance) ? utterance : [utterance]).map((value) => String(value ?? '')).filter(Boolean);
  if (readings.length === 0) return [];

  const candidates: string[] = [];
  for (const reading of readings) {
    for (const candidate of codeCandidates(reading)) {
      if (!candidates.includes(candidate)) candidates.push(candidate);
    }
  }
  // Normalized/base forms are derived once for the whole index, not per
  // candidate — an utterance yields several candidates and this is the inner
  // loop of the latency budget (spec §1, performance).
  const normalizedCodes = codes.map((code) => {
    const norm = normalizeRouteCodeForMatch(code);
    return { code, norm, base: getBaseRouteCode(norm) };
  });

  for (const candidate of candidates) {
    if (routes[candidate]) {
      offer({ code: candidate, confidence: 1, via: 'codigo', matched: candidate });
      continue;
    }
    const candidateBase = getBaseRouteCode(candidate);
    for (const { code, norm, base } of normalizedCodes) {
      if (norm === candidate) offer({ code, confidence: 1, via: 'codigo', matched: candidate });
      else if (candidateBase && base === candidateBase) {
        offer({ code, confidence: 0.85, via: 'codigo', matched: candidate });
      } else if (withinEditDistance(norm, candidate, 1)) {
        offer({ code, confidence: 0.6, via: 'codigo', matched: candidate });
      }
    }
  }

  const byName = nameHaystacks(index);
  for (const reading of readings) {
    const needle = contentTokens(reading);
    if (needle.length === 0) continue;
    for (const code of codes) {
      const confidence = scoreByName(needle, byName.get(code));
      if (confidence > 0) offer({ code, confidence, via: 'nombre', matched: routes[code].nombre });
    }
  }

  return Array.from(byConfidence.values())
    .filter((match) => match.confidence >= minConfidence)
    .sort((a, b) => b.confidence - a.confidence || a.code.localeCompare(b.code))
    .slice(0, limit);
}

// ─── What was asked, not only about what ──────────────────

/**
 * The kind of question, because a rider asks more than one.
 *
 * These are the five things someone actually says to a transit app in a day, and
 * every one of them but `eta` used to answer "no encontré una ruta que se llame…":
 *
 * * `eta` — the headline. "¿Qué tan cerca está el F19?"
 * * `horario` — "¿A qué hora abre?", "¿pasa los domingos?". Answerable from the
 *   route index alone: no position, no geometry, no live call, so it lands in
 *   milliseconds with no network at all (spec §4.2).
 * * `paradas` — the inverse question, asked standing at a paradero: "¿qué buses
 *   pasan por aquí?", "¿qué me sirve?", "¿dónde estoy?". Answered offline off the
 *   stop index (`voiceStops.ts`), with the live ETA one tap away per route.
 * * `viaje` — "¿cómo llego a Suba?". Hands the trip to the planner, seeded, rather
 *   than making the rider re-type both endpoints they just said out loud.
 * * `saldo` — "¿cuánto saldo tengo?". A remembered card is read without a tap.
 * * `ayuda` — "¿qué puedes hacer?". A feature nobody can discover is a feature
 *   nobody uses daily, and a voice surface has no menu to read.
 */
export type VoiceIntent = 'eta' | 'horario' | 'paradas' | 'viaje' | 'saldo' | 'ayuda';

export interface VoiceRequest {
  intent: VoiceIntent;
  /** Confident readings, best first — `matches[0]` is what gets answered. */
  matches: VoiceMatch[];
  /** Sub-threshold readings, offered as a question rather than an answer. */
  suggestions: VoiceMatch[];
  /**
   * A stop the rider named ("el F19 **en Banderas**"). Honoured only when it
   * actually matches a stop on the route, so a false positive costs nothing.
   */
  stopHint: string;
  /** A direction the rider named ("**hacia** Portal Suba"). Same rule. */
  dirHint: string;
  /** Where they want to go ("cómo llego **a la Calle 100**"), for `viaje`. */
  destinationHint: string;
}

/** Words that make a question about the timetable rather than about a bus now. */
const SCHEDULE_WORDS = new Set([
  'horario', 'horarios', 'abre', 'abren', 'cierra', 'cierran', 'opera', 'operan',
  'funciona', 'funcionan', 'presta', 'servicio', 'domingo', 'domingos', 'sabado',
  'sabados', 'festivo', 'festivos', 'feriado', 'madrugada', 'ultimo', 'ultima',
  'primero', 'primer', 'primera', 'trabaja', 'trabajan', 'disponible', 'temprano',
]);

/** "¿Qué puedes hacer?" — asked once, by everyone, on the first day. */
const HELP_WORDS = new Set(['ayuda', 'ayudame', 'ayudar', 'instrucciones']);
const HELP_PHRASES = [
  'que puedes hacer', 'que sabes hacer', 'como funciona', 'que te puedo preguntar',
  'que puedo preguntar', 'que puedo decir', 'para que sirves',
];

/** The card. `tarjeta`/`tullave` are unambiguous; a bare "cuánto tengo" is not
 *  ("cuánto tengo que esperar"), so it needs one of these words with it. */
const SALDO_WORDS = new Set(['saldo', 'tarjeta', 'tullave', 'tullav', 'plata']);

/** "¿Cómo llego a…?" Kept tight on purpose: these all mean travel, and none of
 *  them is a word that turns up in a route question by accident. */
const TRIP_WORDS = new Set(['llego', 'llegar', 'llevame', 'ir', 'voy', 'irme']);
const TRIP_PHRASES = ['como llego', 'como llegar', 'como voy', 'como hago para', 'quiero ir', 'llevame a', 'necesito ir'];

/** The stop question. A *thing* word plus a deictic/interrogative — "qué buses",
 *  "cuáles rutas", "mi parada", "qué pasa por aquí". */
const STOP_QUESTION_THINGS = new Set(['buses', 'bus', 'rutas', 'ruta', 'parada', 'paradero', 'estacion', 'sirve', 'sirven', 'pasan', 'pasa']);
const STOP_QUESTION_CUES = new Set(['que', 'cuales', 'cual', 'aqui', 'aca', 'donde', 'mi', 'cerca', 'estoy']);
/** …and the phrasings that carry no "thing" word at all but mean exactly this. */
const STOP_QUESTION_PHRASES = [
  'donde estoy', 'que me sirve', 'que me sirven', 'cual me sirve', 'mi parada',
  'que hay cerca', 'que pasa por aqui', 'que pasa aqui', 'en que parada estoy',
];

/**
 * Words that mean "where I am" rather than naming a place.
 *
 * "¿Qué buses pasan por **aquí**?" is the single most likely phrasing of the stop
 * question, and taking `aquí` as a stop name answered "no encontré una parada que
 * se llame aquí" — a parody of the feature. A deictic hint is dropped, which is
 * exactly right: with no name, the position is the anchor.
 */
const DEICTIC = new Set(['aqui', 'aca', 'alli', 'alla', 'ahi', 'ahora', 'donde', 'estoy']);

/**
 * Tokens that introduce a place. `en`/`por`/`desde` are the ones riders use for
 * the stop they are standing at; `hacia`/`sentido`/`rumbo` name a direction;
 * `a`/`al`/`hasta`/`para` name a destination. All are read from the RAW tokens
 * (before stopword filtering), since the markers are themselves stopwords for name
 * matching.
 *
 * `portal`/`estacion`/`parada` double as markers because riders say "en Portal
 * Suba" — and `portal` is *kept* in the phrase, since it is part of the name,
 * while the role words are not.
 */
const STOP_MARKERS = new Set(['en', 'por', 'desde', 'estacion', 'parada', 'paradero', 'portal']);
const DIR_MARKERS = new Set(['hacia', 'sentido', 'rumbo', 'direccion']);
const TRIP_MARKERS = new Set(['a', 'al', 'hasta', 'para']);
/** Marker words that belong to the name that follows them. */
const KEPT_MARKERS = new Set(['portal']);

/** Words that end a place phrase — the next clause has started. Role words like
 *  `parada` are not here: "la parada de la 127" is one phrase, not two. */
const CLAUSE_BREAK = new Set([
  ...DIR_MARKERS,
  'en', 'por', 'desde', 'a', 'al', 'hasta', 'para',
  'que', 'cuanto', 'cuanta', 'cuando', 'cual', 'cuales', 'y', 'o', 'pero',
  'ruta', 'rutas', 'bus', 'buses',
]);

function phraseAfter(tokens: string[], markers: Set<string>): string {
  for (let i = 0; i < tokens.length; i++) {
    if (!markers.has(tokens[i])) continue;
    const words: string[] = KEPT_MARKERS.has(tokens[i]) ? [tokens[i]] : [];
    for (let j = i + 1; j < tokens.length && words.length < 6; j++) {
      const token = tokens[j];
      if (CLAUSE_BREAK.has(token)) break;
      if (/^\d+$/.test(token) && words.length === 0) {
        // A número straight after the marker is a código the rider is spelling
        // ("por la 19"), not a place — a place needs its noun first ("calle 100").
        break;
      }
      words.push(token);
    }
    const phrase = words.filter((word) => !STOPWORDS.has(word) || /^\d+$/.test(word)).join(' ');
    if (phrase) return phrase;
  }
  return '';
}

function hasPhrase(text: string, phrases: string[]): boolean {
  return phrases.some((phrase) => text.includes(phrase));
}

/**
 * Which question this is.
 *
 * Order is the design. A confident código means the rider is asking about *that
 * route*, so `paradas` is only considered when nothing matched — which is exactly
 * the case "¿qué buses pasan por la Calle 100?" produces. The three command-ish
 * intents outrank both, because "llévame a Suba" is unambiguous however many route
 * names happen to contain "Suba".
 */
function readIntent(text: string, tokens: string[], routeConfidence: number): VoiceIntent {
  const has = (set: Set<string>): boolean => tokens.some((token) => set.has(token));
  const isStopQuestion =
    (has(STOP_QUESTION_THINGS) && has(STOP_QUESTION_CUES)) || hasPhrase(text, STOP_QUESTION_PHRASES);

  if (has(HELP_WORDS) || hasPhrase(text, HELP_PHRASES)) return 'ayuda';
  if (has(SALDO_WORDS)) return 'saldo';
  if (has(TRIP_WORDS) && hasPhrase(text, TRIP_PHRASES)) return 'viaje';
  // A stop question outranks a *fuzzy* route reading. "¿Cuáles rutas hay en la
  // Calle 100?" produces a one-edit match on route B100 (from the número 100),
  // which is enough to hijack a question that never named a route at all — while
  // an exact código ("¿qué tan cerca está el F19?") is unambiguous and wins.
  if (isStopQuestion && routeConfidence < 0.85) return 'paradas';
  if (routeConfidence > 0) return has(SCHEDULE_WORDS) ? 'horario' : 'eta';
  if (isStopQuestion) return 'paradas';
  return 'eta';
}

/**
 * Read one utterance as a request: what kind of question, about which route,
 * anchored where.
 *
 * Everything beyond the código is a *hint*: the engines use a hint only when it
 * matches real data, so a mis-parse degrades to the plain "nearest to you" answer
 * rather than to a wrong one.
 */
export function parseVoiceRequest(utterance: string | string[], index: VoiceIndex): VoiceRequest {
  const readings = (Array.isArray(utterance) ? utterance : [utterance]).map((value) => String(value ?? '')).filter(Boolean);
  // ONE sweep of the index, then split by threshold. Matching twice (once for the
  // answers, once for the shortlist) doubled the hot path for nothing — the
  // edit-distance sweep over 783 códigos is the whole cost of this module
  // (spec §1, sub-100 ms).
  const scored = matchRouteCode(readings, index, 8, SUGGEST_VOICE_CONFIDENCE);
  let matches = scored.filter((match) => match.confidence >= MIN_VOICE_CONFIDENCE).slice(0, 3);
  let suggestions = scored.filter((match) => match.confidence < MIN_VOICE_CONFIDENCE).slice(0, 3);

  // A place named with no código behind it ("el bus en la Calle 100") matches every
  // route whose name contains that place, all with the same score. Answering the
  // first of them alphabetically would be a coin toss presented as a fact
  // (spec §1) — the honest move is to ask which one, so the whole shortlist
  // becomes the question instead.
  const ambiguousPlace =
    matches.length >= 3 && matches.every((match) => match.via === 'nombre' && match.confidence === matches[0].confidence);
  if (ambiguousPlace) {
    suggestions = matches.slice(0, 3);
    matches = [];
  }

  // Hints and intent come from the recognizer's best reading only: the
  // alternatives exist to rescue a código, and mixing clauses from two different
  // transcriptions would build a question nobody asked.
  const text = normalizeUtterance(readings[0] ?? '');
  const tokens = text.split(' ').filter(Boolean);
  const intent = readIntent(text, tokens, matches[0]?.confidence ?? 0);
  // A deictic is not a place name: "por aquí" means "use my position".
  const rawStopHint = phraseAfter(tokens, STOP_MARKERS);
  const stopHint = DEICTIC.has(rawStopHint) ? '' : rawStopHint;
  const dirHint = phraseAfter(tokens, DIR_MARKERS);
  const destinationHint = intent === 'viaje' ? phraseAfter(tokens, TRIP_MARKERS) : '';

  // A trip is a command, not a route lookup: "llévame a Suba" must not also be
  // answered as an ETA for whatever route is named after Suba. A stop question is
  // not one either — its route matches were the accident that made it look like one.
  if (intent === 'viaje' || intent === 'paradas') {
    return { intent, matches: [], suggestions: [], stopHint, dirHint, destinationHint };
  }

  return { intent, matches, suggestions, stopHint, dirHint, destinationHint };
}
