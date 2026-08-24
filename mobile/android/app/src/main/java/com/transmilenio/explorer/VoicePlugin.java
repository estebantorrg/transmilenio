package com.transmilenio.explorer;

import android.Manifest;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.location.Location;
import android.location.LocationManager;
import android.media.AudioAttributes;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.speech.RecognitionListener;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import androidx.core.content.ContextCompat;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Speech in, speech out, and a location fix that does not make the rider wait
 * (spec §5.9).
 *
 * The point of this plugin is the timing. A Capacitor cold start spends over a
 * second building the WebView before any JS runs, and a spoken answer has to land
 * about a second and a half after the rider stops talking. So when the app is
 * opened by the voice deep link, recognition starts in {@link #load()} — during
 * bridge init, before the page is up — and the transcript is buffered until the
 * web layer asks for it. The rider talking and the WebView booting then overlap
 * instead of queueing, which is what makes the budget without moving any of the
 * ETA logic into Java.
 *
 * **A pre-warm never answers for the rider.** It races the WebView, so it can
 * time out before the overlay is even on screen — and handing that timeout back
 * as the result is precisely "the app said it didn't hear me before I could
 * speak". Only a real transcript, and failures that are genuinely terminal (no
 * recognizer, no permission), survive to the web layer; a pre-warm that heard
 * silence is simply re-armed when {@link #listen} arrives, so the rider's window
 * starts when they can see that it has.
 *
 * Everything here is plumbing: no route knowledge, no catalog, no network. The
 * answer is computed in TypeScript (`client/src/services/routeEta.ts`) so the app
 * and the website cannot drift (spec §1.1 R2).
 *
 * **Threading.** Capacitor invokes plugin methods on a background executor, while
 * every {@link RecognitionListener} / {@link UtteranceProgressListener} callback
 * arrives on the main thread. Every field those two sides share is therefore
 * guarded by {@link #recognitionLock} / {@link #speechLock}, and the recognizer's
 * whole lifecycle (create / start / cancel / destroy) is posted to the main
 * thread, which is both what `SpeechRecognizer` requires and what serialises
 * starts against stops.
 */
@CapacitorPlugin(
    name = "Voice",
    permissions = {
        @Permission(alias = VoicePlugin.MIC, strings = { Manifest.permission.RECORD_AUDIO }),
        @Permission(
            alias = VoicePlugin.LOCATION,
            strings = { Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION }
        )
    }
)
public class VoicePlugin extends Plugin {

    static final String MIC = "microphone";
    static final String LOCATION = "location";

    /** Deep link the launcher shortcut and the voice entry point both use. */
    private static final String VOICE_SCHEME = "transmigo";
    private static final String VOICE_HOST = "voice";

    // ─── Recognition tuning ───────────────────────────────
    /**
     * Endpointing hints. Left at the platform defaults, a rider who pauses for
     * breath after "¿cuánto falta para…" is cut off mid-question, and a pre-warm
     * that opens while the splash is still up gives up before the overlay renders.
     * These are hints — Google's recognizer honours them loosely — but the floor
     * they set is the difference between being heard and not. Sent as `int`,
     * which is how `android.speech` documents them; a `long` reads back as the
     * default on a recognizer that pulls them with `getInt`.
     *
     * Raised from 2500/1500/1200 because a pause is not the end of a question:
     * riders hesitate mid-código ("el… efe diecinueve"), and 1.2 s of silence is
     * a breath, not a full stop. A longer window costs the rider nothing now that
     * {@link #finishListening} lets them end the question themselves — the screen
     * carries a "Ya terminé" button while the mic is open — so the recognizer no
     * longer has to guess when someone has stopped talking.
     */
    private static final int MIN_INPUT_MS = 3000;
    private static final int COMPLETE_SILENCE_MS = 2600;
    private static final int POSSIBLY_COMPLETE_SILENCE_MS = 2000;
    /**
     * Hard ceiling on one recognition. Some OEM recognizers neither return a
     * result nor raise an error; without this the rider watches "Escuchando…"
     * forever and the mic stays open (spec §4.2 — every failure has an answer).
     */
    private static final long LISTEN_TIMEOUT_MS = 15_000L;
    /**
     * The ceiling is re-armed from the moment the rider starts talking, because
     * the watchdog exists for a recognizer that went quiet, not for a rider who
     * took a while to get to their question. A 12 s window that started while the
     * splash was still up used to expire *mid-sentence* and hand back "no escuché
     * nada" over someone who was audibly speaking.
     */
    private static final long SPEAKING_TIMEOUT_MS = 20_000L;
    /** How long a transcript captured during boot is still the answer to the
     *  question the rider is asking now. */
    private static final long BUFFER_MAX_AGE_MS = 60_000L;
    /** Longest a sentence waits for the TTS service to finish binding before the
     *  web layer is told it will not be spoken (the screen already has it). */
    private static final long TTS_BIND_TIMEOUT_MS = 4_000L;

    // ─── Error codes (contract with voice/bridge.ts) ──────
    /** Heard nothing. NOT terminal: the rider simply has not spoken yet. */
    private static final String ERR_NO_SPEECH = "NO_SPEECH";
    /**
     * Heard something and could not transcribe it. NOT terminal either, and
     * deliberately distinct from {@link #ERR_NO_SPEECH}: the rider DID speak, so
     * the retry has to say "no te entendí" rather than "no te escuché" — telling
     * someone who just spoke that they were silent reads as the app not listening.
     */
    private static final String ERR_NO_MATCH = "NO_MATCH";
    private static final String ERR_NO_RECOGNIZER = "NO_RECOGNIZER";
    private static final String ERR_PERMISSION = "PERMISSION_DENIED";
    private static final String ERR_NETWORK = "NETWORK";
    private static final String ERR_LANGUAGE = "LANGUAGE_UNAVAILABLE";
    private static final String ERR_FAILED = "RECOGNITION_FAILED";

    /**
     * How old a fix may be and still answer "which stop is nearest".
     *
     * Half an hour, not the five minutes this started at: a phone sitting in a
     * pocket indoors has nothing refreshing its location, so a strict window
     * throws away a perfectly good fix and degrades a real answer ("estás a
     * 2,4 km de Ricaurte") into "no sé dónde estás". Measured on a stationary
     * Pixel 6, where the newest system fix was already ~20 minutes old. The
     * question is which stop is nearest, and that does not change while the
     * rider is standing still.
     */
    private static final long LOCATION_MAX_AGE_MS = 30 * 60 * 1000L;

    private final Handler main = new Handler(Looper.getMainLooper());

    // ─── Recognition state (guarded by recognitionLock) ───
    private final Object recognitionLock = new Object();
    /** Touched only on the main thread. */
    private SpeechRecognizer recognizer;
    private boolean listening = false;
    /** Whether the rider has actually started talking into the open mic. */
    private boolean speechStarted = false;
    /**
     * Which recognition attempt is the live one.
     *
     * This is the fix for the defect that made the whole feature read as "it
     * never lets you talk". `SpeechRecognizer.cancel()`/`destroy()` routinely
     * delivers one last callback — typically `onError(ERROR_CLIENT)` — from the
     * instance being torn down, and that callback used to run the same
     * {@link #deliver} path as a real result: it grabbed whichever call was
     * pending *now* (the brand-new listen the rider is waiting on), rejected it
     * as a recognition failure, and then destroyed the recognizer that had just
     * been created for it. The mic closed a few milliseconds after opening and
     * the overlay showed "no te entendí" before a word was said. Every listener
     * and watchdog therefore carries the generation it was created for and does
     * nothing once it is stale.
     */
    private int recognitionGeneration = 0;
    /**
     * The newest partial transcript of the recognition in flight.
     *
     * Kept because a partial is not a draft to be thrown away — it is what the
     * rider said, and it is already on their screen. Google's recognizer
     * regularly streams "efe diecinueve", then finalises with an empty result or
     * `ERROR_NO_MATCH`; answering "no te entendí" there tells someone the app
     * could not understand words it had just displayed back to them, which is the
     * whole of "it has problems recognizing your voice". So an empty final falls
     * back to the last partial and lets the matcher judge it — nothing is
     * *answered* below `MIN_VOICE_CONFIDENCE` anyway (spec §5.9), so a junk
     * partial degrades to the same "no te entendí", while a good one is rescued.
     */
    private String lastPartial = null;
    /** A transcript that arrived before the web layer asked for one. */
    private List<String> bufferedTexts = null;
    private String bufferedErrorCode = null;
    private String bufferedErrorMessage = null;
    private long bufferedAt = 0L;
    private PluginCall pendingListen = null;
    private Runnable listenWatchdog = null;

    // ─── Speech state (guarded by speechLock) ─────────────
    private final Object speechLock = new Object();
    private TextToSpeech tts;
    /** Written from the TTS init callback, which runs on another thread. */
    private volatile boolean ttsInitialized = false;
    /** The engine failed to bind at all — every sentence is screen-only. */
    private volatile boolean ttsFailed = false;
    private boolean ttsLanguageChecked = false;
    private boolean ttsLanguageOk = false;
    /** A sentence handed over before the engine finished binding. */
    private PluginCall pendingSpeak = null;
    private String pendingSpeakText = null;
    private Runnable speakWatchdog = null;

    private final Map<String, PluginCall> speaking = new ConcurrentHashMap<>();
    private int utteranceSeq = 0;

    private volatile boolean launchedByVoice = false;
    private volatile String launchCode = null;

    // ─── Lifecycle ────────────────────────────────────────

    @Override
    public void load() {
        initTts();
        readLaunchIntent(getActivity() == null ? null : getActivity().getIntent());
        warmMicrophone();
    }

    @Override
    protected void handleOnNewIntent(Intent intent) {
        super.handleOnNewIntent(intent);
        readLaunchIntent(intent);
        if (!launchedByVoice) return;
        // Deliberately no pre-warm here. The WebView is already up, so the round
        // trip to the overlay's `listen()` is milliseconds — opening the mic
        // first would only mean closing and reopening it a moment later, which
        // is how the rider's first word gets clipped.
        JSObject event = new JSObject();
        event.put("code", launchCode);
        notifyListeners("voiceLaunch", event);
    }

    @Override
    protected void handleOnDestroy() {
        main.removeCallbacksAndMessages(null);
        synchronized (recognitionLock) {
            recognitionGeneration++; // nothing in flight may fire against a dead plugin
            listenWatchdog = null;
        }
        // Nothing may be left un-settled: a Capacitor call that never resolves is
        // a JS promise that never settles, i.e. an overlay stuck on "Escuchando…".
        failPendingListen(ERR_FAILED, "La app se cerró");
        synchronized (speechLock) {
            if (pendingSpeak != null) {
                pendingSpeak.reject("Voz no disponible", "TTS_UNAVAILABLE");
                pendingSpeak = null;
                pendingSpeakText = null;
            }
        }
        for (PluginCall call : speaking.values()) call.resolve();
        speaking.clear();
        releaseRecognizer();
        synchronized (speechLock) {
            if (tts != null) {
                tts.stop();
                tts.shutdown();
                tts = null;
            }
        }
        super.handleOnDestroy();
    }

    private void readLaunchIntent(Intent intent) {
        launchedByVoice = false;
        launchCode = null;
        if (intent == null) return;
        Uri data = intent.getData();
        if (data == null) return;
        if (!VOICE_SCHEME.equals(data.getScheme()) || !VOICE_HOST.equals(data.getHost())) return;
        launchedByVoice = true;
        String code = data.getQueryParameter("code");
        if (code != null && !code.trim().isEmpty()) launchCode = code.trim();
    }

    /**
     * Open the mic during boot, so the rider's first words are already being
     * transcribed while the WebView is still building.
     *
     * Only for a bare voice launch: a shortcut that names its route has nothing
     * to listen for, and without the permission we do not ask here — a system
     * dialog in front of a splash screen is not a question anyone can answer.
     */
    private void warmMicrophone() {
        if (!launchedByVoice || launchCode != null || !hasMicPermission()) return;
        synchronized (recognitionLock) {
            clearBuffer();
        }
        // The mic is not held open for a page that never asks: LISTEN_TIMEOUT_MS
        // ends any recognition nobody claimed, and BUFFER_MAX_AGE_MS ages out
        // what it captured.
        int generation = nextGeneration();
        main.post(() -> startListening(true, generation));
    }

    /**
     * Whether this launch was a voice one, and any código the caller already
     * knew (a launcher shortcut names its route; a bare "abre TransMi Go" does
     * not). Reading it clears it, so a later resume is not treated as a fresh
     * voice launch.
     */
    @PluginMethod
    public void consumeLaunch(PluginCall call) {
        JSObject result = new JSObject();
        result.put("voice", launchedByVoice);
        result.put("code", launchCode);
        launchedByVoice = false;
        launchCode = null;
        call.resolve(result);
    }

    // ─── Recognition ──────────────────────────────────────

    private boolean hasMicPermission() {
        return ContextCompat.checkSelfPermission(getContext(), Manifest.permission.RECORD_AUDIO)
            == PackageManager.PERMISSION_GRANTED;
    }

    /** Terminal failures answer the caller; everything else re-opens the mic. */
    private static boolean isTerminal(String code) {
        return !ERR_NO_SPEECH.equals(code) && !ERR_NO_MATCH.equals(code);
    }

    /** Caller must hold {@link #recognitionLock}. */
    private void clearBuffer() {
        bufferedTexts = null;
        bufferedErrorCode = null;
        bufferedErrorMessage = null;
        bufferedAt = 0L;
        lastPartial = null;
    }

    /**
     * Retire every recognition in flight: their callbacks and watchdogs become
     * no-ops. Returns the generation the next attempt will run under.
     */
    private int nextGeneration() {
        synchronized (recognitionLock) {
            return ++recognitionGeneration;
        }
    }

    private boolean isCurrent(int generation) {
        synchronized (recognitionLock) {
            return generation == recognitionGeneration;
        }
    }

    /** Main thread only. */
    private void clearWatchdog() {
        Runnable watchdog;
        synchronized (recognitionLock) {
            watchdog = listenWatchdog;
            listenWatchdog = null;
        }
        if (watchdog != null) main.removeCallbacks(watchdog);
    }

    /**
     * (Re)arm the "this recognition went quiet" ceiling. Main thread only.
     *
     * Re-armed on {@link RecognitionListener#onBeginningOfSpeech}: the timer is
     * there for a recognizer that never answers, and it must not fire over a
     * rider who is mid-question.
     */
    private void armWatchdog(int generation, long delayMs) {
        clearWatchdog();
        Runnable watchdog = () -> {
            if (!isCurrent(generation)) return;
            // A recognizer that went quiet mid-sentence still heard the sentence:
            // answer with the partial when there is one (see lastPartial).
            deliverOrFallBackToPartial(ERR_NO_SPEECH, "No escuché nada");
        };
        synchronized (recognitionLock) {
            listenWatchdog = watchdog;
        }
        main.postDelayed(watchdog, delayMs);
    }

    @PluginMethod
    public void listen(PluginCall call) {
        List<String> bufferedResult = null;
        String errorCode = null;
        String errorMessage = null;

        synchronized (recognitionLock) {
            boolean fresh = System.currentTimeMillis() - bufferedAt <= BUFFER_MAX_AGE_MS;
            if (bufferedTexts != null && fresh) {
                // A transcript captured during boot is the whole reason this
                // plugin exists — hand it over rather than listening twice.
                bufferedResult = bufferedTexts;
            } else if (bufferedErrorCode != null && fresh && isTerminal(bufferedErrorCode)) {
                errorCode = bufferedErrorCode;
                errorMessage = bufferedErrorMessage;
            }
            // Anything else (stale, or a pre-warm that merely heard silence) is
            // discarded: the rider is only now looking at a screen that says the
            // app is listening, and that is when their window must start.
            clearBuffer();
        }

        if (bufferedResult != null) {
            resolveListen(call, bufferedResult);
            return;
        }
        if (errorCode != null) {
            call.reject(errorMessage, errorCode);
            return;
        }
        if (!hasMicPermission()) {
            requestPermissionForAlias(MIC, call, "micPermissionResult");
            return;
        }
        beginListening(call);
    }

    @PermissionCallback
    private void micPermissionResult(PluginCall call) {
        if (!hasMicPermission()) {
            call.reject("Sin permiso de micrófono", ERR_PERMISSION);
            return;
        }
        beginListening(call);
    }

    private void beginListening(PluginCall call) {
        call.setKeepAlive(true);
        PluginCall superseded;
        boolean restart;
        String partial;
        synchronized (recognitionLock) {
            superseded = pendingListen;
            pendingListen = call;
            // Take over a pre-warm only while the rider is mid-sentence. An open
            // but silent mic is restarted instead, so the listening window the
            // rider can see is a full one rather than whatever is left of a timer
            // that started behind the splash screen.
            restart = !(listening && speechStarted);
            partial = lastPartial;
        }
        if (superseded != null) superseded.reject("Reemplazado por una nueva escucha", "SUPERSEDED");
        if (restart) {
            // Retire the pre-warm here, on the caller's thread, rather than
            // inside the posted restart: its dying callback would otherwise run
            // against the generation this call is already registered under and
            // answer for it (see recognitionGeneration).
            int generation = nextGeneration();
            main.post(() -> startListening(true, generation));
            return;
        }
        // Taking over a recognition that is ALREADY open: every state event it
        // will ever emit (`voiceReady`, `voiceSpeaking`) fired while the WebView
        // was still building, so the overlay has heard none of them. Without a
        // replay the screen sits on "Abriendo el micrófono…" over a live
        // microphone, and "Ya terminé" — which is gated on `voiceReady` — never
        // appears at all, on the hot-mic path this whole plugin exists for.
        notifyListeners("voiceReady", new JSObject());
        notifyListeners("voiceSpeaking", new JSObject());
        if (partial != null && !partial.trim().isEmpty()) {
            // What the rider has said so far is already transcribed; the overlay
            // echoes it back so they can see they are being heard.
            JSObject echo = new JSObject();
            echo.put("text", partial.trim());
            notifyListeners("voicePartial", echo);
        }
    }

    /**
     * Start one recognition. Main thread only.
     *
     * `preferOffline` is a hint, not a mode: the platform recognizer uses the
     * on-device model when the locale's language pack is installed and the
     * network otherwise. It is deliberately NOT
     * {@link SpeechRecognizer#createOnDeviceSpeechRecognizer} — that reports
     * itself available whenever the on-device *service* exists, which on a phone
     * without the Spanish pack means every attempt dies with "Failed to get
     * language pack of required locale" and no fallback is possible. Measured on
     * a Pixel 6 / Android 16 with no es pack installed.
     */
    /**
     * Spanish, in the order a Bogotá rider is most likely to be understood in.
     *
     * The recognizer is handed one language, and a phone that has no `es-CO`
     * offline pack — most of them — used to fail all the way out to "este
     * teléfono no tiene español" while carrying `es-419` or `es-ES` perfectly
     * capable of transcribing the question.
     */
    private static final String[] LANGUAGES = { "es-CO", "es-419", "es-US", "es-ES", "es" };

    /** The next language to try after this one, or null when the ladder is done. */
    private static String nextLanguage(String current) {
        for (int i = 0; i < LANGUAGES.length - 1; i++) {
            if (LANGUAGES[i].equals(current)) return LANGUAGES[i + 1];
        }
        return null;
    }

    private void startListening(boolean preferOffline, int generation) {
        startListening(preferOffline, LANGUAGES[0], generation);
    }

    private void startListening(boolean preferOffline, String language, int generation) {
        // A newer listen (or a cancel) arrived between the post and here: that one
        // owns the microphone now, and opening a second recognizer would leave two
        // of them fighting over one mic.
        if (!isCurrent(generation)) return;
        if (!SpeechRecognizer.isRecognitionAvailable(getContext())) {
            deliver(null, ERR_NO_RECOGNIZER, "Reconocimiento de voz no disponible en este dispositivo");
            return;
        }
        releaseRecognizer();

        recognizer = SpeechRecognizer.createSpeechRecognizer(getContext());
        recognizer.setRecognitionListener(new VoiceRecognitionListener(preferOffline, language, generation));

        Intent intent = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
        intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
        intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE, language);
        intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_PREFERENCE, language);
        intent.putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true);
        if (preferOffline) intent.putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, true);
        // Alternatives are cheap and the matcher scores all of them (resolveListen):
        // the correct código is often the recognizer's second or third reading, and
        // a códigos table is a better judge of them than the recognizer's ranking.
        intent.putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 10);
        intent.putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE, getContext().getPackageName());
        // Give the rider room to think and to breathe mid-question.
        intent.putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_MINIMUM_LENGTH_MILLIS, MIN_INPUT_MS);
        intent.putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS, COMPLETE_SILENCE_MS);
        intent.putExtra(
            RecognizerIntent.EXTRA_SPEECH_INPUT_POSSIBLY_COMPLETE_SILENCE_LENGTH_MILLIS,
            POSSIBLY_COMPLETE_SILENCE_MS
        );

        synchronized (recognitionLock) {
            listening = true;
            speechStarted = false;
            // A new window transcribes a new question: the previous one's partial
            // must not answer for it.
            lastPartial = null;
        }
        armWatchdog(generation, LISTEN_TIMEOUT_MS);
        recognizer.startListening(intent);
    }

    /** Errors that mean "not in this language, offline" rather than "not at all". */
    private static boolean isLanguageUnavailable(int error) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            return error == SpeechRecognizer.ERROR_LANGUAGE_UNAVAILABLE
                || error == SpeechRecognizer.ERROR_LANGUAGE_NOT_SUPPORTED
                || error == SpeechRecognizer.ERROR_CANNOT_CHECK_SUPPORT;
        }
        // Before API 33 a missing offline pack surfaces as a plain server error and
        // there is no way to tell the two apart — but from 33 on there are three
        // codes that say it precisely, and a plain ERROR_SERVER there is a *server*
        // failure. Reading it as "this phone has no Spanish" sent riders to install
        // a language pack they already had, over what was usually one bad request.
        return error == SpeechRecognizer.ERROR_SERVER;
    }

    /**
     * Whether a failed offline attempt is worth one more try over the network.
     *
     * Wider than {@link #isLanguageUnavailable} on purpose: `EXTRA_PREFER_OFFLINE`
     * makes several errors mean "the on-device model could not do it" rather than
     * "this cannot be done", and a network retry is cheap next to telling the rider
     * we cannot hear them.
     */
    private static boolean isRetryableOffline(int error) {
        return isLanguageUnavailable(error)
            || error == SpeechRecognizer.ERROR_SERVER
            || error == SpeechRecognizer.ERROR_CLIENT
            || error == SpeechRecognizer.ERROR_NETWORK;
    }

    /**
     * Stop listening now.
     *
     * The state is taken down **synchronously**, on the caller's thread, and only
     * the recognizer teardown is posted. Doing the whole thing inside the post
     * meant a `listen()` issued right behind the cancel (closing the overlay and
     * immediately re-asking, which is what "Preguntar otra vez" does) could
     * register its call *first* and then be rejected as CANCELLED by a cancel the
     * rider had already moved past — a dead microphone under a screen that said
     * it was listening.
     */
    @PluginMethod
    public void cancelListening(PluginCall call) {
        PluginCall pending;
        synchronized (recognitionLock) {
            recognitionGeneration++; // every recognition in flight is now stale
            pending = pendingListen;
            pendingListen = null;
            listening = false;
            speechStarted = false;
            clearBuffer();
        }
        if (pending != null) pending.reject("Escucha cancelada", "CANCELLED");
        main.post(() -> {
            clearWatchdog();
            releaseRecognizer();
            call.resolve();
        });
    }

    /**
     * The rider says they have finished the sentence.
     *
     * `stopListening()` — not `cancel()` — closes the microphone and asks the
     * recognizer to transcribe what it already has, so this ends in a normal
     * `onResults`. It exists because the endpointing hints above are only hints:
     * the recognizer decides when someone has stopped talking, and it decides
     * wrong in both directions (cutting off a rider mid-pause, or holding the mic
     * open through the noise of a bus). Giving the rider the button removes the
     * guess from the one case they can settle themselves — and is what makes the
     * longer silence windows safe.
     *
     * A no-op when nothing is listening, so a double tap cannot take down the
     * recognition the next question just opened.
     */
    @PluginMethod
    public void finishListening(PluginCall call) {
        boolean active;
        synchronized (recognitionLock) {
            active = listening;
        }
        if (!active) {
            call.resolve();
            return;
        }
        main.post(() -> {
            SpeechRecognizer current = recognizer;
            if (current != null) {
                try {
                    current.stopListening();
                } catch (Exception ignored) {
                    // A recognizer whose service died needs no stopping; the
                    // watchdog still ends this recognition.
                }
            }
            call.resolve();
        });
    }

    private void failPendingListen(String code, String message) {
        PluginCall call;
        synchronized (recognitionLock) {
            call = pendingListen;
            pendingListen = null;
        }
        if (call != null) call.reject(message, code);
    }

    /** Main thread only. */
    private void releaseRecognizer() {
        if (recognizer == null) return;
        SpeechRecognizer dying = recognizer;
        recognizer = null;
        try {
            // Drop the listener first: `cancel()`/`destroy()` still emit one last
            // callback on several OEM implementations, and with no listener
            // attached it cannot reach the plugin at all (the generation guard is
            // the second line of defence, for the ones that keep their own ref).
            dying.setRecognitionListener(null);
            dying.cancel();
        } catch (Exception ignored) {
            // A recognizer whose service already died throws here; it is being
            // thrown away regardless.
        } finally {
            try {
                dying.destroy();
            } catch (Exception ignored) {
                /* same */
            }
        }
    }

    /**
     * End this recognition with what was actually heard, falling back to the last
     * partial when the recognizer finalised with nothing.
     *
     * Used for every "heard something, transcribed nothing" ending — an empty
     * final result, `ERROR_NO_MATCH`, `ERROR_SPEECH_TIMEOUT`, and the watchdog for
     * a recognizer that simply went quiet. In all four the rider may well have
     * been mid-sentence with their words on screen (see {@link #lastPartial}).
     */
    private void deliverOrFallBackToPartial(String errorCode, String errorMessage) {
        String partial;
        synchronized (recognitionLock) {
            partial = lastPartial;
        }
        if (partial != null && !partial.trim().isEmpty()) {
            List<String> texts = new ArrayList<>();
            texts.add(partial.trim());
            deliver(texts, null, null);
            return;
        }
        deliver(null, errorCode, errorMessage);
    }

    /** Route a finished recognition to whoever is waiting, or buffer it. */
    private void deliver(List<String> texts, String errorCode, String errorMessage) {
        // Posted, not inline: this runs from inside the recognizer's own callback,
        // and the mic stays open until the instance is destroyed — a watchdog that
        // ended the recognition without this would leave the microphone held.
        main.post(() -> {
            clearWatchdog();
            releaseRecognizer();
        });
        PluginCall call;
        synchronized (recognitionLock) {
            // This attempt is over either way, so nothing from it may speak again.
            recognitionGeneration++;
            listening = false;
            speechStarted = false;
            call = pendingListen;
            pendingListen = null;
            if (call == null) {
                bufferedTexts = texts;
                bufferedErrorCode = errorCode;
                bufferedErrorMessage = errorMessage;
                bufferedAt = System.currentTimeMillis();
            }
        }
        if (call == null) return;
        if (errorCode != null) call.reject(errorMessage, errorCode);
        else resolveListen(call, texts);
    }

    /**
     * Hand back what was heard — **every** alternative the recognizer offered, not
     * just its top one.
     *
     * The matcher is a códigos table, not a language model, so it can tell a
     * plausible reading from an implausible one far better than the recognizer's
     * own ranking can: "efe 19" routinely comes back as `["fe 19", "F19",
     * "efe diecinueve"]`, and only reading the first of those threw away the
     * exact match sitting behind it (`voiceMatch.matchRouteCode`).
     */
    private void resolveListen(PluginCall call, List<String> texts) {
        JSObject result = new JSObject();
        List<String> heard = texts == null ? new ArrayList<>() : texts;
        result.put("text", heard.isEmpty() ? "" : heard.get(0));
        result.put("alternatives", new JSArray(heard));
        call.resolve(result);
    }

    /** Recognizer error codes are integers; the rider needs a sentence. */
    private static String describeError(int code) {
        switch (code) {
            case SpeechRecognizer.ERROR_AUDIO: return "Falla del micrófono";
            case SpeechRecognizer.ERROR_CLIENT: return "El reconocedor se detuvo";
            case SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS: return "Sin permiso de micrófono";
            case SpeechRecognizer.ERROR_NETWORK:
            case SpeechRecognizer.ERROR_NETWORK_TIMEOUT: return "Sin conexión para reconocer la voz";
            case SpeechRecognizer.ERROR_NO_MATCH: return "No te entendí";
            case SpeechRecognizer.ERROR_RECOGNIZER_BUSY: return "El reconocedor está ocupado";
            case SpeechRecognizer.ERROR_SPEECH_TIMEOUT: return "No escuché nada";
            case SpeechRecognizer.ERROR_SERVER: return "El servicio de voz falló";
            default:
                if (isLanguageUnavailable(code)) return "No hay reconocimiento de voz en español";
                return "No se pudo reconocer la voz";
        }
    }

    /** The contract code for a recognizer error — see {@link #isTerminal}. */
    private static String errorCodeFor(int code) {
        switch (code) {
            case SpeechRecognizer.ERROR_NO_MATCH:
                return ERR_NO_MATCH;
            case SpeechRecognizer.ERROR_SPEECH_TIMEOUT:
                return ERR_NO_SPEECH;
            case SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS:
                return ERR_PERMISSION;
            case SpeechRecognizer.ERROR_NETWORK:
            case SpeechRecognizer.ERROR_NETWORK_TIMEOUT:
                return ERR_NETWORK;
            default:
                return isLanguageUnavailable(code) ? ERR_LANGUAGE : ERR_FAILED;
        }
    }

    /**
     * One recognition attempt's callbacks.
     *
     * Every method is gated on {@link #generation}: a recognizer being destroyed
     * gets one last callback in, and answering the rider's *current* question with
     * it is the bug that made the mic look dead (see recognitionGeneration).
     */
    private class VoiceRecognitionListener implements RecognitionListener {
        /** Whether this attempt asked for the offline model — decides if a
         *  language failure is worth one retry over the network. */
        private final boolean preferredOffline;
        /** Which Spanish this attempt asked for, so a language failure can step
         *  down the ladder instead of ending the question (see LANGUAGES). */
        private final String language;
        private final int generation;

        VoiceRecognitionListener(boolean preferredOffline, String language, int generation) {
            this.preferredOffline = preferredOffline;
            this.language = language;
            this.generation = generation;
        }

        private boolean stale() {
            return !isCurrent(generation);
        }

        @Override
        public void onReadyForSpeech(Bundle params) {
            if (stale()) return;
            notifyListeners("voiceReady", new JSObject());
        }

        @Override
        public void onBeginningOfSpeech() {
            if (stale()) return;
            synchronized (recognitionLock) {
                speechStarted = true;
            }
            // The rider is talking: the "went quiet" ceiling restarts from here so
            // it cannot expire over a question in progress.
            armWatchdog(generation, SPEAKING_TIMEOUT_MS);
            notifyListeners("voiceSpeaking", new JSObject());
        }

        @Override public void onRmsChanged(float rmsdB) { }
        @Override public void onBufferReceived(byte[] buffer) { }

        @Override
        public void onEndOfSpeech() {
            if (stale()) return;
            notifyListeners("voiceEnd", new JSObject());
        }

        @Override public void onEvent(int eventType, Bundle params) { }

        @Override
        public void onError(int error) {
            if (stale()) return;
            // A phone with no Spanish language pack fails instantly and offline.
            // Retry once over the network before telling the rider we cannot
            // hear them — most devices can, they just have nothing downloaded.
            if (preferredOffline && isRetryableOffline(error)) {
                int retry = nextGeneration();
                main.post(() -> startListening(false, language, retry));
                return;
            }
            // The phone may simply not have *this* Spanish. Colombian first, then
            // Latin-American, then Spain, then plain `es` — a device with any of
            // them can hear the question, and giving up at es-CO told riders their
            // phone has no Spanish when it has four other flavours of it.
            if (isLanguageUnavailable(error)) {
                String next = nextLanguage(language);
                if (next != null) {
                    int retry = nextGeneration();
                    main.post(() -> startListening(false, next, retry));
                    return;
                }
            }
            // NO_MATCH / SPEECH_TIMEOUT after the rider has already been speaking:
            // the partial on their screen is the answer, not "no te entendí".
            if (error == SpeechRecognizer.ERROR_NO_MATCH || error == SpeechRecognizer.ERROR_SPEECH_TIMEOUT) {
                deliverOrFallBackToPartial(errorCodeFor(error), describeError(error));
                return;
            }
            deliver(null, errorCodeFor(error), describeError(error));
        }

        @Override
        public void onPartialResults(Bundle partialResults) {
            if (stale()) return;
            List<String> heard = results(partialResults);
            if (heard.isEmpty()) return;
            // Kept, not just echoed: an empty or unmatched final answers with this
            // rather than with "no te entendí" (see lastPartial).
            synchronized (recognitionLock) {
                lastPartial = heard.get(0);
            }
            // Words are still arriving, so the rider is still talking. The ceiling
            // exists for a recognizer that went QUIET, and leaving it counting from
            // the first syllable cut off anyone whose question ran past it — handing
            // back a half-transcribed partial as though they had stopped speaking.
            armWatchdog(generation, SPEAKING_TIMEOUT_MS);
            // Streamed so the overlay can echo what it is hearing; the rider
            // seeing their own words is what makes a wrong reading obvious.
            JSObject event = new JSObject();
            event.put("text", heard.get(0));
            notifyListeners("voicePartial", event);
        }

        @Override
        public void onResults(Bundle results) {
            if (stale()) return;
            List<String> heard = results(results);
            if (heard.isEmpty()) {
                deliverOrFallBackToPartial(ERR_NO_MATCH, describeError(SpeechRecognizer.ERROR_NO_MATCH));
            } else {
                deliver(heard, null, null);
            }
        }

        /** Every non-empty alternative, best-ranked first (see resolveListen). */
        private List<String> results(Bundle bundle) {
            List<String> out = new ArrayList<>();
            if (bundle == null) return out;
            ArrayList<String> matches = bundle.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
            if (matches == null) return out;
            for (String match : matches) {
                if (match == null) continue;
                String text = match.trim();
                if (!text.isEmpty() && !out.contains(text)) out.add(text);
            }
            return out;
        }
    }

    // ─── Speech synthesis ─────────────────────────────────

    private void initTts() {
        TextToSpeech engine = new TextToSpeech(getContext(), status -> {
            // NOTHING in here may touch the `tts` field. `onInit` can fire before
            // the constructor has returned and assigned it — measured on a Pixel 6,
            // where the resulting NullPointerException is swallowed by the TTS
            // framework, the engine is silently never marked ready, and every
            // answer is shown but never spoken. Set a flag only; the language is
            // resolved lazily on the first speak, by which point the field exists.
            if (status == TextToSpeech.SUCCESS) {
                ttsInitialized = true;
                main.post(this::flushPendingSpeak);
            } else {
                // A held sentence must be released either way: leaving the call
                // un-settled hangs the JS promise the overlay is waiting on, so
                // the answer is never even shown, let alone spoken.
                ttsFailed = true;
                main.post(() -> failPendingSpeak("Voz no disponible", "TTS_UNAVAILABLE"));
            }
        });
        // Assistant usage, not plain media: the answer should duck the rider's
        // music for a second rather than play mixed underneath it.
        engine.setAudioAttributes(
            new AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_ASSISTANT)
                .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                .build()
        );
        engine.setOnUtteranceProgressListener(new UtteranceProgressListener() {
            @Override public void onStart(String utteranceId) { }

            @Override
            public void onDone(String utteranceId) {
                PluginCall call = speaking.remove(utteranceId);
                if (call != null) call.resolve();
            }

            @Override
            public void onError(String utteranceId) {
                PluginCall call = speaking.remove(utteranceId);
                if (call != null) call.reject("No se pudo reproducir la voz", "TTS_FAILED");
            }
        });
        synchronized (speechLock) {
            tts = engine;
        }
    }

    /** Colombian Spanish, then any Spanish. A missing es-CO voice must degrade to
     *  es-ES rather than leaving the answer to be read by an English voice. */
    private boolean applyVoiceLanguage(TextToSpeech engine) {
        Locale[] preferences = { new Locale("es", "CO"), new Locale("es", "ES"), new Locale("es") };
        for (Locale locale : preferences) {
            int result = engine.setLanguage(locale);
            if (result != TextToSpeech.LANG_MISSING_DATA && result != TextToSpeech.LANG_NOT_SUPPORTED) {
                return true;
            }
        }
        return false;
    }

    @PluginMethod
    public void speak(PluginCall call) {
        String text = call.getString("text", "");
        if (text == null || text.trim().isEmpty()) {
            call.reject("Nada que decir", "EMPTY_TEXT");
            return;
        }
        if (ttsFailed) {
            call.reject("Voz no disponible", "TTS_UNAVAILABLE");
            return;
        }
        // Binding to the TTS service takes a moment, and the answer is often
        // ready first on a warm launch. Hold the sentence instead of dropping it:
        // rejecting here is what "the answer appeared but nothing was said" looks
        // like from the rider's side. Bounded, so a service that never binds
        // still settles the call.
        if (!ttsInitialized) {
            PluginCall superseded;
            Runnable watchdog = () -> failPendingSpeak("Voz no disponible", "TTS_UNAVAILABLE");
            synchronized (speechLock) {
                superseded = pendingSpeak;
                call.setKeepAlive(true);
                pendingSpeak = call;
                pendingSpeakText = text;
                if (speakWatchdog != null) main.removeCallbacks(speakWatchdog);
                speakWatchdog = watchdog;
            }
            if (superseded != null) superseded.resolve(); // superseded, never left hanging
            main.postDelayed(watchdog, TTS_BIND_TIMEOUT_MS);
            return;
        }
        performSpeak(call, text);
    }

    private void flushPendingSpeak() {
        PluginCall call;
        String text;
        synchronized (speechLock) {
            call = pendingSpeak;
            text = pendingSpeakText;
            pendingSpeak = null;
            pendingSpeakText = null;
            if (speakWatchdog != null) {
                main.removeCallbacks(speakWatchdog);
                speakWatchdog = null;
            }
        }
        if (call != null) performSpeak(call, text);
    }

    private void failPendingSpeak(String message, String code) {
        PluginCall call;
        synchronized (speechLock) {
            call = pendingSpeak;
            pendingSpeak = null;
            pendingSpeakText = null;
            if (speakWatchdog != null) {
                main.removeCallbacks(speakWatchdog);
                speakWatchdog = null;
            }
        }
        if (call != null) call.reject(message, code);
    }

    private void performSpeak(PluginCall call, String text) {
        TextToSpeech engine;
        String utteranceId;
        synchronized (speechLock) {
            engine = tts;
            if (engine == null) {
                call.reject("Voz no disponible", "TTS_UNAVAILABLE");
                return;
            }
            // Resolved once, on the first sentence — not in the init callback,
            // where the engine reference may not exist yet (see initTts).
            if (!ttsLanguageChecked) {
                ttsLanguageChecked = true;
                ttsLanguageOk = applyVoiceLanguage(engine);
            }
            if (!ttsLanguageOk) {
                // The screen always carries the same sentence, so a device with no
                // Spanish voice still answers — it just does not speak (spec §4.2).
                // The distinct code lets the overlay offer installVoiceData instead
                // of leaving the rider to work out why it went quiet.
                call.reject("No hay voz en español instalada", "TTS_LANGUAGE_MISSING");
                return;
            }
            utteranceId = "tmgo-" + (++utteranceSeq);
        }
        speaking.put(utteranceId, call);
        call.setKeepAlive(true);
        int queued = engine.speak(text, TextToSpeech.QUEUE_FLUSH, null, utteranceId);
        if (queued != TextToSpeech.SUCCESS) {
            speaking.remove(utteranceId);
            call.reject("No se pudo reproducir la voz", "TTS_FAILED");
        }
    }

    /**
     * Open the system's "install voice data" screen.
     *
     * The speech engine and its voices belong to Android, not to this APK —
     * there is no supported way to ship or side-load them — so when a device has
     * no Spanish voice, handing the rider the one screen that fixes it is the
     * whole remedy available. Fired only from an explicit tap, never on its own.
     */
    @PluginMethod
    public void installVoiceData(PluginCall call) {
        Intent intent = new Intent(TextToSpeech.Engine.ACTION_INSTALL_TTS_DATA);
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            getContext().startActivity(intent);
        } catch (Exception e) {
            call.reject("No se pudo abrir la instalación de voces", "TTS_INSTALL_UNAVAILABLE");
            return;
        }
        // The next speak re-checks the language, so a voice installed now works
        // without restarting the app.
        synchronized (speechLock) {
            ttsLanguageChecked = false;
        }
        call.resolve();
    }

    @PluginMethod
    public void stopSpeaking(PluginCall call) {
        // A sentence still waiting on the engine has to be dropped too, or the
        // answer to a question the rider already dismissed is read out to an
        // empty screen a second later.
        failPendingSpeak("Detenido", "STOPPED");
        TextToSpeech engine;
        synchronized (speechLock) {
            engine = tts;
        }
        if (engine != null) engine.stop();
        for (PluginCall pending : speaking.values()) pending.resolve();
        speaking.clear();
        call.resolve();
    }

    // ─── Location ─────────────────────────────────────────

    /**
     * The most recent fix the system already holds — never a fresh one.
     *
     * `navigator.geolocation` is what the map uses, and a high-accuracy fix there
     * can take ten seconds. For an answer about a bus, the rider's position from
     * a few minutes ago is right to within a block, and a block does not change
     * which stop is nearest. Waiting would cost more accuracy (in the answer)
     * than it buys.
     */
    private boolean hasLocationPermission() {
        return ContextCompat.checkSelfPermission(getContext(), Manifest.permission.ACCESS_FINE_LOCATION)
            == PackageManager.PERMISSION_GRANTED
            || ContextCompat.checkSelfPermission(getContext(), Manifest.permission.ACCESS_COARSE_LOCATION)
                == PackageManager.PERMISSION_GRANTED;
    }

    @PluginMethod
    public void lastLocation(PluginCall call) {
        // Ask for it here, the first time the voice flow actually needs it.
        // Only the map used to request location, so a rider who only ever asks
        // out loud was told "no sé dónde estás" forever with nothing in the
        // feature able to fix it — the permission had to be granted from Android
        // settings, which is not an answer for someone standing at a paradero.
        if (!hasLocationPermission()) {
            if (getPermissionState(LOCATION) == PermissionState.PROMPT
                || getPermissionState(LOCATION) == PermissionState.PROMPT_WITH_RATIONALE) {
                requestPermissionForAlias(LOCATION, call, "locationPermissionResult");
            } else {
                // Permanently denied — re-asking is a no-op dialog the rider
                // already dismissed. Answer with what we can (spec §4.2).
                JSObject denied = new JSObject();
                denied.put("available", false);
                denied.put("reason", "PERMISSION_DENIED");
                call.resolve(denied);
            }
            return;
        }
        readLastLocation(call);
    }

    @PermissionCallback
    private void locationPermissionResult(PluginCall call) {
        if (!hasLocationPermission()) {
            JSObject denied = new JSObject();
            denied.put("available", false);
            denied.put("reason", "PERMISSION_DENIED");
            call.resolve(denied);
            return;
        }
        readLastLocation(call);
    }

    private void readLastLocation(PluginCall call) {
        JSObject result = new JSObject();
        LocationManager manager = (LocationManager) getContext().getSystemService(Context.LOCATION_SERVICE);
        if (manager == null) {
            result.put("available", false);
            result.put("reason", "NO_PROVIDER");
            call.resolve(result);
            return;
        }

        Location best = null;
        List<String> providers = manager.getProviders(true);
        for (String provider : providers) {
            Location fix;
            try {
                fix = manager.getLastKnownLocation(provider);
            } catch (SecurityException e) {
                continue; // provider revoked between the check and the read
            }
            if (fix == null) continue;
            if (best == null || fix.getTime() > best.getTime()) best = fix;
        }

        if (best == null || System.currentTimeMillis() - best.getTime() > LOCATION_MAX_AGE_MS) {
            result.put("available", false);
            result.put("reason", best == null ? "NO_FIX" : "STALE");
            call.resolve(result);
            return;
        }

        result.put("available", true);
        result.put("lat", best.getLatitude());
        result.put("lng", best.getLongitude());
        result.put("accuracy", best.getAccuracy());
        result.put("ageMs", System.currentTimeMillis() - best.getTime());
        call.resolve(result);
    }
}
