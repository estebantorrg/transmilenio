/**
 * Shared helpers for locating the bus array inside a live-tracking payload.
 *
 * The live API (and the extension/relay/server tiers that wrap it) return the
 * vehicle list under one of several keys, or as a bare array, or as an object
 * keyed by vehicle id. Both the API client (`services/api.ts`, to decide
 * live-vs-no-buses) and the render layer (`layers/buses.ts`, to normalize) need
 * to find that array, so the logic lives here once.
 */

export function toFiniteNumber(value: unknown): number | null {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

export function isBusLike(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;

  const bus = value as { latitude?: unknown; longitude?: unknown; lat?: unknown; lng?: unknown; lon?: unknown };
  return toFiniteNumber(bus.latitude ?? bus.lat) !== null &&
    toFiniteNumber(bus.longitude ?? bus.lng ?? bus.lon) !== null;
}

function busValuesFromObject(value: unknown): unknown[] | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;

  const buses = Object.values(value).filter(isBusLike);
  return buses.length > 0 ? buses : null;
}

/** Locate the bus array inside any known live payload shape, or `null`. */
export function findBusPayloadArray(payload: any): unknown[] | null {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return null;

  const candidates = [
    payload.data,
    payload.buses,
    payload.result,
    payload.results,
    payload.vehiculos,
    payload.vehicles,
  ];

  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate;
  }

  for (const candidate of candidates) {
    const buses = busValuesFromObject(candidate);
    if (buses) return buses;
  }

  return busValuesFromObject(payload);
}
