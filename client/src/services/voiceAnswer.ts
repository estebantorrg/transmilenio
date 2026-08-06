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
import type { RouteEtaAnswer, RouteEtaDirection, RouteServiceDay, RouteServiceState } from './routeEta';
import type { StopRoutes } from './voiceStops';

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

/** `null` when the walk is unknown — the rider named the stop instead of standing
 *  at it, and inventing a walk would be inventing the actionable half. */
function walkPhrase(dir: RouteEtaDirection): string | null {
  return dir.walkMinutes === null ? null : `estás a ${speakMinutes(dir.walkMinutes)} caminando`;
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
  // asking the rider which direction they meant. Not when the rider already said
  // which way they are going — that answer leads with their direction.
  if (primary && secondary && primary.stopName === secondary.stopName && !primary.asked) {
    const walk = walkPhrase(primary);
    return (
      `${capitalize(subject(answer.code, p))} pasa por ${p.place(primary.stopName)}: ` +
      `hacia ${p.place(primary.destination)} en ${speakMinutes(primary.etaMinutes ?? 0)}, ` +
      `hacia ${p.place(secondary.destination)} en ${speakMinutes(secondary.etaMinutes ?? 0)}.` +
      (walk ? ` ${capitalize(walk)}.` : '')
    );
  }

  if (!primary) {
    const stop = answer.directions[0];
    const where = stop ? ` acercándose a ${p.place(stop.stopName)}` : '';
    return `No veo buses ${subjectDe(answer.code, p)}${where} en este momento.`;
  }

  const walk = walkPhrase(primary);
  const sentences: string[] = [];
  if (primary.verdict === 'no-alcanzas' && walk) {
    sentences.push(`${arrivalPhrase(answer.code, primary, p)}, pero ${walk}.`);
    // Only ever stated from vehicles actually projected onto the trace.
    if (primary.busCount > 1) sentences.push(`Hay ${primary.busCount} buses en camino.`);
  } else if (primary.verdict === 'sal-ya' && walk) {
    sentences.push(`${arrivalPhrase(answer.code, primary, p)} y ${walk}. Sal ya.`);
  } else if (walk) {
    sentences.push(`${arrivalPhrase(answer.code, primary, p)}. ${capitalize(walk)}.`);
  } else {
    // Named stop, no fix: the arrival is the whole answer, plus the second bus
    // when there genuinely is one (it is what decides whether to wait).
    sentences.push(`${arrivalPhrase(answer.code, primary, p)}.`);
    if (primary.busCount > 1) sentences.push(`Hay ${primary.busCount} buses en camino.`);
  }

  if (secondary) {
    sentences.push(
      `Hacia ${p.place(secondary.destination)} en ${speakMinutes(secondary.etaMinutes ?? 0)} ` +
        `por ${p.place(secondary.stopName)}.`
    );
  }
  return sentences.join(' ');
}

/** The screen's supporting line for one direction: stop, then the walk if known. */
function stopDetail(dir: RouteEtaDirection | undefined, fallback: string): string {
  if (!dir) return fallback;
  return dir.walkMinutes === null ? dir.stopName : `${dir.stopName} · ${dir.walkMinutes} min caminando`;
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

    case 'sin-ubicacion':
      // The schedule half is real and offline; the missing piece is named so the
      // rider knows what would fix it (spec §4.2).
      return composeWithoutLocation(answer.code, answer.service);

    case 'sin-buses':
      return {
        ...both((p) => runningSentence(answer, p)),
        headline: `${answer.code} · sin buses`,
        detail: stopDetail(primary, answer.service.detail),
      };

    case 'ok':
    default: {
      const eta = primary?.etaMinutes ?? null;
      return {
        ...both((p) => runningSentence(answer, p)),
        headline: eta === 0 ? `${answer.code} · llegando` : `${answer.code} · ${eta} min`,
        detail: stopDetail(primary, ''),
      };
    }
  }
}

/** "el F19, el B12 y la ruta 6" — each código keeps its own article. */
function routeList(codes: string[], p: Phrasing, max: number): string {
  const named = codes.slice(0, max).map((code) => subject(code, p));
  if (named.length === 0) return '';
  if (named.length === 1) return named[0];
  return `${named.slice(0, -1).join(', ')} y ${named[named.length - 1]}`;
}

