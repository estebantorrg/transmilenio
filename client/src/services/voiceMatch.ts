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
 * `eta` is the headline ("¿qué tan cerca está el F19?"). `horario` is the other
 * half of what people actually say out loud — "¿a qué hora abre?", "¿el F19 pasa
 * los domingos?", "¿hasta qué hora hay servicio?" — and it is answerable from the
 * index alone: no position, no live call, no geometry, so it lands in milliseconds
 * even with no network at all (spec §5.9 budget, §4.2).
 */
export type VoiceIntent = 'eta' | 'horario';

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
}

/** Words that make a question about the timetable rather than about a bus now. */
const SCHEDULE_WORDS = new Set([
  'horario', 'horarios', 'abre', 'abren', 'cierra', 'cierran', 'opera', 'operan',
  'funciona', 'funcionan', 'presta', 'servicio', 'domingo', 'domingos', 'sabado',
  'sabados', 'festivo', 'festivos', 'feriado', 'madrugada', 'ultimo', 'ultima',
  'primero', 'primer', 'primera', 'trabaja', 'trabajan', 'disponible', 'temprano',
]);

/**
 * Tokens that introduce a place. `en`/`por`/`desde` are the ones riders use for
 * the stop they are standing at; `hacia`/`sentido`/`rumbo` name a direction. Both
 * are read from the RAW tokens (before stopword filtering), since the markers are
 * themselves stopwords for name matching.
 */
const STOP_MARKERS = new Set(['en', 'por', 'desde', 'estacion', 'parada', 'paradero', 'portal']);
const DIR_MARKERS = new Set(['hacia', 'sentido', 'rumbo', 'direccion']);

/** Words that end a place phrase — the next clause has started. */
const PHRASE_END = new Set([...DIR_MARKERS, 'que', 'cuanto', 'cuando', 'y', 'o', 'pero', 'ruta', 'bus']);

function phraseAfter(tokens: string[], markers: Set<string>, keepMarker = false): string {
  for (let i = 0; i < tokens.length; i++) {
    if (!markers.has(tokens[i])) continue;
    const words: string[] = keepMarker ? [tokens[i]] : [];
    for (let j = i + 1; j < tokens.length && words.length < 6; j++) {
      const token = tokens[j];
      if (PHRASE_END.has(token) || STOP_MARKERS.has(token)) break;
      if (/^\d+$/.test(token)) {
        // A número right after the marker is part of a código the rider is
        // spelling ("por la 19"), not a place name — unless a place word came
        // first ("calle 100", "avenida 68"), where it is the whole point.
        if (words.length === 0) break;
        words.push(token);
        continue;
      }
      words.push(token);
    }
    const phrase = words.filter((word) => !STOPWORDS.has(word) || /^\d+$/.test(word)).join(' ');
    if (phrase) return phrase;
  }
  return '';
}

/**
 * Read one utterance as a request: what kind of question, about which route,
 * anchored where.
 *
 * Everything beyond the código is a *hint*: the ETA engine uses a hint only when
 * it matches real data on the matched route, so a mis-parse degrades to the plain
 * "nearest stop to you" answer rather than to a wrong one.
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
  const tokens = normalizeUtterance(readings[0] ?? '').split(' ').filter(Boolean);
  const intent: VoiceIntent = tokens.some((token) => SCHEDULE_WORDS.has(token)) ? 'horario' : 'eta';
  // "portal" keeps its marker: it is part of the name ("en Portal Suba"), unlike
  // "en"/"por", which are not.
  const stopHint = phraseAfter(tokens, STOP_MARKERS, true);
  const dirHint = phraseAfter(tokens, DIR_MARKERS);

  return { intent, matches, suggestions, stopHint, dirHint };
}
