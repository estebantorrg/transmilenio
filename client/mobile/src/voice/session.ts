/**
 * One voice question, end to end (spec §5.9).
 *
 * Listen → resolve a código → fetch that route's geometry and the rider's
 * position → ask the live tier → project → speak. The ordering is the design:
 *
 *  - the position fix is started **before** listening finishes, because it does
 *    not depend on which route was named;
 *  - the geometry shard and the live call are started the moment a código
 *    exists, in parallel with the fix — neither depends on where the rider is,
 *    and a serial step in front of the live request is dead time the rider feels
 *    (spec §5.2.2b);
 *  - the schedule is checked **before** the live call, so a closed route is
 *    answered offline in milliseconds instead of after a Colombian round trip;
 *  - nothing here waits on `loadCore` — the 13.6 MB catalog is irrelevant to this
 *    question, and waiting for it would cost more than the whole budget.
 *
 * The answer reaches the screen **before** it is spoken (`onProgress` at
 * `listo`): a sentence takes seconds to read aloud, and the rider should not be
 * watching a spinner for the duration of it.
 *
 * Never throws. Every failure has a sentence (`voiceAnswer.ts`), because a rider
 * holding a phone to their face needs an answer, not an exception (spec §4.2).
 */

import { api, type LiveBusResult } from '@shared/services/api';
import { bogotaNow } from '@shared/services/schedule';
import { checkRouteService, computeRouteEta, describeRouteDay } from '@shared/services/routeEta';
import { describeStopRoutes, findStopByName, nearestStopRecord } from '@shared/services/voiceStops';
import { parseVoiceRequest, type VoiceIntent, type VoiceMatch } from '@shared/services/voiceMatch';
import {
  composeCardBalance,
  composeCardMissing,
  composeCardUnavailable,
  composeHelp,
  composeListenFailure,
  composeLiveUnavailable,
  composeRouteAnswer,
  composeSchedule,
  composeStopNotFound,
  composeStopRoutes,
  composeStopUnknown,
  composeSuggestions,
  composeTripHandoff,
  composeTripUnknown,
  composeUnknownRoute,
  type ListenFailure,
  type VoiceAnswer,
} from '@shared/services/voiceAnswer';
import { isWithinBogota } from '@shared/utils/geo';
import type { VoiceIndex, VoiceIndexRoute, VoiceRouteGeo } from '@shared/types/voice';
import { getCards } from '../lib/storage';
import { fastFix, listenOnce, RETRYABLE_LISTEN, speak, type ListenOutcome, type SpeakOutcome } from './bridge';
import { predictRoute, rememberAsked } from './predict';
import { loadRouteGeo, loadVoiceIndex, loadVoiceStops } from './shards';

export type VoiceStage = 'escuchando' | 'buscando' | 'listo';

/**
 * Something for the app to *do* once the answer is on screen — the intents that
 * are commands rather than questions.
 *
 * The session stays free of navigation: it computes and composes, and the overlay
 * (which owns the sheet, the focus and the tab bar) performs this. A voice module
 * reaching into `AppContext` would make the answer engine depend on the shell it is
 * supposed to be independent of (spec §1.1 R2).
 */
export type VoiceAction =
  | {
      kind: 'planner';
      destination: { name: string; coord: [number, number]; code?: string };
      origin: { name: string; coord: [number, number] } | null;
    }
  | { kind: 'saldo' };

export interface VoiceProgress {
  stage: VoiceStage;
  /** What the recognizer reported, once it has. */
  heard?: string;
  /** The código being answered, once resolved. */
  code?: string;
  /** Whether that código came from the rider's habit rather than their words. */
  predicted?: boolean;
  /** Why the mic produced nothing, when it produced nothing. */
  listen?: ListenOutcome;
  /** The finished answer, handed over at `listo` — before it is read aloud, so
   *  the screen never waits on the speaker. */
  answer?: VoiceAnswer;
  /** Códigos worth offering as a tap: a weak reading, or the routes at a stop. */
  suggestions?: string[];
  /** What the app should do next (planner, saldo), for the command intents. */
  action?: VoiceAction | null;
  /** Whether to show the example questions under the answer. */
  showExamples?: boolean;
  /** The stop this answer was about, so a follow-up tap stays anchored to it. */
  anchor?: string | null;
}

