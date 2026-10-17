/**
 * Where a bus or a stop sits along a route's trace (spec §5.8, §5.9) — the
 * geometry under both live ETAs: the server's arrivals board
 * (`server/src/services/stop_arrivals.ts`) and the app's voice answer
 * (`client/src/services/routeEta.ts`). It was two hand copies, one of them
 * untested, and the same bus must not be "4 min away" on one and "6 min away"
 * on the other (spec §1.1 R2). The speeds live in `shared/calibration.js`.
 */

/** A bus farther than this from the trace is not on it (GPS drift, another variant). */
export const ON_ROUTE_MAX_PERP_M = 160;
/** A bus this far past the stop has passed it; less is GPS jitter at the stop. */
export const PASSED_STOP_EPSILON_M = 40;

const DEG2RAD = Math.PI / 180;
const EARTH_R = 6_371_000;

function isCoordinatePair(value) {
  return Array.isArray(value) &&
    value.length >= 2 &&
    Number.isFinite(Number(value[0])) &&
    Number.isFinite(Number(value[1]));
}

/** A LineString or MultiLineString trace as an array of `[lng, lat]` paths. */
export function traceToPaths(trace) {
  if (!Array.isArray(trace) || trace.length === 0) return [];
  const first = trace[0];
  if (isCoordinatePair(first)) return [trace];
  if (Array.isArray(first) && isCoordinatePair(first[0])) {
    return trace.filter((path) => Array.isArray(path) && path.length > 1);
  }
  return [];
}

/**
 * The nearest point of `paths` to a lng/lat: `perp`, its distance (m), and
 * `along`, how far down the trace it is (m). Measured on a local plane anchored
 * at the point (sub-0.3% error at city scale). The gaps between the paths of a
 * MultiLineString are not counted in `along`. Bus and stop are projected onto
 * the same trace, so any simplification of it largely cancels in their difference.
 */
export function projectOntoPaths(paths, pLng, pLat) {
  const cosLat = Math.cos(pLat * DEG2RAD);
  const toXY = (lng, lat) => [
    (lng - pLng) * DEG2RAD * EARTH_R * cosLat,
    (lat - pLat) * DEG2RAD * EARTH_R,
  ];

  let best = null;
  let base = 0; // along-track distance of the paths already passed

  for (const path of paths) {
    if (path.length < 2) continue;
    let cum = 0; // distance within this path up to the segment start
    let prev = toXY(Number(path[0][0]), Number(path[0][1]));

    for (let i = 1; i < path.length; i++) {
      const curr = toXY(Number(path[i][0]), Number(path[i][1]));
      const dx = curr[0] - prev[0];
      const dy = curr[1] - prev[1];
      const segLen2 = dx * dx + dy * dy;
      const segLen = Math.sqrt(segLen2);

      // The query point is the origin (0,0) by construction.
      const t = segLen2 > 0 ? Math.max(0, Math.min(1, -(prev[0] * dx + prev[1] * dy) / segLen2)) : 0;
      const perp = Math.hypot(prev[0] + t * dx, prev[1] + t * dy);
      if (best === null || perp < best.perp) {
        best = { perp, along: base + cum + t * segLen };
      }

      cum += segLen;
      prev = curr;
    }
    base += cum;
  }

  return best;
}
