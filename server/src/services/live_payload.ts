/**
 * What a live request may carry (spec §5.2.4).
 *
 * ONE definition for the three places that bound it — `/api/buses`
 * (`routes/api.ts`), the tier cascade (`live_request.ts`) and the standalone
 * relay (`colombia_live_relay.ts`). How the answer is unwrapped is shared with
 * the app too: `shared/live_payload.js`.
 */

export const LIVE_ROUTE_CODE_MAX_LENGTH = 32;
export const LIVE_DESTINATION_MAX_LENGTH = 160;
export const LIVE_NAME_CANDIDATE_LIMIT = 12;

/** A request field as one clean line of bounded text; anything else is `''`. */
export function normalizeLiveText(value: unknown, maxLength: number): string {
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  return String(value).replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}
