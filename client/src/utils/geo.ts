/**
 * Geographic helpers shared by the map, nearby list, and location gating.
 * Single source for distance/walk math so the web + nearby views never drift.
 */

/** Bogotá bounding box — gates GPS/IP fixes so a fix outside the city is
 *  rejected before it recenters the map or ranks stops. */
export const BOGOTA_BOUNDS = {
  minLat: 4.4,
  maxLat: 4.85,
  minLng: -74.25,
  maxLng: -73.95,
};

export const BOGOTA_CENTER: [number, number] = [-74.1071, 4.6486];

export function isWithinBogota(lng: number, lat: number): boolean {
  return (
    lat >= BOGOTA_BOUNDS.minLat &&
    lat <= BOGOTA_BOUNDS.maxLat &&
    lng >= BOGOTA_BOUNDS.minLng &&
    lng <= BOGOTA_BOUNDS.maxLng
  );
}

/** Great-circle distance in metres between two [lng, lat] points. */
export function haversineMeters(a: [number, number], b: [number, number]): number {
  const R = 6371000;
  const rad = Math.PI / 180;
  const la1 = a[1] * rad;
  const la2 = b[1] * rad;
  const dLat = (b[1] - a[1]) * rad;
  const dLng = (b[0] - a[0]) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Rounded human distance: "320 m" under 1 km, "1,4 km" beyond — Spanish
 *  decimal comma, and no trailing ",0" on a whole number of kilometres. */
export function formatDistance(meters: number): string {
  if (!Number.isFinite(meters)) return '';
  if (meters < 1000) return `${Math.round(meters / 10) * 10} m`;
  return `${(meters / 1000).toFixed(1).replace(/\.0$/, '').replace('.', ',')} km`;
}

/** Walking minutes at ~1.35 m/s, floored at 1. */
export function walkMinutes(meters: number): number {
  return Math.max(1, Math.round(meters / 1.35 / 60));
}

/**
 * Nothing further than this is "cerca de ti" on foot — 3 km is a ~40 min walk.
 * Both Cerca panels bound their list by it, so a rider on the edge of the network
 * (or with a coarse IP fix) is not handed things kilometres away as their nearby
 * options. One constant, both clients (spec §1.1 R2).
 */
export const NEARBY_RADIUS_METERS = 3000;
