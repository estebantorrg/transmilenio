/**
 * The voice overlay (spec §5.9) — what the rider sees while the app is listening
 * and answering.
 *
 * The screen is not decoration: it carries the same sentence that is spoken, so a
 * device with no Spanish TTS voice, a rider in a loud bus, or anyone who simply
 * cannot hear it still gets the answer (spec §4.2, §1.1 R5). The live transcript
 * echo is there for the same reason — seeing "efe 90" when you said "F19" is how
 * a misheard route becomes obvious before the answer is believed.
 *
 * **The status line tracks the microphone, not the intention.** It says
 * "Escuchando…" only once the recognizer reports the mic is actually open
 * (`onVoiceState`). Claiming to listen while the service is still binding is how
 * a rider ends up talking into a closed microphone and being told nothing was
 * heard.
 *
 * Built on `openSheet`, so the modal behaviour (role=dialog, aria-modal, Tab
 * trap, Escape, focus restore, inert shell) is the app's one implementation
 * rather than a second one (spec §1.1 R2/R5).
 */

import { h, on } from '../lib/dom';
import { openSheet, type SheetHandle } from '../ui/sheet';
import { bus, state } from '../state';
import { app } from '../appContext';
import { cancelListening, installVoiceData, onVoicePartial, onVoiceState, stopSpeaking } from '../voice/bridge';
import { MIC_FAILURES, runVoiceSession, type VoiceAction, type VoiceProgress } from '../voice/session';
import { VOICE_EXAMPLES } from '@shared/services/voiceAnswer';

let openHandle: SheetHandle | null = null;

/**
 * Serialises microphone teardown against the next question.
 *
 * `cancelListening()` and `listen()` cross the Capacitor bridge on a thread pool,
 * so firing them back to back — closing the overlay and immediately re-opening it,
 * which is what a re-fired shortcut does — raced: the cancel could land on the
 * *new* listen and reject it as CANCELLED, leaving a dead mic under a screen that
 * said "Escuchando…". Asks queue behind whatever release is outstanding; when
 * there is none, that is a single microtask.
 *
 * Nothing here cancels on the way IN. A voice launch arrives with a transcript
 * already buffered by the plugin (spec §5.9) and `cancelListening` clears it — a
 * pre-emptive release would throw away the entire point of the hot mic. Asking
 * again needs no cancel either: `listen()` supersedes the previous call inside the
 * plugin, under a fresh recognition generation.
 */
let micIdle: Promise<void> = Promise.resolve();

/** Queue a release (the overlay is closing) and return the queue. */
function releaseMic(): Promise<void> {
  micIdle = micIdle.then(() => cancelListening()).catch(() => undefined);
  return micIdle;
}

export function isVoiceOpen(): boolean {
  return openHandle !== null;
}

export function closeVoice(): boolean {
  if (!openHandle) return false;
  openHandle.close();
  return true;
}

/**
 * Open the overlay and run one question.
 *
 * `code` short-circuits recognition (a launcher shortcut names its route); with
 * no código the mic opens, and silence falls through to the rider's usual route
 * rather than to a dead end.
 */