export interface VoiceSessionOptions {
  /** A código the caller already knows (launcher shortcut, tap from a list). */
  code?: string | null;
  /**
   * A question in words, already known — a tapped example, or anything else that
   * arrives as text. It runs the *same* pipeline as speech, which is what makes the
   * examples real documentation rather than a picture of a feature, and what leaves
   * the whole thing usable on a device whose recognizer never opens (spec §4.2).
   */
  utterance?: string | null;
  /**
   * A stop the flow already established, carried into a follow-up.
   *
   * This is what makes the two questions one conversation: "¿qué buses pasan por
   * Banderas?" then a tap on `F19` must answer *at Banderas*, not fall back to
   * "no sé dónde estás" because the rider is planning from their kitchen.
   */
  stopHint?: string | null;
  onProgress?: (progress: VoiceProgress) => void;
  /** Set false to leave the answer on screen without reading it aloud. */
  speakAnswer?: boolean;
  /**
   * Abandon the question. The rider closing the overlay is the case that
   * matters: the live call is still in flight then, and without this the answer
   * to a question they walked away from is read out loud a second later.
   */
  signal?: AbortSignal;
}

export interface VoiceSessionResult extends VoiceAnswer {
  code: string | null;
  heard: string;
  /** Why the mic produced nothing, when it produced nothing. */
  listen: ListenOutcome;
  /** How the reading-aloud went, so the overlay can offer the one fix that
   *  exists when the device has no Spanish voice. */
  spoke: SpeakOutcome;
  /** Códigos the overlay should offer as taps (weak reading, no confident match). */
  suggestions: string[];
  /** What the app should do next, for the command intents. */
  action: VoiceAction | null;
  /** Show the example questions — nothing parsed, or the rider asked what works. */
  showExamples: boolean;
  /**
   * The stop this answer was about.
   *
   * It is what turns two questions into one conversation: the overlay hands it back
   * with the next tap, so "¿qué buses pasan por Banderas?" → tap `F19` answers *at
   * Banderas* instead of asking where the rider is.
   */
  anchor: string | null;
  /** Whether the rider abandoned this question (overlay closed). */
  aborted: boolean;
}

/** Outcomes where the microphone, not the rider, is what failed. Exported because
 *  the overlay offers a way past them, not only a sentence about them. */
export const MIC_FAILURES = new Set<ListenOutcome>(['sin-permiso', 'sin-reconocedor', 'sin-red', 'sin-idioma']);

function routeType(route: VoiceIndexRoute): 'troncal' | 'zonal' {
  return route.tipo === 'z' ? 'zonal' : 'troncal';
}

/** Destination-first live names, baked into the index at bundle time. */
function liveNames(route: VoiceIndexRoute): string[] {
  return Object.values(route.dirs || {}).flatMap((dir) => dir.live || []);
}

interface SpokenRequest {
  code: string | null;
  heard: string;
  predicted: boolean;
  outcome: ListenOutcome;
  intent: VoiceIntent;
  stopHint: string;
  dirHint: string;
  destinationHint: string;
  suggestions: VoiceMatch[];
}

/**
 * What the rider said: a código, the kind of question, and where they anchored it.
 *
 * A first attempt that heard **silence, or something unplaceable**, is given
 * exactly one more. The hot mic opens during boot, behind a splash screen the
 * rider is still reading — refusing the question there ("no te escuché") before
 * they have had a chance to speak into a screen that says the app is listening is
 * the single worst thing this flow can do.
 */
