/**
 * The Bogotá bounding box, in ONE place.
 *
 * It was written out four times with two different values — `geocode.ts` used
 * `south: 4.45` while `routes/api.ts` (walking-route validation) used `4.4`, so a
 * coordinate at latitude 4.42 was inside Bogotá for one endpoint and outside it
 * for the next. A city boundary cannot have two definitions (spec §1.1 R2).
 *
 * Kept at the wider `4.4` of the two: it matches the client's own gate
 * (`client/src/utils/geo.ts`), and the tighter value silently dropped real
 * results in the far south of the city.
 */
export const BOGOTA_BOUNDS = {
  west: -74.25,
  south: 4.4,
  east: -73.95,
  north: 4.85,
} as const;

/** `west,south,east,north` — the form Nominatim/Photon want for a viewbox/bbox. */
export const BOGOTA_BBOX = `${BOGOTA_BOUNDS.west},${BOGOTA_BOUNDS.south},${BOGOTA_BOUNDS.east},${BOGOTA_BOUNDS.north}`;

export function isWithinBogota(lng: number, lat: number): boolean {
  return (
    Number.isFinite(lng) &&
    Number.isFinite(lat) &&
    lng >= BOGOTA_BOUNDS.west &&
    lng <= BOGOTA_BOUNDS.east &&
    lat >= BOGOTA_BOUNDS.south &&
    lat <= BOGOTA_BOUNDS.north
  );
}