export function openVoice(code: string | null = null): void {
  // Re-firing the shortcut while a question is in flight restarts it rather than
  // stacking two overlays fighting over one microphone. Closing runs the sheet's
  // own teardown (which releases the mic), so the new question queues behind it.
  if (openHandle) {
    openHandle.close(true);
    openHandle = null;
  }

  const status = h('div', { class: 'voz-status', text: code ? 'Buscando…' : 'Abriendo el micrófono…' });
  const heard = h('div', { class: 'voz-heard', text: '' });
  const headline = h('div', { class: 'voz-headline', text: '' });
  const detail = h('div', { class: 'voz-detail', text: '' });
  // The WRITTEN sentence, never the spoken one: on screen the rider must read
  // "F19", not the "efe 19" the speech synthesiser needs to be told.
  const sentence = h('div', { class: 'voz-spoken', text: '' });
  const pulse = h('div', { class: 'voz-pulse listening' }, [h('span'), h('span'), h('span')]);

  const again = h('button', { class: 'btn btn-primary', type: 'button', text: 'Preguntar otra vez' });
  // `.hidden` (the app's class), not the `hidden` attribute: `.btn` sets
  // `display:inline-flex`, which outranks the UA's `[hidden] { display:none }`
  // and leaves a dead button on screen.
  const openRoute = h('button', { class: 'btn btn-ghost hidden', type: 'button', text: 'Ver en el mapa' });
  // Only shown when the device turns out to have no Spanish voice. The voices
  // belong to Android and cannot be shipped in the APK, so pointing at the one
  // screen that installs them is the whole fix available.
  const installVoice = h('button', {
    class: 'btn btn-ghost hidden',
    type: 'button',
    text: 'Instalar voz en español',
  });
  // Shown when the microphone itself is the problem (no permission, no
  // recognizer, no Spanish, no network). Naming the failure is half an answer;
  // the rider also needs the way out of it (spec §4.2), and "búscala en la app"
  // is not an instruction anyone should have to follow by hand.
  const searchInstead = h('button', { class: 'btn btn-ghost hidden', type: 'button', text: 'Buscar la ruta en la app' });
  // Route códigos offered as taps: either a reading too weak to answer (nothing is
  // ever *answered* on the strength of one, spec §1) or the routes serving the stop
  // the rider just asked about. Either way one tap is what turns a half-answer into
  // the live ETA they were after.
  const suggestions = h('div', { class: 'voz-chips hidden' });
  // What this thing can be asked. A voice surface has no menu, so the only way a
  // rider learns it does more than one thing is being shown — on "¿qué puedes
  // hacer?" and on anything that resolved to nothing.
  const examples = h('div', { class: 'voz-examples hidden' });
  const actions = h('div', { class: 'voz-actions' }, [again, openRoute, installVoice, searchInstead]);

  // One per question. Closing the overlay (or asking again) abandons the one in
  // flight, so the answer to a question the rider walked away from is never read
  // out to an empty screen.
  let abort = new AbortController();

  /**
   * Which question is on screen. Every callback carries the round it belongs to,
   * because a superseded session settles *after* the new one has started listening,
   * and its "no te entendí" landing on top of the live "Escuchando…" is exactly
   * what "the app won't let me talk" looks like from the rider's side.
   */
  let round = 0;
  /** A question that arrived as text (a tapped example) rather than as speech. */
  let typed: string | null = null;
  /**
   * The stop the last answer was about.
   *
   * Handed back with the next question so the two are one conversation: after "¿qué
   * buses pasan por Banderas?", tapping F19 answers *at Banderas* rather than asking
   * the rider where they are (spec §5.9).
   */
  let anchorStop: string | null = null;

  const sheet = openSheet({
    full: true,
    ariaLabel: 'Pregunta por una ruta',
    onClose: () => {
      openHandle = null;
      round++; // nothing from the question in flight may repaint this panel
      abort.abort();
      void releaseMic();
      void stopSpeaking();
      offPartial();
      offState();
      offRoutes();
    },
  });
  openHandle = sheet;

  // The answer replaces itself as the question progresses, so the region is
  // polite-live: a screen reader announces the result without interrupting the
  // rider mid-sentence.
  const panel = h('div', { class: 'voz' }, [
    pulse,
    status,
    heard,
    headline,
    detail,
    sentence,
    suggestions,
    examples,
    actions,
  ]);
  panel.setAttribute('role', 'status');
  panel.setAttribute('aria-live', 'polite');
  sheet.body.append(panel);

  const offPartial = onVoicePartial((text) => {
    heard.textContent = text;
  });

  /** Only while this question is still the one on screen: the recognizer keeps
   *  emitting for a moment after a cancel, and it must not repaint a closed or
   *  already-answered overlay. */
  let listening = false;
  const offState = onVoiceState((micState) => {
    if (openHandle !== sheet || !listening) return;
    if (micState === 'ready') {
      status.textContent = 'Escuchando…';
      pulse.className = 'voz-pulse listening';
    } else if (micState === 'speaking') {
      status.textContent = 'Te escucho…';
    } else {
      // The mic has closed and the recognizer is deciding. Saying "Escuchando…"
      // here invites the rider to keep talking into nothing.
      status.textContent = 'Un momento…';
      pulse.className = 'voz-pulse working';
    }
  });

  const showAnswer =(answer: { headline: string; detail: string; written: string }): void => {
    headline.textContent = answer.headline;
    detail.textContent = answer.detail;
    sentence.textContent = answer.written;
  };

  /** Offer códigos as taps. Tapping one asks that route outright. */
  const showSuggestions = (codes: string[]): void => {
    suggestions.textContent = '';
    suggestions.classList.toggle('hidden', codes.length === 0);
    for (const suggestion of codes) {
      const chip = h('button', { class: 'voz-chip', type: 'button', text: suggestion });
      on(chip, 'click', () => {
        code = suggestion;
        ask();
      });
      suggestions.append(chip);
    }
  };

  /**
   * The example questions.
   *
   * Not decoration and not a static list: each one is a real utterance, so tapping
   * it runs the same pipeline the microphone feeds. That makes the examples both
   * the documentation and a keyboard-free way to use the feature on a device whose
   * recognizer will not open at all (spec §4.2, §1.1 R5).
   */
  const showExamples = (visible: boolean): void => {
    examples.textContent = '';
    examples.classList.toggle('hidden', !visible);
    if (!visible) return;
    examples.append(h('div', { class: 'voz-examples-head', text: 'Prueba con:' }));
    for (const example of VOICE_EXAMPLES) {
      const item = h('button', { class: 'voz-example', type: 'button', text: example });
      on(item, 'click', () => askText(example));
      examples.append(item);
    }
  };

  /** Run a typed/tapped question through the same pipeline as a spoken one. */
  const askText = (utterance: string): void => {
    typed = utterance;
    code = null;
    ask();
  };

  /**
   * Perform the command intents. The session computes and composes; navigation
   * belongs here, where the sheet, the focus and the tab bar are owned.
   *
   * The navigation happens **behind** the overlay, as soon as the answer lands, and
   * the sheet closes only once the sentence has been read (below). Closing first
   * would stop the speech mid-word — `onClose` owns `stopSpeaking` — and waiting for
   * the speech first left the rider watching a finished answer for the several
   * seconds it takes to say. This way the planner is already computing while the
   * sentence plays, and the rider is looking at it when the words end.
   */
  const runAction = (action: VoiceAction | null): void => {
    if (!action || openHandle !== sheet) return;
    if (action.kind === 'saldo') {
      app().navigate('saldo');
      return;
    }
    app().planTrip({ destination: action.destination, origin: action.origin });
  };

  /**
   * "Ver en el mapa", once the catalog knows the route.
   *
   * A voice launch answers off the 367 KB voice index while `loadCore` is still
   * parsing the 13.6 MB catalog (spec §5.9), so `state.routes` is usually empty
   * at the moment the answer lands — the button was simply never offered on the
   * one path the feature exists for. It is re-evaluated when the catalog arrives.
   */
  let answeredCode: string | null = null;
  const syncOpenRoute = (): void => {
    const match = answeredCode ? state.routes.find((route) => route.code === answeredCode) : undefined;
    openRoute.classList.toggle('hidden', !match);
    if (!match) return;
    openRoute.onclick = () => {
      sheet.close();
      app().showRouteOnMap(match);
    };
  };
  const offRoutes = bus.on('routes:ready', syncOpenRoute);

  const onProgress = (progress: VoiceProgress, forRound: number): void => {
    if (openHandle !== sheet || forRound !== round) return;
    if (progress.stage === 'escuchando') {
      listening = true;
      // A second window after a first one that produced nothing — say which of the
      // two happened, or it reads as the app having ignored the rider entirely.
      // "No te escuché" to someone who just spoke is the wrong accusation.
      status.textContent =
        progress.listen === 'no-entendi'
          ? 'No te entendí. Dime la ruta otra vez…'
          : progress.listen === 'silencio'
            ? 'No te escuché. Dilo otra vez…'
            : 'Abriendo el micrófono…';
      pulse.className = 'voz-pulse listening';
      return;
    }
    if (progress.stage === 'buscando') {
      listening = false;
      pulse.className = 'voz-pulse working';
      status.textContent = progress.predicted
        ? `Buscando ${progress.code}, tu ruta de siempre…`
        : `Buscando ${progress.code}…`;
      if (progress.heard) heard.textContent = progress.heard;
      return;
    }
    listening = false;
    pulse.className = 'voz-pulse done';
    status.textContent = '';
    // The answer lands here rather than on the session promise: reading a
    // sentence aloud takes seconds, and the rider must not be watching a spinner
    // for the whole of them.
    again.disabled = false;
    if (progress.answer) showAnswer(progress.answer);
    if (progress.suggestions) showSuggestions(progress.suggestions);
    if (progress.showExamples !== undefined) showExamples(progress.showExamples);
    if (progress.anchor !== undefined) anchorStop = progress.anchor;
    runAction(progress.action ?? null);
    // Every affordance that does NOT depend on how the speaking went belongs
    // here too, for the same reason the words do: the session promise only
    // settles once TTS has finished (or given up), and a rider whose mic is
    // denied should not have to wait out a sentence being read to them before
    // the way out of that appears. Only `installVoice` waits, because only it
    // needs the speak outcome.
    if (progress.listen) searchInstead.classList.toggle('hidden', !MIC_FAILURES.has(progress.listen));
    answeredCode = progress.code ?? null;
    syncOpenRoute();
  };

  const ask = (): void => {
    const forRound = ++round;
    headline.textContent = '';
    detail.textContent = '';
    sentence.textContent = '';
    heard.textContent = typed || '';
    answeredCode = null;
    openRoute.classList.add('hidden');
    installVoice.classList.add('hidden');
    searchInstead.classList.add('hidden');
    showSuggestions([]);
    showExamples(false);
    again.disabled = true;
    // A código or a typed question needs no microphone at all.
    const silentStart = Boolean(code) || Boolean(typed);
    listening = !silentStart;
    status.textContent = silentStart ? 'Buscando…' : 'Abriendo el micrófono…';
    pulse.className = silentStart ? 'voz-pulse working' : 'voz-pulse listening';

    // The previous question is abandoned before this one starts, and this one
    // starts behind any outstanding mic release (see `micIdle`).
    abort.abort();
    abort = new AbortController();
    const signal = abort.signal;
    const asked = code;
    const askedText = typed;
    // The anchor follows a tap, never a fresh spoken question: someone who opens
    // the mic again may well have walked to another paradero.
    const askedAnchor = asked || askedText ? anchorStop : null;
    typed = null; // consumed: "Preguntar otra vez" always means out loud
    void micIdle.then(() => {
      if (openHandle !== sheet || forRound !== round) return;
      return runVoiceSession({
        code: asked,
        utterance: askedText,
        stopHint: askedAnchor,
        onProgress: (progress) => onProgress(progress, forRound),
        signal,
      }).then((result) => {
        // The rider may have closed the overlay, or asked again, while the live
        // call was in flight; writing into a detached panel would also speak over
        // a screen showing something else.
        if (openHandle !== sheet || forRound !== round) return;
        again.disabled = false;
        showAnswer(result);
        showSuggestions(result.suggestions);
        // The one thing that genuinely had to wait for the speaker: a device with
        // no Spanish voice is only known once a sentence has been handed to it.
        installVoice.classList.toggle('hidden', result.spoke !== 'sin-voz');
        // The sentence has been read and the app is already where the rider asked to
        // go (see `runAction`) — so get out of the way. Nothing is cut off, and
        // nobody has to dismiss a screen whose job is done.
        if (result.action) sheet.close();
      });
    });
  };

  on(installVoice, 'click', () => void installVoiceData());

  on(searchInstead, 'click', () => {
    sheet.close();
    app().navigate('rutas');
  });

  on(again, 'click', () => {
    void stopSpeaking();
    // "Otra vez" always means ask again out loud, even when this overlay was
    // opened with a código from a shortcut or a suggestion chip.
    code = null;
    ask();
  });

  ask();
}