async function resolveSpokenCode(
  index: VoiceIndex,
  report: (progress: VoiceProgress) => void
): Promise<SpokenRequest> {
  report({ stage: 'escuchando' });
  let result = await listenOnce();
  let request = parseVoiceRequest(result.alternatives.length ? result.alternatives : result.text, index);
  let heard = result.text;

  // One more window, for a rider who has not managed to ask yet: silence (the hot
  // mic opened behind the splash they were still reading) or a reading nothing
  // could be made of. Refusing the question before they have spoken into a screen
  // that says the app is listening is the single worst thing this flow can do.
  // A habit to fall back on outranks a second silence, but never a mumble — the
  // rider clearly wants to ask about something.
  const worthRetrying =
    !request.matches.length &&
    RETRYABLE_LISTEN.has(result.outcome) &&
    (result.outcome === 'no-entendi' || predictRoute() === null);
  if (worthRetrying) {
    report({ stage: 'escuchando', listen: result.outcome });
    const second = await listenOnce();
    const retried = parseVoiceRequest(second.alternatives.length ? second.alternatives : second.text, index);
    // Keep the better of the two attempts: a second window that heard nothing
    // must not erase what the first one heard, or a rider who said something
    // unmatched is told they said nothing at all.
    if (retried.matches.length || second.text) {
      request = retried;
      heard = second.text || heard;
      result = second;
    } else if (request.suggestions.length === 0) {
      request = { ...request, suggestions: retried.suggestions };
    }
  }

  const base = {
    heard,
    intent: request.intent,
    stopHint: request.stopHint,
    dirHint: request.dirHint,
    destinationHint: request.destinationHint,
    suggestions: request.suggestions,
  };

  const spoken = request.matches[0]?.code ?? null;
  if (spoken) return { ...base, code: spoken, predicted: false, outcome: result.outcome };

  // A weak reading is offered as a question, never answered (spec §1) — and never
  // overridden by a habit, since the rider plainly asked about something else.
  if (request.suggestions.length > 0) {
    return { ...base, code: null, predicted: false, outcome: result.outcome };
  }

  // Said nothing (or nothing we could place): fall back to the route this rider
  // asks about at this hour. Silence is the common case — the whole point of the
  // hot mic is that "abre TransMi Go" alone can be enough.
  const predicted = predictRoute();
  return { ...base, code: predicted, predicted: predicted !== null, outcome: result.outcome };
}

/** How `runVoiceSession` hands an answer to the screen and the speaker. */
type Finish = (
  answer: VoiceAnswer,
  code: string | null,
  heard: string,
  listen: ListenOutcome,
  extra?: { suggestions?: string[]; action?: VoiceAction | null; showExamples?: boolean; anchor?: string | null }
) => Promise<VoiceSessionResult>;

/**
 * "¿Cuánto saldo tengo?" — read the remembered card (spec §5.5.1a).
 *
 * No NFC tap and no typing: the card number is already on the device from the
 * Saldo tab (§3.3, device-local), and the ledger read works 24/7 regardless of the
 * live service window. With no card saved the answer says so and the overlay opens
 * Saldo, because "no puedo" with no next step is not an answer.
 */
async function answerBalance(): Promise<{ answer: VoiceAnswer; action: VoiceAction | null }> {
  const card = getCards()[0];
  // Only the "no card yet" answer opens the tab. A rider who asked for their
  // balance and got it wanted the number, not to be moved somewhere.
  if (!card) return { answer: composeCardMissing(), action: { kind: 'saldo' } };
  try {
    const response = await api.readCardBalance(card, 'false');
    const balance = response?.success ? response.data?.balance : undefined;
    if (!balance) return { answer: composeCardUnavailable(), action: null };
    return { answer: composeCardBalance(card.slice(-4), balance, response.data?.asOf), action: null };
  } catch {
    return { answer: composeCardUnavailable(), action: null };
  }
}

/**
 * "¿Qué buses pasan por aquí?" — the stop question (spec §5.9 `paradas`).
 *
 * Entirely offline: the stop index plus the route index's horarios. The rider's
 * own words win over the GPS (they may be asking about the stop across the road,
 * or planning from home), and with neither anchor the answer asks for a name
 * instead of shrugging.
 */
