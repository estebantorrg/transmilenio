/**
 * The one door to speech and to a fast position fix (spec §5.9).
 *
 * Inside the APK this is the native `Voice` plugin (`mobile/android/.../
 * VoicePlugin.java`), which is what makes the timing work: it starts listening
 * during bridge init, before this bundle has even parsed. In a browser it falls
 * back to the Web Speech API so the whole flow — matcher, ETA, composer — is
 * exercisable without a device (spec §4.2: the app still runs on the web, it just
 * has no reason to).
 *
 * Every export degrades to a resolved "not available" rather than throwing, so a
 * device with no recognizer, no Spanish voice or no location still reaches an
 * answer on screen.
 */

export interface VoiceLaunch {
  /** The app was opened through `transmigo://voice`. */
  voice: boolean;
  /** A código the caller already knew (a launcher shortcut can name one). */
  code: string | null;
}

export interface VoiceFix {
  available: boolean;
  lng: number;
  lat: number;
  accuracy: number;
  ageMs: number;
}

interface VoicePluginApi {
  consumeLaunch(): Promise<{ voice?: boolean; code?: string | null }>;
  listen(): Promise<{ text?: string; alternatives?: string[] }>;
  cancelListening(): Promise<void>;
  speak(options: { text: string }): Promise<void>;
  stopSpeaking(): Promise<void>;
  installVoiceData(): Promise<void>;
  lastLocation(): Promise<{ available?: boolean; lat?: number; lng?: number; accuracy?: number; ageMs?: number }>;
  addListener(event: string, handler: (data: any) => void): Promise<{ remove: () => void }> | { remove: () => void };
}

function plugin(): VoicePluginApi | null {
  const cap = (window as any).Capacitor;
  if (!cap?.isNativePlatform?.()) return null;
  const voice = cap.Plugins?.Voice;
  return voice && typeof voice.listen === 'function' ? (voice as VoicePluginApi) : null;
}

export function isNativeVoice(): boolean {
  return plugin() !== null;
}

// ─── Launch ───────────────────────────────────────────────

export async function consumeVoiceLaunch(): Promise<VoiceLaunch> {
  const api = plugin();
  if (!api) return { voice: false, code: null };
  try {
    const result = await api.consumeLaunch();
    return { voice: result.voice === true, code: result.code ?? null };
  } catch {
    return { voice: false, code: null };
  }
}

/** Fires when the deep link arrives while the app is already running. */
export function onVoiceLaunch(handler: (code: string | null) => void): void {
  const api = plugin();
  if (!api) return;
  void api.addListener('voiceLaunch', (data: { code?: string | null }) => handler(data?.code ?? null));
}

/** Live transcript while the rider is still talking, for the on-screen echo. */
export function onVoicePartial(handler: (text: string) => void): () => void {
  const api = plugin();
  if (api) return listenNative(api, [['voicePartial', (data: { text?: string }) => handler(data?.text ?? '')]]);
  webPartialHandlers.add(handler);
  return () => webPartialHandlers.delete(handler);
}

/**
 * Subscribe to plugin events and return a remover that works even when it is
 * called before `addListener` has resolved.
 *
 * `Capacitor.Plugins.X.addListener` returns a promise, so an unsubscribe issued in
 * the same tick (an overlay closed as fast as it opened) used to run against a
 * handle that did not exist yet and simply did nothing — the listener stayed
 * attached and kept repainting a screen the rider had already dismissed, and every
 * re-open added another one.
 */
function listenNative(api: VoicePluginApi, wires: [string, (data: any) => void][]): () => void {
  let removed = false;
  const handles: (() => void)[] = [];
  for (const [event, handler] of wires) {
    void Promise.resolve(api.addListener(event, handler)).then((handle) => {
      if (removed) handle.remove();
      else handles.push(handle.remove);
    });
  }
  return () => {
    removed = true;
    handles.forEach((remove) => remove());
    handles.length = 0;
  };
}

