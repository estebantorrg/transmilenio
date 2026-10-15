/**
 * The public OSRM foot router run by FOSSGIS (routing.openstreetmap.de) — one
 * reader for its two callers: the server's `GET /api/walking-route`, which the
 * website goes through, and the app, which asks from the phone (spec §5.6.4,
 * §5.2.1b). They used to be two copies that had to change together.
 *
 * FOSSGIS's terms (routing.openstreetmap.de/about.html): at most one request a
 * second, a valid User-Agent, credit with a "fix the map" link, no heavy use.
 * `createPacer` keeps the first, `FOOT_HEADERS` the second, and both planners
 * print the third under their results.
 */

export const FOOT_HEADERS = { Accept: 'application/json', 'User-Agent': 'MiTrasto (+https://mitrasto.app)' };

/** The credit FOSSGIS asks for, with its "fix the map" link; static markup. */
export const FOOT_CREDIT_HTML =
  'Rutas a pie: <a href="https://routing.openstreetmap.de/about.html" target="_blank" rel="noopener noreferrer">FOSSGIS</a> · OSRM · ' +
  '© colaboradores de <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a> · ' +
  '<a href="https://www.openstreetmap.org/fixthemap" target="_blank" rel="noopener noreferrer">Corregir el mapa</a>';

/** FOSSGIS's own limit: one request a second. */
export const FOOT_MIN_INTERVAL_MS = 1000;

export function footRouteUrl(from, to) {
  return (
    `https://routing.openstreetmap.de/routed-foot/route/v1/foot/${from[0]},${from[1]};${to[0]},${to[1]}` +
    '?overview=full&geometries=geojson'
  );
}

/**
 * OSRM's answer → `{ coordinates, distance }`, or null when it has no usable route.
 *
 * OSRM routes between the points it *snapped* the request onto, and reports
 * neither snap leg in `distance` — a stop set back from the kerb, or an origin
 * inside a block, is routinely 20–90 m off the network (mean 24 m per leg, worst
 * 94 m, always short). Both are added, so `distance` is the honest walked total;
 * the router stitches the drawn path back onto its endpoints (`fetchWalkingPath`).
 */
export function readFootRoute(data) {
  const route = data?.routes?.[0];
  const raw = route?.geometry?.coordinates;
  const routed = Number(route?.distance);
  if (data?.code !== 'Ok' || !Array.isArray(raw) || raw.length < 2 || !Number.isFinite(routed)) return null;
  const coordinates = raw.map((point) => [Number(point?.[0]), Number(point?.[1])]);
  if (coordinates.some(([lng, lat]) => !Number.isFinite(lng) || !Number.isFinite(lat))) return null;
  const snap = (index) => {
    const metres = Number(data.waypoints?.[index]?.distance);
    return Number.isFinite(metres) ? metres : 0;
  };
  return { coordinates, distance: routed + snap(0) + snap(1) };
}

/**
 * Spaces calls `intervalMs` apart, first come first served. Each call returns the
 * milliseconds to wait before making the request, or null when that wait would
 * pass `maxWaitMs` — a walk estimate now beats a real one after the rider left.
 *
 * shortcut: per process (one server instance, one phone); share it if the server ever runs more than one.
 */
export function createPacer(intervalMs, maxWaitMs) {
  let next = 0;
  return (now = Date.now()) => {
    const at = Math.max(now, next);
    if (at - now > maxWaitMs) return null;
    next = at + intervalMs;
    return at - now;
  };
}
