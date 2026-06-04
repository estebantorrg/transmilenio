/**
 * Live Bridge client
 *
 * Talks to the optional "Live Bridge" browser extension over a private
 * `window.postMessage` channel. When the extension is installed, live-bus
 * requests are made from the *user's* own browser — bypassing both the live
 * API's CO-only geofence (the request carries the user's Colombian IP) and the
 * browser CORS wall (extension background fetches ignore page CORS).
 *
 * When the extension is absent, {@link isLiveBridgeAvailable} resolves false and
 * the caller falls back to the server relay (see `services/api.ts`).
 */

const CHANNEL = 'tm-live-bridge/v1';
const PING_TIMEOUT_MS = 600;
const REQUEST_TIMEOUT_MS = 11_000;
const AVAILABILITY_TTL_MS = 30_000;

type ExtMessage = {
  channel?: string;
  dir?: string;
  kind?: string;
  id?: string;
  ok?: boolean;
  data?: unknown;
  error?: string | null;
};

let availability: { value: boolean; at: number } | null = null;
let counter = 0;

function nextId(): string {
  return `${Date.now()}-${++counter}`;
}

/** Resolves with the first `ext->page` message matching `predicate`, or null on timeout. */
function waitForMessage(predicate: (msg: ExtMessage) => boolean, timeoutMs: number): Promise<ExtMessage | null> {
  return new Promise((resolve) => {
    const onMessage = (event: MessageEvent) => {
      if (event.source !== window) return;
      const msg = event.data as ExtMessage;
      if (!msg || msg.channel !== CHANNEL || msg.dir !== 'ext->page') return;
      if (predicate(msg)) {
        cleanup();
        resolve(msg);
      }
    };
    const timer = window.setTimeout(() => {
      cleanup();
      resolve(null);
    }, timeoutMs);
    function cleanup() {
      window.removeEventListener('message', onMessage);
      window.clearTimeout(timer);
    }
    window.addEventListener('message', onMessage);
  });
}

// The content script announces `hello` at document_start; flip availability
// eagerly so the very first request can use the bridge without a ping round-trip.
if (typeof window !== 'undefined') {
  window.addEventListener('message', (event: MessageEvent) => {
    if (event.source !== window) return;
    const msg = event.data as ExtMessage;
    if (msg && msg.channel === CHANNEL && msg.dir === 'ext->page' && msg.kind === 'hello') {
      availability = { value: true, at: Date.now() };
    }
  });
}

export async function isLiveBridgeAvailable(): Promise<boolean> {
  if (typeof window === 'undefined') return false;
  if (availability && Date.now() - availability.at < AVAILABILITY_TTL_MS) return availability.value;

  const id = nextId();
  const pong = waitForMessage((msg) => msg.kind === 'pong' && msg.id === id, PING_TIMEOUT_MS);
  window.postMessage({ channel: CHANNEL, dir: 'page->ext', kind: 'ping', id }, window.location.origin);

  const value = (await pong) !== null;
  availability = { value, at: Date.now() };
  return value;
}

export async function fetchLiveBusesViaBridge(
  ruta: string,
  nombre: string,
  routeType: 'troncal' | 'zonal',
  candidates: string[]
): Promise<unknown> {
  const id = nextId();
  const result = waitForMessage((msg) => msg.kind === 'result' && msg.id === id, REQUEST_TIMEOUT_MS);
  window.postMessage(
    { channel: CHANNEL, dir: 'page->ext', kind: 'fetch', id, ruta, nombre, routeType, candidates },
    window.location.origin
  );

  const res = await result;
  if (!res) {
    availability = null; // bridge went quiet — re-probe next time
    throw new Error('Live bridge timed out');
  }
  if (!res.ok) throw new Error(res.error || 'Live bridge request failed');
  return res.data;
}