/**
 * Where the microphone actually is: `ready` = open and recording, `speaking` =
 * the rider has started talking, `end` = the recognizer has stopped listening
 * and is deciding.
 *
 * The overlay needs this, not a guess. Recognition can be opening (permission
 * dialog, service binding) or already finished while the screen still reads
 * "Escuchando…", and a rider who is told the app is listening when it is not
 * speaks into a closed mic — which is exactly what "it never let me talk" is.
 */
export type VoiceMicState = 'ready' | 'speaking' | 'end';

export function onVoiceState(handler: (state: VoiceMicState) => void): () => void {
  const api = plugin();
  if (api) {
    return listenNative(api, [
      ['voiceReady', () => handler('ready')],
      ['voiceSpeaking', () => handler('speaking')],
      ['voiceEnd', () => handler('end')],
    ]);
  }
  webStateHandlers.add(handler);
  return () => webStateHandlers.delete(handler);
}

// ─── Recognition ──────────────────────────────────────────

const webPartialHandlers = new Set<(text: string) => void>();
const webStateHandlers = new Set<(state: VoiceMicState) => void>();
let webRecognition: any = null;

function webSpeechCtor(): any {
  return (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition ?? null;
}

/**
 * Why a recognition ended.
 *
 * `silencio` (nothing was said) and `no-entendi` (something was said and could
 * not be transcribed) are deliberately separate and neither is an error: both
 * mean the rider still has a question to ask, so the caller re-opens the mic
 * (`session.ts`) with the right thing on screen. Telling someone who just spoke
 * that they were silent is how the app reads as not listening. Everything else is
 * terminal for this question.
 */
export type ListenOutcome =
  | 'ok'
  | 'silencio'
  | 'no-entendi'
  | 'cancelado'
  | 'sin-permiso'
  | 'sin-reconocedor'
  | 'sin-red'
  | 'sin-idioma'
  | 'error';

/** Outcomes where the rider can simply try again — the mic is fine. */
export const RETRYABLE_LISTEN = new Set<ListenOutcome>(['silencio', 'no-entendi']);

export interface ListenResult {
  /** The best transcript. Empty for every outcome but `ok`. */
  text: string;
  /**
   * Every reading the recognizer offered, best-ranked first (`text` is the first
   * of them). The matcher scores all of them: a códigos table judges "F19" against
   * "fe 19" far better than the recognizer's own ranking does, and the exact match
   * is regularly the second alternative.
   */
  alternatives: string[];
  outcome: ListenOutcome;
}

/** Plugin reject codes → outcomes. Keep in step with `VoicePlugin.java`. */
const NATIVE_OUTCOMES: Record<string, ListenOutcome> = {
  NO_SPEECH: 'silencio',
  NO_MATCH: 'no-entendi',
  PERMISSION_DENIED: 'sin-permiso',
  NO_RECOGNIZER: 'sin-reconocedor',
  NETWORK: 'sin-red',
  LANGUAGE_UNAVAILABLE: 'sin-idioma',
  CANCELLED: 'cancelado',
  SUPERSEDED: 'cancelado',
};

/** Web Speech API error strings → the same outcomes. */
const WEB_OUTCOMES: Record<string, ListenOutcome> = {
  'no-speech': 'silencio',
  'no-match': 'no-entendi',
  aborted: 'cancelado',
  'not-allowed': 'sin-permiso',
  'service-not-allowed': 'sin-permiso',
  network: 'sin-red',
  'language-not-supported': 'sin-idioma',
};

/** Same purpose as the plugin's watchdog: a recognizer that neither returns nor
 *  errors must not leave the overlay claiming to listen forever. */
const WEB_LISTEN_TIMEOUT_MS = 12_000;

/**
 * Listen once and resolve with what was heard, or with why nothing was.
 *
 * Never rejects: a rider holding a phone to their face needs the flow to keep
 * going, and the caller decides what a silence means (spec §4.2). Natively this
 * may return instantly — recognition that started during app boot is buffered by
 * the plugin, so by the time this bundle asks, the rider has often already
 * finished speaking.
 */
export function listenOnce(): Promise<ListenResult> {
  const api = plugin();
  if (api) {
    return api.listen().then(
      (result) => {
        const alternatives = (Array.isArray(result?.alternatives) ? result.alternatives : [])
          .map((value) => String(value ?? '').trim())
          .filter(Boolean);
        const text = String(result?.text ?? '').trim();
        if (text && !alternatives.includes(text)) alternatives.unshift(text);
        const best = text || alternatives[0] || '';
        return { text: best, alternatives, outcome: best ? ('ok' as const) : ('silencio' as const) };
      },
      (error: unknown) => {
        const code = (error as { code?: string })?.code ?? '';
        return { text: '', alternatives: [], outcome: NATIVE_OUTCOMES[code] ?? 'error' };
      }
    );
  }

  const Ctor = webSpeechCtor();
  if (!Ctor) return Promise.resolve({ text: '', alternatives: [], outcome: 'sin-reconocedor' });

  return new Promise<ListenResult>((resolve) => {
    const recognition = new Ctor();
    webRecognition = recognition;
    recognition.lang = 'es-CO';
    recognition.interimResults = true;
    recognition.maxAlternatives = 5;

    let best = '';
    const alternatives: string[] = [];
    let outcome: ListenOutcome | null = null;
    let settled = false;
    const settle = (result: ListenResult): void => {
      if (settled) return;
      settled = true;
      window.clearTimeout(watchdog);
      webRecognition = null;
      resolve(result);
    };
    const announce = (state: VoiceMicState) => webStateHandlers.forEach((handler) => handler(state));
    const watchdog = window.setTimeout(() => {
      try {
        recognition.abort();
      } catch {
        /* aborting a recognizer that already died is fine */
      }
      settle({ text: best, alternatives, outcome: best ? 'ok' : 'silencio' });
    }, WEB_LISTEN_TIMEOUT_MS);

    recognition.onaudiostart = () => announce('ready');
    recognition.onspeechstart = () => announce('speaking');
    recognition.onspeechend = () => announce('end');
    recognition.onresult = (event: any) => {
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        const text = String(result[0]?.transcript ?? '').trim();
        if (!text) continue;
        best = text;
        if (result.isFinal) {
          // Every alternative, same as the native path — the matcher decides.
          for (let a = 0; a < result.length; a++) {
            const alt = String(result[a]?.transcript ?? '').trim();
            if (alt && !alternatives.includes(alt)) alternatives.push(alt);
          }
        } else {
          webPartialHandlers.forEach((handler) => handler(text));
        }
      }
    };
    // `onerror` is always followed by `onend`, so the outcome is recorded here
    // and the promise is settled once, in `onend` — resolving in both would
    // report a failure the recognizer then contradicted with a transcript.
    recognition.onerror = (event: any) => {
      outcome = WEB_OUTCOMES[String(event?.error ?? '')] ?? 'error';
    };
    recognition.onend = () => {
      announce('end');
      if (best) settle({ text: best, alternatives, outcome: 'ok' });
      else settle({ text: '', alternatives: [], outcome: outcome ?? 'silencio' });
    };
    try {
      recognition.start();
    } catch {
      settle({ text: '', alternatives: [], outcome: 'error' });
    }
  });
}

