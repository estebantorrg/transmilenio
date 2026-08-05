/**
 * The sentence a rider hears, and the same sentence they read (spec §5.9).
 *
 * Every answer is composed **twice**, through a {@link Phrasing}: once for the
 * speaker and once for the screen. They are not the same string and must never
 * be substituted for each other — es-CO TTS reads a bare `F` as English, so it
 * has to be told "efe 19", while a rider looking at their phone must see the
 * código they know, `F19`. Same for the clock ("4:30 de la mañana" spoken,
 * "4:30 a.m." written) and for the catalog's dashed place names. Composing once
 * and reusing the result is exactly the bug this shape exists to prevent.
 *
 * Every string here is **plain text**: it goes to TTS as-is and must be put on
 * screen with `textContent` (or `escapeHTML`), never interpolated into markup —
 * route and stop names are upstream data (spec §3.3).
 *
 * Two rules shape the wording:
 *
 * 1. **The walk is part of the answer.** "En 4 minutos" is useless to someone
 *    6 minutes from the stop. Every ETA is said next to the walk that decides
 *    whether it is catchable.
 * 2. **Never promise a bus we cannot see.** "Hay 2 buses en camino" is only said
 *    when a second vehicle is actually inbound (spec §1, certainty). One bus is
 *    reported as one bus.
 */

import { speakClock, speakDistance, speakMinutes, speakPlace, speakRouteCode } from './voiceSpanish';
import { formatClockMinute, MINUTES_PER_DAY } from './schedule';
import { formatDistance } from '../utils/geo';
import type { RouteEtaAnswer, RouteEtaDirection, RouteServiceState } from './routeEta';

export interface VoiceAnswer {
  /** Read aloud verbatim. Letter names, spoken clock, no abbreviations. */
  spoken: string;
  /** The same sentence for the eye: real códigos, "4:30 a.m.", names untouched. */
  written: string;
  /** Short screen line, e.g. "F19 · 4 min". */
  headline: string;
  /** Supporting screen line, e.g. "Suba Calle 100 · 3 min caminando". */
  detail: string;
}

/** The three things that read differently out loud than on screen. */
interface Phrasing {
  code(code: string): string;
  place(name: string): string;
  clock(minute: number): string;
  distance(meters: number): string;
}

const SPOKEN: Phrasing = {
  code: speakRouteCode,
  place: speakPlace,
  clock: speakClock,
  distance: speakDistance,
};

const WRITTEN: Phrasing = {
  code: (code) => code,
  place: (name) => name,
  clock: formatClockMinute,
  distance: formatDistance,
};