/** How many códigos a spoken list can carry before it stops being an answer. */
const SPOKEN_ROUTE_LIST_MAX = 4;

/**
 * "¿Qué buses pasan por aquí?" — the stop answer (spec §5.9 `paradas`).
 *
 * Two rules shape it. It says **which routes are running now**, not which are
 * filed: a station with 28 routes and 3 running at 11 p.m. reported as 28 options
 * is how a rider waits for a bus that stopped hours ago (§1). And it names the
 * stop it is talking about, with the distance when the rider is not standing at
 * it — a coarse fix can be a block off, and "aquí" has to be checkable.
 */
export function composeStopRoutes(stop: StopRoutes): VoiceAnswer {
  const build = (p: Phrasing): string => {
    const place = p.place(stop.name);
    const where =
      stop.here
        ? `Estás en ${place}`
        : stop.named || stop.meters === null
          ? `En ${place}`
          : `Tu parada más cercana es ${place}, a ${p.distance(stop.meters)}`;

    if (stop.routes.length === 0) return `${where}. No tengo rutas registradas ahí.`;
    if (stop.running.length === 0) {
      const count = stop.routes.length === 1 ? 'una ruta' : `${stop.routes.length} rutas`;
      return `${where}. Por ahí pasan ${count}, pero ninguna está operando a esta hora.`;
    }
    const named = routeList(stop.highlights, p, SPOKEN_ROUTE_LIST_MAX);
    // "…el B12, el K86 y la 6 y 21 rutas más" reads as one list with two
    // conjunctions. A count up front and "entre ellas" behind it says the same
    // thing in one breath, and puts the useful number first.
    if (stop.running.length > stop.highlights.length) {
      return `${where}. Ahora pasan ${stop.running.length} rutas, entre ellas ${named}.`;
    }
    return `${where}. Ahora pasan ${named}.`;
  };

  const distance = stop.meters === null ? '' : `a ${formatDistance(stop.meters)}`;
  const walk = stop.walkMinutes === null ? '' : ` · ${stop.walkMinutes} min caminando`;
  return {
    ...both(build),
    headline: `${stop.name} · ${stop.running.length} en servicio`,
    detail: distance ? `${distance}${walk}` : `${stop.routes.length} rutas registradas`,
  };
}

/** No position and no stop named, for a question that is entirely about place. */
export function composeStopUnknown(heard: string): VoiceAnswer {
  const sentence =
    'No sé en qué parada estás. Dime su nombre, o activa la ubicación y te digo qué pasa por ahí.';
  return {
    spoken: sentence,
    written: sentence,
    headline: 'No sé dónde estás',
    detail: heard.trim() ? `Escuché "${heard.trim()}"` : 'Sin ubicación y sin parada',
  };
}

/** The rider named a place we have no stop for. Named back, so they can hear what
 *  we heard rather than guess at it. */
export function composeStopNotFound(hint: string): VoiceAnswer {
  const sentence = hint.trim()
    ? `No encontré una parada que se llame ${hint.trim()}. ¿La puedes decir de otra forma?`
    : 'No encontré esa parada. ¿La puedes decir de otra forma?';
  return { spoken: sentence, written: sentence, headline: 'Parada no encontrada', detail: hint.trim() ? `Escuché "${hint.trim()}"` : '' };
}

/**
 * The card balance (spec §5.5.1a), read from a remembered card with no tap.
 *
 * Spoken and written differ on the amount, for the usual reason: "$ 5.400" is what
 * a rider must *see*, and es-CO TTS makes nothing sensible of it, so the speaker is
 * told "5.400 pesos". Only the last four digits are ever said or shown — the number
 * is the rider's, and reading it out loud on a bus is not a thing this app does
 * (spec §3.3).
 */