export async function cancelListening(): Promise<void> {
  const api = plugin();
  if (api) {
    await api.cancelListening().catch(() => undefined);
    return;
  }
  try {
    webRecognition?.abort();
  } catch {
    /* a recognizer that already died needs no aborting */
  }
  webRecognition = null;
}

// ─── Speech ───────────────────────────────────────────────

/** `sin-voz` = the device has no Spanish voice installed, which the rider can
 *  fix from {@link installVoiceData}; `omitido` = the caller asked for a silent
 *  answer; `error` is anything else and is silent. */
export type SpeakOutcome = 'ok' | 'sin-voz' | 'omitido' | 'error';

/** Longest the web fallback waits for a sentence it handed to `speechSynthesis`
 *  before assuming the browser will never report back. */
const WEB_SPEAK_TIMEOUT_MS = 20_000;

/** Speak, resolving when the sentence finishes. Never throws — the same words are
 *  always on screen, so a device that cannot speak still answers (spec §4.2). */
export async function speak(text: string): Promise<SpeakOutcome> {
  if (!text.trim()) return 'error';
  const api = plugin();
  if (api) {
    try {
      await api.speak({ text });
      return 'ok';
    } catch (error) {
      const code = (error as { code?: string })?.code;
      return code === 'TTS_LANGUAGE_MISSING' ? 'sin-voz' : 'error';
    }
  }
  const synth = window.speechSynthesis;
  if (!synth) return 'error';
  return new Promise<SpeakOutcome>((resolve) => {
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = 'es-CO';
    // A browser with no installed voice accepts `speak()` and then fires NOTHING
    // — no `end`, no `error` — so an un-bounded wait here hangs the whole session
    // promise, and every affordance the overlay gates on it never appears. The
    // audio, if it is playing, is unaffected by resolving; only the outcome is.
    let settled = false;
    const settle = (outcome: SpeakOutcome): void => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      resolve(outcome);
    };
    const timer = window.setTimeout(() => settle('error'), WEB_SPEAK_TIMEOUT_MS);
    utterance.onend = () => settle('ok');
    utterance.onerror = () => settle('error');
    synth.cancel();
    synth.speak(utterance);
  });
}

