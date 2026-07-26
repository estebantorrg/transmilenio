/**
 * "Is the app in front of the user right now?"
 *
 * Live tracking polls every 15 s (spec §3.4). Nothing used to stop that when the
 * page went to a background tab or, on the phone, when the user switched apps —
 * so a route left open kept issuing a Colombian round-trip four times a minute
 * against a screen nobody was looking at. That is the user's battery and mobile
 * data, and (in the app) a wake-up per poll.
 *
 * Both clients share this one gate: `document.visibilityState` covers browser
 * tabs and, inside the Android shell, the webview's own hidden state; the
 * Capacitor `App` plugin's `appStateChange` is the authoritative native signal
 * and is used when present.
 */

type Listener = (active: boolean) => void;

const listeners = new Set<Listener>();
let nativeActive: boolean | null = null; // null = no native signal seen yet

/** Whether the UI is currently visible to the user. */
export function isAppActive(): boolean {
  if (nativeActive === false) return false;
  return typeof document === 'undefined' || document.visibilityState !== 'hidden';
}

function emit(): void {
  const active = isAppActive();
  for (const listener of listeners) {
    try {
      listener(active);
    } catch (error) {
      console.warn('[appActive] listener threw', error);
    }
  }
}

/** Subscribe to foreground/background transitions. Returns an unsubscribe fn. */
export function onAppActiveChange(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

let wired = false;
function wire(): void {
  if (wired || typeof document === 'undefined') return;
  wired = true;

  document.addEventListener('visibilitychange', () => {
    // A visible document means the app is in front, whatever a stale native
    // flag says (the two signals can race on resume).
    if (document.visibilityState === 'visible') nativeActive = true;
    emit();
  });

  const cap = (window as any).Capacitor;
  const appPlugin = cap?.Plugins?.App;
  if (cap?.isNativePlatform?.() && appPlugin?.addListener) {
    appPlugin.addListener('appStateChange', (state: { isActive?: boolean }) => {
      nativeActive = state?.isActive !== false;
      emit();
    });
  }
}

wire();
