/**
 * The in-journey guidance banner (spec §5.10).
 *
 * Every cue is spoken, and it is shown too: a device with no installed Spanish
 * TTS voice accepts `speak()` and says nothing (§4.2), an articulado is loud, and
 * a rider who cannot hear still has to be told where to get off (§1.1 R5).
 *
 * It lives here rather than inside the planner because guidance outlives the
 * screen that started it — the rider switches to Mapa to watch the trip, or the
 * app is relaunched mid-journey and resumes with no planner card on screen at
 * all. Mounted once, it reads the guidance snapshot off the app's bus.
 *
 * The banner never intercepts taps (`pointer-events: none`) so it cannot swallow
 * a press meant for the map underneath; only its "Terminar" button takes them,
 * because a journey the rider can start from one screen and not end from any
 * other is a trap.
 */

import { h, on } from '../lib/dom';
import { bus } from '../state';
import { guidanceSnapshot, stopGuidance, type GuidanceProblem, type GuidanceSnapshot } from '../services/guidance';

/** How long the arrival line stays up after the journey ends. */
const ARRIVED_LINGER_MS = 30_000;

/**
 * How long an instruction stays on the banner before it gives way to what the
 * rider is currently doing.
 *
 * A cue is a moment; a ride is twenty minutes. Left up for the whole leg, "Sube
 * al F19 en Portal Suba" is an instruction the rider carried out a quarter of an
 * hour ago, and a screen showing it reads as an app that stopped working. Long
 * enough that nobody misses one they were about to act on.
 */
const CUE_HOLD_MS = 45_000;

/** Each failure is its own sentence: they are not the same problem (§4.2). */
const PROBLEM_TEXT: Record<GuidanceProblem, string> = {
  'sin-gps': 'Este teléfono no puede darme tu ubicación, así que no puedo guiar el viaje.',
  'sin-permiso': 'Necesito el permiso de ubicación para guiarte. Actívalo en los ajustes del teléfono.',
  'sin-trazado': 'No tengo el recorrido de este viaje, así que no puedo guiarte paso a paso.',
  'sin-senal': 'Sin señal de GPS. Sigo intentando; te aviso apenas te ubique.',
};

let host: HTMLElement | null = null;
let line: HTMLElement | null = null;
let progressLine: HTMLElement | null = null;
let endButton: HTMLButtonElement | null = null;
let lingerTimer = 0;
/**
 * Which cue the banner is holding, and since when (see `CUE_HOLD_MS`).
 *
 * `performance.now()`, not the wall clock: a phone that picks up the network's
 * time mid-journey moves `Date.now()` by minutes in either direction, and a jump
 * backwards would pin one instruction on the banner for the rest of the trip.
 */
let heldCueId: string | null = null;
let heldSince = 0;
let holdTimer = 0;
const since = (t: number): number => performance.now() - t;

/** "Faltan 3 paradas" / "A 240 m" — the between-cues line, so the banner is not a
 *  stale sentence for the ten minutes between one instruction and the next. */
function progressText(snapshot: GuidanceSnapshot): string {
  const progress = snapshot.progress;
  if (!snapshot.active || !progress) return '';
  if (progress.stopsRemaining !== undefined && progress.stopsRemaining > 0) {
    return progress.stopsRemaining === 1
      ? 'Te bajas en la próxima'
      : `Faltan ${progress.stopsRemaining} paradas`;
  }
  const metres = Math.round(progress.metresToStepEnd);
  if (metres <= 0) return '';
  return metres < 1000 ? `A ${Math.round(metres / 10) * 10} m` : `A ${(metres / 1000).toFixed(1).replace('.', ',')} km`;
}

function ensureHost(): HTMLElement {
  if (host) return host;
  line = h('div', { class: 'guidance-line' });
  progressLine = h('div', { class: 'guidance-progress' });
  endButton = h('button', { class: 'guidance-end', type: 'button', text: 'Terminar' });
  on(endButton, 'click', () => stopGuidance());
  host = h('div', { class: 'guidance-banner' }, [
    h('div', { class: 'guidance-text' }, [line, progressLine]),
    endButton,
  ]);
  // Polite, not assertive: a cue replaces the previous one every few minutes and
  // a screen reader should read it without cutting off whatever it is saying.
  host.setAttribute('role', 'status');
  host.setAttribute('aria-live', 'polite');
  document.body.append(host);
  return host;
}

function hide(): void {
  window.clearTimeout(lingerTimer);
  window.clearTimeout(holdTimer);
  lingerTimer = 0;
  holdTimer = 0;
  heldCueId = null;
  host?.remove();
  host = null;
  line = null;
  progressLine = null;
  endButton = null;
  document.body.style.removeProperty('--guide-lane');
}

/**
 * Publish the banner's height as `--guide-lane`, so everything else anchored to
 * this corner lifts clear of it.
 *
 * The banner is one line or two depending on what it is saying, so the lane is
 * measured rather than guessed. Without it the "Terminar" button lands exactly on
 * the map's "Mi ubicación" — the same collision `--voz-lane` exists to settle for
 * the mic (§5.10).
 */
function publishLane(): void {
  if (!host) return;
  const lane = Math.round(host.getBoundingClientRect().height) + 10;
  document.body.style.setProperty('--guide-lane', `${lane}px`);
}

function render(snapshot: GuidanceSnapshot): void {
  if (snapshot.cue && snapshot.cue.id !== heldCueId) {
    heldCueId = snapshot.cue.id;
    heldSince = performance.now();
  } else if (!snapshot.cue) {
    heldCueId = null;
  }
  // An ended journey holds its last line for as long as it is up: "Llegaste" is
  // not something to time out into "En el F19 hasta…".
  const cueIsCurrent = snapshot.cue !== null && (!snapshot.active || since(heldSince) < CUE_HOLD_MS);

  const message = snapshot.problem
    ? PROBLEM_TEXT[snapshot.problem]
    : // The WRITTEN form, never the spoken one: on screen the rider must read
      // "F19", not the "efe 19" the speech synthesiser has to be told (§5.9).
      cueIsCurrent
      ? snapshot.cue!.written
      : (snapshot.standing?.written ??
        (snapshot.active ? 'Guiando el viaje. Puedes guardar el teléfono.' : ''));

  if (!message) {
    hide();
    return;
  }

  ensureHost();
  line!.textContent = message;
  const detail = snapshot.problem ? '' : progressText(snapshot);
  progressLine!.textContent = detail;
  progressLine!.classList.toggle('hidden', detail === '');
  // Nothing left to end once the watch has stopped — the banner is then only
  // carrying the last thing that was said.
  endButton!.classList.toggle('hidden', !snapshot.active);

  publishLane();

  window.clearTimeout(lingerTimer);
  lingerTimer = snapshot.active ? 0 : window.setTimeout(hide, ARRIVED_LINGER_MS);

  // Fixes arrive every few seconds, so this is belt-and-braces — but a rider in
  // a tunnel gets none at all, and the cue would otherwise sit there past its
  // welcome until the signal came back.
  window.clearTimeout(holdTimer);
  if (snapshot.active && cueIsCurrent) {
    holdTimer = window.setTimeout(() => render(snapshot), CUE_HOLD_MS - since(heldSince) + 50);
  }
}

/** Mount once, at boot. Idempotent. */
export function mountGuidanceBanner(): void {
  bus.on('guidance', render);
  render(guidanceSnapshot());
}