export function composeCardBalance(tail: string, balance: string, asOf?: string): VoiceAnswer {
  const amount = balance.replace(/^\$\s*/, '').trim();
  const card = tail ? ` terminada en ${tail}` : '';
  const when = asOf ? ` Consultado ${asOf}.` : '';
  return {
    spoken: `Tu tarjeta${card} tiene ${amount} pesos.`,
    written: `Tu tarjeta${card} tiene $ ${amount}.${when}`,
    headline: `$ ${amount}`,
    detail: tail ? `tullave •••• ${tail}` : 'Saldo del servidor',
  };
}

export function composeCardMissing(): VoiceAnswer {
  const sentence =
    'No tengo una tarjeta guardada. Ábrela en Saldo una vez y después te digo el saldo cuando preguntes.';
  return { spoken: sentence, written: sentence, headline: 'Sin tarjeta guardada', detail: 'Guárdala en Saldo' };
}

export function composeCardUnavailable(): VoiceAnswer {
  const sentence = 'No pude consultar tu saldo en este momento. Intenta de nuevo en un minuto.';
  return { spoken: sentence, written: sentence, headline: 'Saldo no disponible', detail: 'No se pudo consultar el servidor' };
}

/**
 * "¿Cómo llego a X?" — the trip is handed to the planner, seeded from what the
 * rider just said.
 *
 * Deliberately not a spoken itinerary: the router needs the full catalog and its
 * answer is four itineraries with legs and transfers, which is a screen, not a
 * sentence. What voice removes is the part that made the planner a chore — typing
 * two endpoints you already said out loud.
 */
export function composeTripHandoff(destination: string, hasOrigin: boolean): VoiceAnswer {
  const place = speakPlace(destination);
  const spoken = hasOrigin
    ? `Busco cómo llegar a ${place} desde donde estás.`
    : `Abrí el planeador con destino ${place}. Dime desde dónde sales.`;
  const written = hasOrigin
    ? `Buscando cómo llegar a ${destination} desde tu ubicación.`
    : `Planeador abierto con destino ${destination}. Falta el punto de partida.`;
  return {
    spoken,
    written,
    headline: hasOrigin ? 'Planeando tu viaje' : 'Falta el origen',
    detail: destination,
  };
}

export function composeTripUnknown(hint: string): VoiceAnswer {
  const sentence = hint.trim()
    ? `No encontré ${hint.trim()} en Bogotá. ¿Lo puedes decir de otra forma?`
    : '¿A dónde quieres ir?';
  return { spoken: sentence, written: sentence, headline: 'Destino no encontrado', detail: hint.trim() ? `Escuché "${hint.trim()}"` : '' };
}

/**
 * Example questions, in the order they are worth learning.
 *
 * A voice surface has no menu, so the only way a rider finds out it does more than
 * one thing is being told — which is why these are shown both on "¿qué puedes
 * hacer?" and on every reading that resolved to nothing. A feature nobody can
 * discover is not a feature anybody uses daily.
 */
export const VOICE_EXAMPLES = [
  '¿Qué tan cerca está el F19?',
  '¿Qué buses pasan por aquí?',
  '¿A qué hora abre el K86?',
  '¿Cómo llego a la Calle 100?',
  '¿Cuánto saldo tengo?',
];