/**
 * Open Android's "install voice data" screen. The speech voices belong to the
 * OS, not to this APK — there is no supported way to bundle them — so this is
 * the whole remedy available when a device has no Spanish voice.
 */
export async function installVoiceData(): Promise<void> {
  const api = plugin();
  if (!api) return;
  await api.installVoiceData().catch(() => undefined);
}

export async function stopSpeaking(): Promise<void> {
  const api = plugin();
  if (api) {
    await api.stopSpeaking().catch(() => undefined);
    return;
  }
  window.speechSynthesis?.cancel();
}

// ─── Position ─────────────────────────────────────────────

/**
 * The rider's position, fast or not at all.
 *
 * Deliberately NOT `navigator.geolocation.getCurrentPosition` with high accuracy
 * — that is what the map uses and it can take ten seconds, which is the entire
 * voice budget several times over. Natively this reads the fix the system already
 * holds; on the web it asks for a cached one with a hard 2.5 s cap. A position
 * from a few minutes ago is right to within a block, and a block does not change
 * which stop is nearest.
 */
export async function fastFix(): Promise<VoiceFix | null> {
  const api = plugin();
  if (api) {
    try {
      const fix = await api.lastLocation();
      if (!fix?.available || !Number.isFinite(fix.lat) || !Number.isFinite(fix.lng)) return null;
      return {
        available: true,
        lat: Number(fix.lat),
        lng: Number(fix.lng),
        accuracy: Number(fix.accuracy ?? 0),
        ageMs: Number(fix.ageMs ?? 0),
      };
    } catch {
      return null;
    }
  }

  if (!('geolocation' in navigator)) return null;
  return new Promise<VoiceFix | null>((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (position) =>
        resolve({
          available: true,
          lat: position.coords.latitude,
          lng: position.coords.longitude,
          accuracy: position.coords.accuracy ?? 0,
          ageMs: Math.max(0, Date.now() - position.timestamp),
        }),
      () => resolve(null),
      { enableHighAccuracy: false, timeout: 2500, maximumAge: 300_000 }
    );
  });
}
