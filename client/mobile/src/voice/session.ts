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
import { checkRouteService, computeRouteEta } from '@shared/services/routeEta';
import { matchRouteCode } from '@shared/services/voiceMatch';
import {
  composeListenFailure,
  composeLiveUnavailable,
  composeRouteAnswer,
  composeUnknownRoute,
  composeWithoutLocation,
  type ListenFailure,
  type VoiceAnswer,
} from '@shared/services/voiceAnswer';
import type { VoiceIndex, VoiceIndexRoute, VoiceRouteGeo } from '@shared/types/voice';
import { fastFix, listenOnce, speak, type ListenOutcome, type SpeakOutcome } from './bridge';
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
}

/** Outcomes where the microphone, not the rider, is what failed. */
const MIC_FAILURES = new Set<ListenOutcome>(['sin-permiso', 'sin-reconocedor', 'sin-red', 'sin-idioma']);

function routeType(route: VoiceIndexRoute): 'troncal' | 'zonal' {
  return route.tipo === 'z' ? 'zonal' : 'troncal';
}

/** Destination-first live names, baked into the index at bundle time. */
function liveNames(route: VoiceIndexRoute): string[] {
  return Object.values(route.dirs || {}).flatMap((dir) => dir.live || []);
}

/**
 * What the rider said, as a código.
 *
 * A first attempt that heard **silence** is given exactly one more, and only
 * when there is no habit to fall back on. The hot mic opens during boot, behind
 * a splash screen the rider is still reading — refusing the question there
 * ("no te escuché") before they have had a chance to speak into a screen that
 * says the app is listening is the single worst thing this flow can do.
 */
async function resolveSpokenCode(
  index: VoiceIndex,
  report: (progress: VoiceProgress) => void
): Promise<{ code: string | null; heard: string; predicted: boolean; outcome: ListenOutcome }> {
  report({ stage: 'escuchando' });
  let result = await listenOnce();
  let matches = result.text ? matchRouteCode(result.text, index) : [];

  if (!matches.length && result.outcome === 'silencio' && predictRoute() === null) {
    report({ stage: 'escuchando', listen: 'silencio' });
    result = await listenOnce();
    matches = result.text ? matchRouteCode(result.text, index) : [];
  }

  const spoken = matches[0]?.code ?? null;
  if (spoken) return { code: spoken, heard: result.text, predicted: false, outcome: result.outcome };

  // Said nothing (or nothing we could place): fall back to the route this rider
  // asks about at this hour. Silence is the common case — the whole point of the
  // hot mic is that "abre TransMi Go" alone can be enough.
  const predicted = predictRoute();
  return { code: predicted, heard: result.text, predicted: predicted !== null, outcome: result.outcome };
}

export async function runVoiceSession(options: VoiceSessionOptions = {}): Promise<VoiceSessionResult> {
  const report = options.onProgress ?? (() => undefined);
  const finish = async (
    answer: VoiceAnswer,
    code: string | null,
    heard: string,
    listen: ListenOutcome
  ): Promise<VoiceSessionResult> => {
    // The screen gets the answer first. Speaking it takes seconds, and the rider
    // must be able to read it for the whole of them (spec §4.2, §1.1 R5).
    report({ stage: 'listo', code: code ?? undefined, heard, answer, listen });
    const silent = options.speakAnswer === false || options.signal?.aborted === true;
    const spoke = silent ? 'omitido' : await speak(answer.spoken);
    return { ...answer, code, heard, listen, spoke };
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

  // ── Which route? ────────────────────────────────────────
  const given = options.code?.trim().toUpperCase() || null;
  let code = given;
  let heard = '';
  let predicted = false;
  let listen: ListenOutcome = given ? 'ok' : 'silencio';

  if (!code) {
    const resolved = await resolveSpokenCode(index, report);
    code = resolved.code;
    heard = resolved.heard;
    predicted = resolved.predicted;
    listen = resolved.outcome;
  }

  if (!code || !index.routes[code]) {
    // Three different failures, three different sentences. A mic that never
    // opened is not the rider mumbling, and a código a shortcut supplied that we
    // do not know is not something the rider said at all — answering either with
    // "no te escuché" blames them for it (spec §4.2).
    if (MIC_FAILURES.has(listen)) {
      return finish(composeListenFailure(listen as ListenFailure), null, heard, listen);
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

  const fix = await fixPromise;
  if (!fix) return finish(composeWithoutLocation(code, service), code, heard, listen);

  const userPos: [number, number] = [fix.lng, fix.lat];
  const geo = await geoPromise;

  if (!livePromise) {
    const answer = computeRouteEta({ code, index: route, geo, buses: [], userPos, now });
    return finish(composeRouteAnswer(answer), code, heard, listen);
  }

  // ── Where are its buses? ────────────────────────────────
  const live = await livePromise;
  if (live.status === 'unreachable') {
    return finish(composeLiveUnavailable(code), code, heard, listen);
  }

  const answer = computeRouteEta({ code, index: route, geo, buses: live.data, userPos, now });
  return finish(composeRouteAnswer(answer), code, heard, listen);
}