async function answerStopQuestion(input: {
  index: VoiceIndex;
  heard: string;
  listen: ListenOutcome;
  stopHint: string;
  fixPromise: Promise<{ lng: number; lat: number } | null>;
  finish: Finish;
}): Promise<VoiceSessionResult> {
  const { index, heard, listen, stopHint, fixPromise, finish } = input;
  let stops;
  try {
    stops = await loadVoiceStops();
  } catch {
    const message = 'No pude leer las paradas guardadas en la app. Intenta de nuevo.';
    return finish(
      { spoken: message, written: message, headline: 'Paradas no disponibles', detail: 'No se pudo leer el índice de paradas' },
      null,
      heard,
      listen
    );
  }

  const fix = await fixPromise;
  const userPos: [number, number] | null = fix ? [fix.lng, fix.lat] : null;

  const named = stopHint ? findStopByName(stops, stopHint) : null;
  if (stopHint && !named) return finish(composeStopNotFound(stopHint), null, heard, listen);

  const record = named ?? (userPos ? nearestStopRecord(stops, userPos) : null);
  if (!record) {
    // No name and no fix (or a fix nowhere near the network) — ask for the name,
    // which is the one thing the rider can supply from where they are standing.
    return finish(composeStopUnknown(heard), null, heard, listen, { showExamples: false });
  }

  const stop = describeStopRoutes(record, index, bogotaNow(), userPos, named !== null);
  // The routes become taps: breadth offline, then the live ETA for the one route
  // the rider actually cares about. Running ones first — a chip for a route that
  // stopped four hours ago is a worse offer than no chip. The stop rides along as
  // the anchor, so the follow-up answers here rather than wherever the phone
  // thinks the rider is.
  const chips = [...stop.running, ...stop.closed].slice(0, 8);
  return finish(composeStopRoutes(stop), null, heard, listen, { suggestions: chips, anchor: stop.name });
}

/**
 * "¿Cómo llego a la Calle 100?" — hand the trip to the planner (spec §5.9 `viaje`).
 *
 * The destination is resolved from the catalog's own stops first (instant, offline,
 * and what a rider naming a station means) and only then geocoded, which is the
 * same order the planner's own endpoint field uses. The planner does the planning:
 * duplicating the router here would be a second implementation of the app's
 * headline feature (spec §1.1 R2).
 */
async function answerTrip(input: {
  heard: string;
  listen: ListenOutcome;
  destinationHint: string;
  fixPromise: Promise<{ lng: number; lat: number } | null>;
  finish: Finish;
}): Promise<VoiceSessionResult> {
  const { heard, listen, destinationHint, fixPromise, finish } = input;
  if (!destinationHint) return finish(composeTripUnknown(''), null, heard, listen, { showExamples: true });

  let destination: { name: string; coord: [number, number]; code?: string } | null = null;
  try {
    const stops = await loadVoiceStops();
    const match = findStopByName(stops, destinationHint);
    if (match) destination = { name: String(match[1]), coord: [Number(match[2]), Number(match[3])], code: String(match[0]) };
  } catch {
    /* the geocoder below still answers */
  }

  if (!destination) {
    try {
      const geo = await api.geocodeAddress(destinationHint);
      const candidate = (Array.isArray(geo?.candidates) ? geo.candidates : []).find(
        (item: any) => Number.isFinite(item?.lat) && Number.isFinite(item?.lon) && isWithinBogota(item.lon, item.lat)
      );
      if (candidate) destination = { name: String(candidate.name), coord: [Number(candidate.lon), Number(candidate.lat)] };
    } catch {
      /* offline, or the geocoder is down — answered below */
    }
  }

  if (!destination) return finish(composeTripUnknown(destinationHint), null, heard, listen);

  const fix = await fixPromise;
  const origin = fix ? { name: 'Mi ubicación', coord: [fix.lng, fix.lat] as [number, number] } : null;
  return finish(composeTripHandoff(destination.name, origin !== null), null, heard, listen, {
    action: { kind: 'planner', destination, origin },
  });
}

