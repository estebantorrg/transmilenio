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
     */
    private static final int MIN_INPUT_MS = 2500;
    private static final int COMPLETE_SILENCE_MS = 1500;
    private static final int POSSIBLY_COMPLETE_SILENCE_MS = 1200;
    /**
     * Hard ceiling on one recognition. Some OEM recognizers neither return a
     * result nor raise an error; without this the rider watches "Escuchando…"
     * forever and the mic stays open (spec §4.2 — every failure has an answer).
     */
    private static final long LISTEN_TIMEOUT_MS = 12_000L;
    /** How long a transcript captured during boot is still the answer to the
     *  question the rider is asking now. */
    private static final long BUFFER_MAX_AGE_MS = 60_000L;
    /** Longest a sentence waits for the TTS service to finish binding before the
     *  web layer is told it will not be spoken (the screen already has it). */
    private static final long TTS_BIND_TIMEOUT_MS = 4_000L;

    // ─── Error codes (contract with voice/bridge.ts) ──────
    /** Heard nothing. NOT terminal: the rider simply has not spoken yet. */
    private static final String ERR_NO_SPEECH = "NO_SPEECH";
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
    /** A transcript that arrived before the web layer asked for one. */
    private String bufferedText = null;
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
        main.post(() -> startListening(true));
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
        return !ERR_NO_SPEECH.equals(code);
    }

    /** Caller must hold {@link #recognitionLock}. */
    private void clearBuffer() {
        bufferedText = null;
        bufferedErrorCode = null;
        bufferedErrorMessage = null;
        bufferedAt = 0L;
    }

    @PluginMethod
    public void listen(PluginCall call) {
        String bufferedResult = null;
        String errorCode = null;
        String errorMessage = null;

        synchronized (recognitionLock) {
            boolean fresh = System.currentTimeMillis() - bufferedAt <= BUFFER_MAX_AGE_MS;
            if (bufferedText != null && fresh) {
                // A transcript captured during boot is the whole reason this
                // plugin exists — hand it over rather than listening twice.
                bufferedResult = bufferedText;
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
        synchronized (recognitionLock) {
            superseded = pendingListen;
            pendingListen = call;
            // Take over a pre-warm only while the rider is mid-sentence. An open
            // but silent mic is restarted instead, so the listening window the
            // rider can see is a full one rather than whatever is left of a timer
            // that started behind the splash screen.
            restart = !(listening && speechStarted);
        }
        if (superseded != null) superseded.reject("Reemplazado por una nueva escucha", "SUPERSEDED");
        if (restart) main.post(() -> startListening(true));
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
    private void startListening(boolean preferOffline) {
        if (!SpeechRecognizer.isRecognitionAvailable(getContext())) {
            deliver(null, ERR_NO_RECOGNIZER, "Reconocimiento de voz no disponible en este dispositivo");
            return;
        }
        releaseRecognizer();

        recognizer = SpeechRecognizer.createSpeechRecognizer(getContext());
        recognizer.setRecognitionListener(new VoiceRecognitionListener(preferOffline));

        Intent intent = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
        intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
        intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE, "es-CO");
        intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_PREFERENCE, "es-CO");
        intent.putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true);
        if (preferOffline) intent.putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, true);
        intent.putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 3);
        intent.putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE, getContext().getPackageName());
        // Give the rider room to think and to breathe mid-question.
        intent.putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_MINIMUM_LENGTH_MILLIS, MIN_INPUT_MS);
        intent.putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS, COMPLETE_SILENCE_MS);
        intent.putExtra(
            RecognizerIntent.EXTRA_SPEECH_INPUT_POSSIBLY_COMPLETE_SILENCE_LENGTH_MILLIS,
            POSSIBLY_COMPLETE_SILENCE_MS
        );

        Runnable watchdog = () -> deliver(null, ERR_NO_SPEECH, "No escuché nada");
        synchronized (recognitionLock) {
            listening = true;
            speechStarted = false;
            if (listenWatchdog != null) main.removeCallbacks(listenWatchdog);
            listenWatchdog = watchdog;
        }
        main.postDelayed(watchdog, LISTEN_TIMEOUT_MS);
        recognizer.startListening(intent);
    }

    /** Errors that mean "not in this language, offline" rather than "not at all". */
    private static boolean isLanguageUnavailable(int error) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            if (error == SpeechRecognizer.ERROR_LANGUAGE_UNAVAILABLE
                || error == SpeechRecognizer.ERROR_LANGUAGE_NOT_SUPPORTED
                || error == SpeechRecognizer.ERROR_CANNOT_CHECK_SUPPORT) {
                return true;
            }
        }
        // Before API 33 a missing offline pack surfaces as a plain server error.
        return error == SpeechRecognizer.ERROR_SERVER;
    }

    @PluginMethod
    public void cancelListening(PluginCall call) {
        main.post(() -> {
            releaseRecognizer();
            synchronized (recognitionLock) {
                listening = false;
                speechStarted = false;
                clearBuffer();
                if (listenWatchdog != null) {
                    main.removeCallbacks(listenWatchdog);
                    listenWatchdog = null;
                }
            }
            failPendingListen("CANCELLED", "Escucha cancelada");
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
        try {
            recognizer.cancel();
            recognizer.destroy();
        } finally {
            recognizer = null;
        }
    }

    /** Route a finished recognition to whoever is waiting, or buffer it. */
    private void deliver(String text, String errorCode, String errorMessage) {
        // Posted, not inline: this runs from inside the recognizer's own callback,
        // and the mic stays open until the instance is destroyed — a watchdog that
        // ended the recognition without this would leave the microphone held.
        main.post(this::releaseRecognizer);
        PluginCall call;
        synchronized (recognitionLock) {
            listening = false;
            speechStarted = false;
            if (listenWatchdog != null) {
                main.removeCallbacks(listenWatchdog);
                listenWatchdog = null;
            }
            call = pendingListen;
            pendingListen = null;
            if (call == null) {
                bufferedText = text;
                bufferedErrorCode = errorCode;
                bufferedErrorMessage = errorMessage;
                bufferedAt = System.currentTimeMillis();
            }
        }
        if (call == null) return;
        if (errorCode != null) call.reject(errorMessage, errorCode);
        else resolveListen(call, text);
    }

    private void resolveListen(PluginCall call, String text) {
        JSObject result = new JSObject();
        result.put("text", text == null ? "" : text);
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

    private class VoiceRecognitionListener implements RecognitionListener {
        /** Whether this attempt asked for the offline model — decides if a
         *  language failure is worth one retry over the network. */
        private final boolean preferredOffline;

        VoiceRecognitionListener(boolean preferredOffline) {
            this.preferredOffline = preferredOffline;
        }

        @Override public void onReadyForSpeech(Bundle params) { notifyListeners("voiceReady", new JSObject()); }

        @Override
        public void onBeginningOfSpeech() {
            synchronized (recognitionLock) {
                speechStarted = true;
            }
            notifyListeners("voiceSpeaking", new JSObject());
        }

        @Override public void onRmsChanged(float rmsdB) { }
        @Override public void onBufferReceived(byte[] buffer) { }
        @Override public void onEndOfSpeech() { notifyListeners("voiceEnd", new JSObject()); }
        @Override public void onEvent(int eventType, Bundle params) { }

        @Override
        public void onError(int error) {
            // A phone with no Spanish language pack fails instantly and offline.
            // Retry once over the network before telling the rider we cannot
            // hear them — most devices can, they just have nothing downloaded.
            if (preferredOffline && isLanguageUnavailable(error)) {
                main.post(() -> startListening(false));
                return;
            }
            deliver(null, errorCodeFor(error), describeError(error));
        }

        @Override
        public void onPartialResults(Bundle partialResults) {
            String text = firstResult(partialResults);
            if (text == null) return;
            // Streamed so the overlay can echo what it is hearing; the rider
            // seeing their own words is what makes a wrong reading obvious.
            JSObject event = new JSObject();
            event.put("text", text);
            notifyListeners("voicePartial", event);
        }

        @Override
        public void onResults(Bundle results) {
            String text = firstResult(results);
            if (text == null) {
                deliver(null, ERR_NO_SPEECH, describeError(SpeechRecognizer.ERROR_NO_MATCH));
            } else {
                deliver(text, null, null);
            }
        }

        private String firstResult(Bundle bundle) {
            if (bundle == null) return null;
            ArrayList<String> matches = bundle.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
            if (matches == null || matches.isEmpty()) return null;
            String text = matches.get(0);
            return text == null || text.trim().isEmpty() ? null : text.trim();
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