/** "el F19" / "la ruta 7" — a bare número reads as a quantity, not a route. */
function subject(code: string, p: Phrasing): string {
  return /^[A-Za-z]/.test(code) ? `el ${p.code(code)}` : `la ruta ${p.code(code)}`;
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/** The "de" contraction Spanish requires: "del F19", but "de la ruta 7". */
function subjectDe(code: string, p: Phrasing): string {
  const text = subject(code, p);
  return text.startsWith('el ') ? `del ${text.slice(3)}` : `de ${text}`;
}

/** A bus at the stop is arriving, not "in 0 minutes". */
function arrivalPhrase(code: string, dir: RouteEtaDirection, p: Phrasing): string {
  const stop = p.place(dir.stopName);
  if (dir.etaMinutes === 0) return `${capitalize(subject(code, p))} está llegando a ${stop}`;
  return `${capitalize(subject(code, p))} llega a ${stop} en ${speakMinutes(dir.etaMinutes ?? 0)}`;
}

function walkPhrase(dir: RouteEtaDirection): string {
  return `estás a ${speakMinutes(dir.walkMinutes)} caminando`;
}

/** "a las 4:30 de la mañana", with the day named when it is not today. */
function opensPhrase(minute: number, p: Phrasing): string {
  const tomorrow = minute >= MINUTES_PER_DAY;
  return `${tomorrow ? 'mañana ' : ''}a las ${p.clock(minute)}`;
}

function closedSentence(code: string, service: RouteServiceState, p: Phrasing): string {
  const who = capitalize(subject(code, p));
  const opens = service.boundaryMinute;
  const head =
    service.verdict === 'fuera-de-servicio'
      ? `${who} todavía no está en servicio.`
      : service.runsToday
        ? `${who} ya terminó su servicio de hoy.`
        : `${who} no presta servicio hoy.`;
  return opens === null ? head : `${head} Abre ${opensPhrase(opens, p)}.`;
}

function runningSentence(answer: RouteEtaAnswer, p: Phrasing): string {
  const withBus = answer.directions.filter((dir) => dir.etaMinutes !== null);
  const primary = withBus[0];
  const secondary = withBus[1];

  // Both sentidos coming through the same stop: one clause each is shorter than
  // asking the rider which direction they meant.
  if (primary && secondary && primary.stopName === secondary.stopName) {
    return (
      `${capitalize(subject(answer.code, p))} pasa por ${p.place(primary.stopName)}: ` +
      `hacia ${p.place(primary.destination)} en ${speakMinutes(primary.etaMinutes ?? 0)}, ` +
      `hacia ${p.place(secondary.destination)} en ${speakMinutes(secondary.etaMinutes ?? 0)}. ` +
      `${capitalize(walkPhrase(primary))}.`
    );
  }

  if (!primary) {
    const stop = answer.directions[0];
    const where = stop ? ` acercándose a ${p.place(stop.stopName)}` : '';
    return `No veo buses ${subjectDe(answer.code, p)}${where} en este momento.`;
  }

  const sentences: string[] = [];
  if (primary.verdict === 'no-alcanzas') {
    sentences.push(`${arrivalPhrase(answer.code, primary, p)}, pero ${walkPhrase(primary)}.`);
    // Only ever stated from vehicles actually projected onto the trace.
    if (primary.busCount > 1) sentences.push(`Hay ${primary.busCount} buses en camino.`);
  } else if (primary.verdict === 'sal-ya') {
    sentences.push(`${arrivalPhrase(answer.code, primary, p)} y ${walkPhrase(primary)}. Sal ya.`);
  } else {
    sentences.push(`${arrivalPhrase(answer.code, primary, p)}. ${capitalize(walkPhrase(primary))}.`);
  }

  if (secondary) {
    sentences.push(
      `Hacia ${p.place(secondary.destination)} en ${speakMinutes(secondary.etaMinutes ?? 0)} ` +
        `por ${p.place(secondary.stopName)}.`
    );
  }
  return sentences.join(' ');
}

function farSentence(answer: RouteEtaAnswer, p: Phrasing): string {
  const near = answer.nearest;
  const where = near ? ` Su parada más cercana, ${p.place(near.name)}, está a ${p.distance(near.meters)}.` : '';
  return `No estás cerca ${subjectDe(answer.code, p)}.${where}`;
}

function noTraceSentence(code: string, p: Phrasing): string {
  return (
    `Conozco ${subject(code, p)}, pero no tengo su recorrido, ` +
    'así que no puedo calcular qué tan cerca está.'
  );
}

/**
 * Some phrases end in their own full stop — the written clock is "4:30 a.m." —
 * and the sentence templates add one too. Collapsing the pair keeps "a.m.." off
 * the screen without every call site having to know which phrasing it is in.
 */
function punctuate(sentence: string): string {
  return sentence.replace(/([.!?])\.(?=\s|$)/g, '$1');
}

/** Run a sentence builder for both the speaker and the screen. */
function both(build: (p: Phrasing) => string): { spoken: string; written: string } {
  return { spoken: punctuate(build(SPOKEN)), written: punctuate(build(WRITTEN)) };
}

/**
 * Compose the answer for one route. Total, by construction: every
 * {@link RouteEtaAnswer} verdict produces a sentence a rider can act on, so the
 * voice flow never has to fall back to a generic failure line (spec §4.2).
 */
export function composeRouteAnswer(answer: RouteEtaAnswer): VoiceAnswer {
  const primary = answer.directions[0];

  switch (answer.verdict) {
    case 'cerrado-hoy':
    case 'fuera-de-servicio':
      return {
        ...both((p) => closedSentence(answer.code, answer.service, p)),
        headline: `${answer.code} · fuera de servicio`,
        detail: answer.service.detail,
      };

    case 'sin-geometria':
      return {
        ...both((p) => noTraceSentence(answer.code, p)),
        headline: `${answer.code} · sin recorrido`,
        detail: answer.service.detail,
      };

    case 'lejos':
      return {
        ...both((p) => farSentence(answer, p)),
        headline: `${answer.code} · lejos de ti`,
        detail: answer.nearest ? `${answer.nearest.name} · a ${formatDistance(answer.nearest.meters)}` : '',
      };

    case 'sin-buses':
      return {
        ...both((p) => runningSentence(answer, p)),
        headline: `${answer.code} · sin buses`,
        detail: primary ? `${primary.stopName} · ${primary.walkMinutes} min caminando` : answer.service.detail,
      };

    case 'ok':
    default: {
      const eta = primary?.etaMinutes ?? null;
      return {
        ...both((p) => runningSentence(answer, p)),
        headline: eta === 0 ? `${answer.code} · llegando` : `${answer.code} · ${eta} min`,
        detail: primary ? `${primary.stopName} · ${primary.walkMinutes} min caminando` : '',
      };
    }
  }
}

/**
 * What to say when the utterance resolved to nothing above
 * `MIN_VOICE_CONFIDENCE`. Named rather than guessed: the rider repeats one word
 * instead of being sent to the wrong route.
 */
export function composeUnknownRoute(heard: string): VoiceAnswer {
  const trimmed = heard.trim();
  const sentence = trimmed
    ? `No encontré una ruta que se llame ${trimmed}. ¿Cuál ruta buscas?`
    : 'No te escuché. ¿Cuál ruta buscas?';
  return {
    spoken: sentence,
    written: sentence,
    headline: 'No entendí la ruta',
    detail: trimmed ? `Escuché "${trimmed}"` : '',
  };
}

/** Why the microphone produced nothing, when the reason was not silence. */
export type ListenFailure = 'sin-permiso' | 'sin-reconocedor' | 'sin-red' | 'sin-idioma';

/**
 * What to say when the mic itself was the problem.
 *
 * "No te escuché" blames the rider for a question they were never able to ask,
 * and leaves them repeating themselves into a microphone that was never open.
 * Each of these names what failed and the one action that fixes it (spec §4.2).
 */
export function composeListenFailure(reason: ListenFailure): VoiceAnswer {
  const lines: Record<ListenFailure, { sentence: string; headline: string; detail: string }> = {
    'sin-permiso': {
      sentence: 'Necesito permiso para usar el micrófono. Actívalo y vuelve a preguntar.',
      headline: 'Sin micrófono',
      detail: 'Permiso de micrófono denegado',
    },
    'sin-reconocedor': {
      sentence: 'Este teléfono no puede reconocer voz. Busca la ruta en la app y te digo lo mismo.',
      headline: 'Sin reconocimiento de voz',
      detail: 'El dispositivo no tiene un servicio de voz',
    },
    'sin-red': {
      sentence: 'No pude reconocer tu voz sin conexión. Revisa los datos e intenta de nuevo.',
      headline: 'Sin conexión',
      detail: 'El reconocimiento de voz necesitó la red',
    },
    'sin-idioma': {
      sentence:
        'Este teléfono no tiene reconocimiento de voz en español. Instálalo desde los ajustes de Google y vuelve a preguntar.',
      headline: 'Sin español',
      detail: 'Falta el paquete de voz en español',
    },
  };
  const line = lines[reason];
  return { spoken: line.sentence, written: line.sentence, headline: line.headline, detail: line.detail };
}

/**
 * What to say when the rider named a real route but the live tier could not be
 * reached at all — distinct from "no hay buses", which is a fact about the
 * street. Conflating the two would report an outage as an empty corridor.
 */
export function composeLiveUnavailable(code: string): VoiceAnswer {
  return {
    ...both((p) => `No pude consultar los buses ${subjectDe(code, p)} en este momento. Intenta de nuevo en un minuto.`),
    headline: `${code} · sin datos en vivo`,
    detail: 'No se pudo consultar el servicio en vivo',
  };
}

/**
 * No position, so no "how close" — but the route's own schedule is known offline
 * and is still worth saying. Answering with the half we have beats a flat "no
 * puedo" (spec §4.2), and it names the missing piece so the rider can fix it.
 */
export function composeWithoutLocation(code: string, service: RouteServiceState): VoiceAnswer {
  const build = (p: Phrasing): string => {
    const who = capitalize(subject(code, p));
    const closes = service.boundaryMinute;
    const schedule =
      service.verdict === 'abierto'
        ? closes === null
          ? `${who} está en servicio.`
          : `${who} está en servicio hasta las ${p.clock(closes)}.`
        : closedSentence(code, service, p);
    return `${schedule} No sé dónde estás, así que no puedo decirte qué tan cerca viene.`;
  };
  return {
    ...both(build),
    headline: `${code} · sin ubicación`,
    detail: service.detail || 'Activa la ubicación para ver qué tan cerca viene',
  };
}
