/**
 * What a live request may carry and how a live answer is unwrapped (spec §5.2.4).
 *
 * ONE definition for the three places that handle both — `/api/buses`
 * (`routes/api.ts`), the tier cascade (`tm_api.ts`) and the standalone relay
 * (`colombia_live_relay.ts`). Each used to keep its own copy, and a payload
 * shape one copy handled came back empty through another (spec §1.1 R2). The
 * app's `findBusPayloadArray` (`client/src/utils/liveBus.ts`) is the one twin
 * left, because the two packages compile separately.
 */

export const LIVE_ROUTE_CODE_MAX_LENGTH = 32;
export const LIVE_DESTINATION_MAX_LENGTH = 160;
export const LIVE_NAME_CANDIDATE_LIMIT = 12;

/** A request field as one clean line of bounded text; anything else is `''`. */
export function normalizeLiveText(value: unknown, maxLength: number): string {
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  return String(value).replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function isLiveBusLike(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;

  const bus = value as { latitude?: unknown; longitude?: unknown; lat?: unknown; lng?: unknown; lon?: unknown };
  return Number.isFinite(Number(bus.latitude ?? bus.lat)) &&
    Number.isFinite(Number(bus.longitude ?? bus.lng ?? bus.lon));
}

/** The bus array out of whichever envelope the live host answered with. */
export function normalizeLiveBusesPayload(payload: any): any[] {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];

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
    if (candidate && typeof candidate === 'object') {
      const nestedBuses = Object.values(candidate).filter(isLiveBusLike);
      if (nestedBuses.length > 0) return nestedBuses;
    }
  }

  return Object.values(payload).filter(isLiveBusLike);
}
