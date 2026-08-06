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
import { parseVoiceRequest, type VoiceIntent, type VoiceMatch } from '@shared/services/voiceMatch';
import {
  composeListenFailure,
  composeLiveUnavailable,
  composeRouteAnswer,
  composeSchedule,
  composeSuggestions,
  composeUnknownRoute,
  type ListenFailure,
  type VoiceAnswer,
} from '@shared/services/voiceAnswer';
import type { VoiceIndex, VoiceIndexRoute, VoiceRouteGeo } from '@shared/types/voice';
import { fastFix, listenOnce, RETRYABLE_LISTEN, speak, type ListenOutcome, type SpeakOutcome } from './bridge';
import { predictRoute, rememberAsked } from './predict';
import { loadRouteGeo, loadVoiceIndex } from './shards';

export type VoiceStage = 'escuchando' | 'buscando' | 'listo';

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
  /** Códigos worth offering as a tap when the reading was too weak to answer. */
  suggestions?: string[];
}

export interface VoiceSessionOptions {
  /** A código the caller already knows (launcher shortcut, tap from a list). */
  code?: string | null;
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
    suggestions: string[] = []
  ): Promise<VoiceSessionResult> => {
    // The screen gets the answer first. Speaking it takes seconds, and the rider
    // must be able to read it for the whole of them (spec §4.2, §1.1 R5).
    report({ stage: 'listo', code: code ?? undefined, heard, answer, listen, suggestions });
    const silent = options.speakAnswer === false || aborted();
    const spoke = silent ? 'omitido' : await speak(answer.spoken);
    return { ...answer, code, heard, listen, spoke, suggestions, aborted: aborted() };
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
  let stopHint = '';
  let dirHint = '';
  let suggestions: VoiceMatch[] = [];

  if (!code) {
    const resolved = await resolveSpokenCode(index, report);
    code = resolved.code;
    heard = resolved.heard;
    predicted = resolved.predicted;
    listen = resolved.outcome;
    intent = resolved.intent;
    stopHint = resolved.stopHint;
    dirHint = resolved.dirHint;
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
    return finish(composeListenFailure(listen as ListenFailure), null, heard, listen, habit);
  }

  if (!code || !index.routes[code]) {
    // Three more failures, three more sentences. A reading we half-recognised is a
    // question, not a refusal; and a código a shortcut supplied that we do not know
    // is not something the rider said at all — answering either with "no te
    // escuché" blames them for it (spec §4.2).
    const shortlist = suggestions.map((match) => match.code).filter((value) => Boolean(index.routes[value]));
    if (shortlist.length > 0) {
      return finish(composeSuggestions(heard, shortlist), null, heard, listen, shortlist);
    }
    return finish(composeUnknownRoute(given && !index.routes[given] ? given : heard), null, heard, listen);
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
  const anchor = { stopHint, dirHint };

  if (!livePromise) {
    const answer = computeRouteEta({ code, index: route, geo, buses: [], userPos, now, ...anchor });
    return finish(composeRouteAnswer(answer), code, heard, listen);
  }

  // ── Where are its buses? ────────────────────────────────
  const live = await livePromise;
  if (live.status === 'unreachable') {
    return finish(composeLiveUnavailable(code), code, heard, listen);
  }

  const answer = computeRouteEta({ code, index: route, geo, buses: live.data, userPos, now, ...anchor });
  return finish(composeRouteAnswer(answer), code, heard, listen);
}
