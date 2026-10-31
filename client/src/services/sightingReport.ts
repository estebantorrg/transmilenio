/**
 * What a client reports to the bus log (spec §5.2.7) from a live answer it read
 * itself. It sends only what it already has and asks the live host for nothing.
 */

import { isBusLike } from '../../../shared/live_payload.js';

// The server keeps one row per bus per 5 minutes, so reporting more often only spends the rider's data.
export const SIGHTING_REPORT_MS = 5 * 60_000;

/** The `/sightings` request body, or `null` when there is nothing new to report for this route. */
export function sightingReport(
  ruta: string,
  data: unknown[],
  now: number,
  lastReported: Map<string, number>
): string | null {
  const buses = data.filter(isBusLike) as Record<string, unknown>[];
  if (buses.length === 0 || now - (lastReported.get(ruta) ?? -Infinity) < SIGHTING_REPORT_MS) return null;
  lastReported.set(ruta, now);
  return JSON.stringify({
    ruta,
    buses: buses.map((bus) => ({
      label: bus.label ?? bus.id,
      latitude: bus.latitude ?? bus.lat,
      longitude: bus.longitude ?? bus.lng ?? bus.lon,
      destino_limpio: bus.destino_limpio,
      posicion: bus.posicion,
      lasttime: bus.lasttime,
    })),
  });
}