export async function runVoiceSession(options: VoiceSessionOptions = {}): Promise<VoiceSessionResult> {
  const aborted = (): boolean => options.signal?.aborted === true;
  // Nothing from an abandoned question may reach the screen or the speaker. The
  // overlay is still mounted when the rider asks again, and a superseded session
  // that kept reporting used to overwrite the live one's "Escuchando…" with its own
  // "no te entendí" — which is what "it doesn't let me talk" looks like from the
  // outside even when the mic is wide open.
  const report = (progress: VoiceProgress): void => {
    if (!aborted()) options.onProgress?.(progress);
  };
  const finish = async (
    answer: VoiceAnswer,
    code: string | null,
    heard: string,
    listen: ListenOutcome,
    extra: { suggestions?: string[]; action?: VoiceAction | null; showExamples?: boolean; anchor?: string | null } = {}
  ): Promise<VoiceSessionResult> => {
    const suggestions = extra.suggestions ?? [];
    const action = extra.action ?? null;
    const showExamples = extra.showExamples ?? false;
    const anchor = extra.anchor ?? null;
    // The screen gets the answer first. Speaking it takes seconds, and the rider
    // must be able to read it for the whole of them (spec §4.2, §1.1 R5).
    report({ stage: 'listo', code: code ?? undefined, heard, answer, listen, suggestions, action, showExamples, anchor });
    const silent = options.speakAnswer === false || aborted();
    const spoke = silent ? 'omitido' : await speak(answer.spoken);
    return { ...answer, code, heard, listen, spoke, suggestions, action, showExamples, anchor, aborted: aborted() };
  };

  // Started first and never awaited here: by the time a código exists, the fix
  // has usually already landed.
  const fixPromise = fastFix();

  let index: VoiceIndex;
  try {
    index = await loadVoiceIndex();
  } catch {
    const message = 'No pude cargar los datos de las rutas. Abre la app e intenta de nuevo.';
    return finish(
      { spoken: message, written: message, headline: 'Datos no disponibles', detail: 'No se pudo leer el índice de rutas' },
      null,
      '',
      'error'
    );
  }

  // ── Which route, and what about it? ─────────────────────
  const given = options.code?.trim().toUpperCase() || null;
  let code = given;
  let heard = '';
  let predicted = false;
  let listen: ListenOutcome = given ? 'ok' : 'silencio';
  let intent: VoiceIntent = 'eta';
  // A stop the caller already established (the previous answer's anchor, handed
  // back with a chip tap) is the starting point, and anything the rider says now
  // overrides it.
  let stopHint = options.stopHint?.trim() || '';
  let dirHint = '';
  let destinationHint = '';
  let suggestions: VoiceMatch[] = [];

  const written = options.utterance?.trim() || '';
  if (!code && written) {
    // Text takes the same road as speech, minus the microphone: same parser, same
    // intents, same composers.
    const request = parseVoiceRequest(written, index);
    code = request.matches[0]?.code ?? null;
    heard = written;
    listen = 'ok';
    intent = request.intent;
    stopHint = request.stopHint || stopHint;
    dirHint = request.dirHint;
    destinationHint = request.destinationHint;
    suggestions = request.suggestions;
  } else if (!code) {
    const resolved = await resolveSpokenCode(index, report);
    code = resolved.code;
    heard = resolved.heard;
    predicted = resolved.predicted;
    listen = resolved.outcome;
    intent = resolved.intent;
    stopHint = resolved.stopHint || stopHint;
    dirHint = resolved.dirHint;
    destinationHint = resolved.destinationHint;
    suggestions = resolved.suggestions;
  }

  // A broken microphone is never masked by a habit. The prediction exists for a
  // rider who said nothing; someone whose mic was denied, missing or offline said
  // nothing *because they could not*, and answering their usual route as if the
  // question had been heard leaves them with no idea why nothing else is
  // askable — the exact defect the four separate sentences exist to prevent.
  // The habit is not thrown away either: it comes back as a tap.
  if (MIC_FAILURES.has(listen)) {
    const habit = predicted && code && index.routes[code] ? [code] : [];
    // The examples matter *most* here: they are tappable, and tapping one runs the
    // same pipeline as speech — so a rider whose microphone will never open still
    // has the whole feature, by hand (spec §4.2, §1.1 R5).
    return finish(composeListenFailure(listen as ListenFailure), null, heard, listen, {
      suggestions: habit,
      showExamples: true,
    });
  }

  // ── The questions that are not about one route ──────────
  // Each of these is answered before any route resolution, because none of them
  // needs a código and three of them cannot have one.
  if (intent === 'ayuda') {
    return finish(composeHelp(), null, heard, listen, { showExamples: true });
  }

  if (intent === 'saldo') {
    report({ stage: 'buscando', heard, listen });
    const balance = await answerBalance();
    return finish(balance.answer, null, heard, listen, { action: balance.action });
  }

  if (intent === 'paradas') {
    report({ stage: 'buscando', heard, listen });
    return answerStopQuestion({ index, heard, listen, stopHint, fixPromise, finish });
  }

  if (intent === 'viaje') {
    report({ stage: 'buscando', heard, listen });
    return answerTrip({ heard, listen, destinationHint, fixPromise, finish });
  }

  if (!code || !index.routes[code]) {
    // Three more failures, three more sentences. A reading we half-recognised is a
    // question, not a refusal; and a código a shortcut supplied that we do not know
    // is not something the rider said at all — answering either with "no te
    // escuché" blames them for it (spec §4.2).
    const shortlist = suggestions.map((match) => match.code).filter((value) => Boolean(index.routes[value]));
    if (shortlist.length > 0) {
      return finish(composeSuggestions(heard, shortlist), null, heard, listen, { suggestions: shortlist });
    }
    // Nothing landed: this is the moment to say what CAN be asked. A rider who
    // hears "no encontré una ruta" twice stops opening the mic at all.
    return finish(composeUnknownRoute(given && !index.routes[given] ? given : heard), null, heard, listen, {
      showExamples: true,
    });
  }

  const route = index.routes[code];
  report({ stage: 'buscando', code, heard, predicted, listen });
  // Only what the rider actually asked for feeds the habit model. Recording a
  // prediction would let it reinforce itself until one lucky guess became the
  // only route this device ever answers (`predict.ts`).
  if (!predicted) rememberAsked(code);

  // ── Is it even running? ─────────────────────────────────
  const now = bogotaNow();

  // A timetable question is answered off the index alone — no shard, no fix, no
  // live call — so it lands in milliseconds and works with no network at all
  // (spec §5.9). Asking for any of that first would be pure dead time.
  if (intent === 'horario') {
    return finish(composeSchedule(code, describeRouteDay(route, now)), code, heard, listen);
  }

  const service = checkRouteService(route, now);
  const closed = service.verdict === 'cerrado-hoy' || service.verdict === 'fuera-de-servicio';

  // Both depend only on the código, so they run while the position fix settles.
  // A closed route needs no live call at all: the answer is its schedule, and
  // skipping the Colombian round trip is the difference between ~2 s and ~20 ms.
  const geoPromise: Promise<VoiceRouteGeo | null> = loadRouteGeo(code);
  const names = liveNames(route);
  const livePromise: Promise<LiveBusResult> | null = closed
    ? null
    : api
        .getLiveBuses(code, names[0] || route.nombre, routeType(route), names)
        .catch(() => ({ status: 'unreachable', confidence: 'low', data: [], source: null }) as LiveBusResult);

  // Awaited together: the fix has been in flight since before the código existed,
  // and the shard is needed to tell whether the stop the rider named is on this
  // route — which is what lets the answer survive having no fix at all.
  const [fix, geo] = await Promise.all([fixPromise, geoPromise]);
  const userPos: [number, number] | null = fix ? [fix.lng, fix.lat] : null;
  const hints = { stopHint, dirHint };

  if (!livePromise) {
    const answer = computeRouteEta({ code, index: route, geo, buses: [], userPos, now, ...hints });
    return finish(composeRouteAnswer(answer), code, heard, listen, {
      anchor: answer.directions[0]?.stopName ?? stopHint ?? null,
    });
  }

  // ── Where are its buses? ────────────────────────────────
  const live = await livePromise;
  if (live.status === 'unreachable') {
    return finish(composeLiveUnavailable(code), code, heard, listen);
  }

  const answer = computeRouteEta({ code, index: route, geo, buses: live.data, userPos, now, ...hints });
  // The stop this answer landed on becomes the anchor for the next tap, so a rider
  // working through the routes at one paradero is answered about the same paradero
  // every time rather than about wherever their last fix was.
  return finish(composeRouteAnswer(answer), code, heard, listen, {
    anchor: answer.directions[0]?.stopName ?? stopHint ?? null,
  });
}
