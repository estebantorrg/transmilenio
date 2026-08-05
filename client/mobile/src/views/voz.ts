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
import { runVoiceSession, type VoiceProgress } from '../voice/session';

let openHandle: SheetHandle | null = null;

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
  // stacking two overlays fighting over one microphone.
  if (openHandle) {
    void cancelListening();
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
  const actions = h('div', { class: 'voz-actions' }, [again, openRoute, installVoice]);

  // One per question. Closing the overlay (or asking again) abandons the one in
  // flight, so the answer to a question the rider walked away from is never read
  // out to an empty screen.
  let abort = new AbortController();

  const sheet = openSheet({
    full: true,
    ariaLabel: 'Pregunta por una ruta',
    onClose: () => {
      openHandle = null;
      abort.abort();
      void cancelListening();
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
  const panel = h('div', { class: 'voz' }, [pulse, status, heard, headline, detail, sentence, actions]);
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

  const showAnswer = (answer: { headline: string; detail: string; written: string }): void => {
    headline.textContent = answer.headline;
    detail.textContent = answer.detail;
    sentence.textContent = answer.written;
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

  const onProgress = (progress: VoiceProgress): void => {
    if (openHandle !== sheet) return;
    if (progress.stage === 'escuchando') {
      listening = true;
      // A second window after a silent first one — say so, or it reads as the
      // app having ignored the rider entirely.
      status.textContent = progress.listen === 'silencio' ? 'No te escuché. Dilo otra vez…' : 'Abriendo el micrófono…';
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
  };

  const ask = (): void => {
    headline.textContent = '';
    detail.textContent = '';
    sentence.textContent = '';
    heard.textContent = '';
    answeredCode = null;
    openRoute.classList.add('hidden');
    installVoice.classList.add('hidden');
    again.disabled = true;
    listening = !code;
    status.textContent = code ? 'Buscando…' : 'Abriendo el micrófono…';
    pulse.className = code ? 'voz-pulse working' : 'voz-pulse listening';

    abort.abort();
    abort = new AbortController();
    void runVoiceSession({ code, onProgress, signal: abort.signal }).then((result) => {
      // The rider may have closed the overlay while the live call was in flight;
      // writing into a detached panel would also speak over a closed screen.
      if (openHandle !== sheet) return;
      again.disabled = false;
      showAnswer(result);

      installVoice.classList.toggle('hidden', result.spoke !== 'sin-voz');

      answeredCode = result.code;
      syncOpenRoute();
    });
  };

  on(installVoice, 'click', () => void installVoiceData());

  on(again, 'click', () => {
    void stopSpeaking();
    // "Otra vez" always means ask again out loud, even when this overlay was
    // opened with a código from a shortcut.
    code = null;
    ask();
  });

  ask();
}
