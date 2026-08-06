/**
 * Shapes of the voice assets baked into the APK (spec §5.9).
 *
 * Produced by `server/src/bundle_mobile_data.ts` (`npm run bundle:mobile`), which
 * splits the 13.6 MB light catalog into a small always-loaded index and one
 * geometry shard per route. The split exists for one reason: a spoken answer has
 * to land ~1.5 s after the rider stops talking, and parsing the full catalog on a
 * cold launch costs more than that on its own.
 *
 * Keep these in step with the writer — the bundler builds these objects by hand
 * (it runs in the server package and cannot import this file).
 */

import type { CatalogRoute } from './catalog';

/** `[codigo, nombre, lng, lat, posicion]` — lng first, matching every trace. */
export type VoiceStop = [string, string, number, number, number];

export interface VoiceRouteGeoDirection {
  stops: VoiceStop[];
  /** LineString `[lng,lat][]` or MultiLineString `[lng,lat][][]`, as the catalog files it. */
  trazado: number[][] | number[][][];
}

/** One `voice/<CODE>.json` shard: the geometry for every direction of one route. */
export interface VoiceRouteGeo {
  codigo: string;
  dirs: Record<string, VoiceRouteGeoDirection>;
}

export interface VoiceIndexDirection {
  origin: string;
  destination: string;
  /** Native catalog shape, so `parseServiceSpans` consumes it with no conversion. */
  horarios?: CatalogRoute['horarios'];
  /** Destination-first live-query names (spec §5.2.4), precomputed at bundle time. */
  live: string[];
}

export interface VoiceIndexRoute {
  nombre: string;
  /** `t` troncal, `z` zonal — decides the cruising speed the ETA divides by. */
  tipo: 't' | 'z';
  color: string;
  dirs: Record<string, VoiceIndexDirection>;
}

export interface VoiceIndex {
  routes: Record<string, VoiceIndexRoute>;
}

/**
 * `[codigo, nombre, lng, lat, "F19,B12,…"]` — one stop and every route that
 * serves it.
 *
 * The inverse of the route index, and the other half of what a rider asks out
 * loud: standing at a paradero, the question is not "where is the F19" but "what
 * comes through here". Built in the same bundler pass as the shards so the two
 * cannot disagree, and loaded **lazily** — 565 KB is worth nothing to the route
 * questions, which are the ones on the ~1.5 s budget.
 */
export type VoiceStopRecord = [string, string, number, number, string];

export interface VoiceStopIndex {
  stops: VoiceStopRecord[];
}
