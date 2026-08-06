/**
 * Loading the voice data, and nothing else (spec §5.9).
 *
 * The full light catalog is 13.6 MB and `loadCore` parses it at boot. The voice
 * flow must not wait for that — it answers off a 367 KB index plus one ~5 KB
 * geometry shard, which is why `bundle_mobile_data.ts` emits them separately.
 * Both loads are cached for the session; the index is also deduped in flight, so
 * a rider who fires the mic twice does not fetch it twice.
 */

import type { VoiceIndex, VoiceRouteGeo, VoiceStopIndex } from '@shared/types/voice';

// The index is small enough to go through Vite like the other bundled datasets,
// so it is fingerprinted and resolved identically in dev and in the APK.
import voiceIndexUrl from '../generated/voice_index.json?url';
// The stop → routes index (565 KB) goes through Vite the same way but is fetched
// only when a stop question is actually asked: it is worth nothing to the route
// questions, which are the ones on the ~1.5 s budget.
import voiceStopsUrl from '../generated/voice_stops.json?url';

/**
 * Shards are NOT part of the module graph — 776 files would be 776 build inputs
 * for a payload only one of which is ever read. They are copied verbatim into the
 * APK web root by `mobile/scripts/build-web.mjs`, so the built app serves them
 * from `/voice/`. The dev server has no such copy step and serves the project
 * tree instead, which is where they sit before the build.
 */
const SHARD_BASE = import.meta.env.DEV ? '/src/generated/voice' : '/voice';

let indexPromise: Promise<VoiceIndex> | null = null;
let stopsPromise: Promise<VoiceStopIndex> | null = null;
const shards = new Map<string, Promise<VoiceRouteGeo | null>>();

export function loadVoiceIndex(): Promise<VoiceIndex> {
  if (!indexPromise) {
    indexPromise = fetch(voiceIndexUrl)
      .then((response) => {
        if (!response.ok) throw new Error(`voice_index ${response.status}`);
        return response.json() as Promise<VoiceIndex>;
      })
      .catch((error) => {
        // Don't pin the failure: the next attempt should be able to succeed
        // (first launch offline, storage hiccup) rather than the app deciding
        // once and for all that it knows no routes.
        indexPromise = null;
        throw error;
      });
  }
  return indexPromise;
}

/** Stop → routes (spec §5.9 `paradas`). Same un-pinned failure rule as the index. */
export function loadVoiceStops(): Promise<VoiceStopIndex> {
  if (!stopsPromise) {
    stopsPromise = fetch(voiceStopsUrl)
      .then((response) => {
        if (!response.ok) throw new Error(`voice_stops ${response.status}`);
        return response.json() as Promise<VoiceStopIndex>;
      })
      .catch((error) => {
        stopsPromise = null;
        throw error;
      });
  }
  return stopsPromise;
}

/**
 * One route's stops + trazado, or null when the route ships no geometry.
 *
 * A missing shard is a real, expected state — 7 of the 783 códigos have no usable
 * trace — and it is answerable ("conozco el F19 pero no tengo su recorrido"), so
 * it resolves null instead of rejecting.
 */
export function loadRouteGeo(code: string): Promise<VoiceRouteGeo | null> {
  const key = code.toUpperCase();
  const cached = shards.get(key);
  if (cached) return cached;

  const request = fetch(`${SHARD_BASE}/${encodeURIComponent(key)}.json`)
    .then((response) => (response.ok ? (response.json() as Promise<VoiceRouteGeo>) : null))
    .catch(() => {
      // A 404 is a fact about the route and stays cached; a failed *read* is not,
      // so it is un-pinned exactly like the index above. Caching it would answer
      // "no tengo su recorrido" for the rest of the session about a route whose
      // geometry is sitting in the APK.
      shards.delete(key);
      return null;
    });
  shards.set(key, request);
  return request;
}
