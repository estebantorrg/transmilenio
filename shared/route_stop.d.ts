/**
 * Types for `route_stop.js` — where a route boards at one of its stops.
 *
 * Hand-written beside the module, as `station_platforms.d.ts` is: the source is
 * plain JS so the server can import it without a build step.
 */

import type { StationPlatform } from './station_platforms.js';

export interface Abordaje {
  /** The platform the route stops at, as a station, or the stop itself. */
  station: any;
  /** That platform, where the catalog files the stop as two stations. */
  platform?: StationPlatform;
  /** The vagón this route boards from here, as its sign reads ("3", "T7"). */
  vagon?: string;
  /** The catalog wagon letters carrying the route at this stop. */
  wagons: string[];
}

export function abordajeEn(parent: any, codigo: string, destino?: string): Abordaje | null;

/** "Vagón 3", or the sign as it stands where it is not a number ("T7"). */
export function vagonTexto(vagon: string): string;