export function composeHelp(): VoiceAnswer {
  const sentence =
    'Puedes preguntarme qué tan cerca viene una ruta, qué buses pasan por tu parada, ' +
    'a qué hora abre o cierra, cómo llegar a un lugar, o cuánto saldo te queda.';
  return {
    spoken: sentence,
    written: sentence,
    headline: 'Esto te puedo responder',
    detail: 'Toca un ejemplo o pregunta con tus palabras',
  };
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

/**
 * What to say when the reading was too weak to answer but strong enough to ask
 * about.
 *
 * The alternative is "no te entendí" and a rider guessing what the app can hear.
 * Naming the candidates keeps the certainty rule intact — nothing is *answered*
 * below `MIN_VOICE_CONFIDENCE` (spec §1) — while turning the dead end into one tap
 * or one word. The códigos are spoken as letter names and written as códigos, same
 * rule as every other sentence here.
 */
export function composeSuggestions(heard: string, codes: string[]): VoiceAnswer {
  const shortlist = codes.slice(0, 3);
  const build = (p: Phrasing): string => {
    const named = shortlist.map((code) => subject(code, p));
    const list =
      named.length === 1 ? named[0] : `${named.slice(0, -1).join(', ')} o ${named[named.length - 1]}`;
    return `No estoy seguro. ¿Preguntas por ${list}?`;
  };
  return {
    ...both(build),
    headline: '¿Cuál de estas?',
    detail: heard.trim() ? `Escuché "${heard.trim()}"` : '',
  };
}

/** "de 4:30 de la mañana a 10:00 de la noche", or the several turns of a route
 *  that runs in peaks only. */
function windowsPhrase(windows: Array<[number, number]>, p: Phrasing): string {
  const spans = windows.slice(0, 3).map(([start, end]) => `de ${p.clock(start)} a ${p.clock(end)}`);
  if (spans.length === 0) return '';
  if (windows.length > 3) {
    // Naming eight peak windows out loud is not an answer anyone can hold.
    return `de ${p.clock(windows[0][0])} a ${p.clock(windows[windows.length - 1][1])}, en varios turnos`;
  }
  return spans.length === 1 ? spans[0] : `${spans.slice(0, -1).join(', ')} y ${spans[spans.length - 1]}`;
}

/**
 * The timetable answer — "¿a qué hora abre el F19?", "¿pasa los domingos?".
 *
 * Composed off the index alone: no position, no geometry and no live call, so it
 * is the one answer this feature can give with the phone in airplane mode and it
 * lands in milliseconds (spec §5.9). It always states today's window *and* where
 * the current moment sits in it, because "opera de 4:30 a 10" without "ahora está
 * en servicio" leaves the rider doing the arithmetic that they asked us for.
 */
export function composeSchedule(code: string, day: RouteServiceDay): VoiceAnswer {
  const build = (p: Phrasing): string => {
    const who = capitalize(subject(code, p));
    if (day.verdict === 'sin-horario') {
      return `No tengo los horarios ${subjectDe(code, p)}, así que no puedo decirte a qué hora abre.`;
    }
    if (!day.runsToday || day.windows.length === 0) {
      const opens = day.boundaryMinute;
      const head = `${who} no presta servicio hoy.`;
      return opens === null ? head : `${head} Vuelve a operar ${opensPhrase(opens, p)}.`;
    }

    const hours = `${who} opera hoy ${windowsPhrase(day.windows, p)}.`;
    if (day.verdict === 'abierto') {
      const closes = day.boundaryMinute;
      // Saying the closing hour again right after the range reads as a stutter;
      // it only adds something on a route with several windows, where "hasta"
      // names which one the rider is inside.
      return closes === null || closes === day.lastMinute
        ? `${hours} Ahora está en servicio.`
        : `${hours} Ahora está en servicio, hasta las ${p.clock(closes)}.`;
    }
    const opens = day.boundaryMinute;
    if (day.verdict === 'fuera-de-servicio') {
      return opens === null ? `${hours} Todavía no está en servicio.` : `${hours} Abre ${opensPhrase(opens, p)}.`;
    }
    // Closed for the day, but it did run today: that is a different sentence from
    // "no opera hoy" and sends the rider to a different plan.
    return opens === null
      ? `${hours} Ya terminó su servicio de hoy.`
      : `${hours} Ya terminó por hoy; abre ${opensPhrase(opens, p)}.`;
  };

  const range =
    day.firstMinute !== null && day.lastMinute !== null
      ? `${formatClockMinute(day.firstMinute)} – ${formatClockMinute(day.lastMinute)}`
      : day.detail || 'Sin horario publicado';
  return {
    ...both(build),
    headline: `${code} · horario`,
    detail: day.runsToday ? range : 'No opera hoy',
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
    // The second sentence is the way out, not an apology: naming the stop is a
    // real path to a real ETA (`routeEta` anchors on it), and a rider has no way
    // to discover that unless the app says so at the moment it matters.
    return (
      `${schedule} No sé dónde estás, así que no puedo decirte qué tan cerca viene. ` +
      'Dime en qué parada estás y te lo calculo.'
    );
  };
  return {
    ...both(build),
    headline: `${code} · sin ubicación`,
    detail: service.detail || 'Dime la parada, o activa la ubicación',
  };
}
