/**
 * A planned trip as a link anyone can open (spec §5.6.7): the website planner's
 * own `#/plan?…` address, built here once so the website and the app share the
 * same link, and with it the chosen itinerary, not just the two ends.
 *
 *   o / d    "lat,lng" of the two ends;  ol / dl  their labels;  oc / dc  stop codes
 *   m / p    transport mode and ranking, only when not the default ('mix', 'transfers')
 *   t        "YYYY-MM-DDTHH:MM" for a trip planned at a set moment; "now" stays out,
 *            so a link opened later plans for its reader's now
 *   s=0      the schedule filter off (on is the default)
 *   v        the chosen option, as the códigos it rides in order: "B23.G47"
 */

/** Where a shared link opens. */
export const WEB_ORIGIN = 'https://mitrasto.app';

/**
 * A GPS end is the sharer's own position — often home — on its way into a group
 * chat. It travels on a ~110 m grid (3 decimals) under a label that names the
 * nearest stop rather than "Mi ubicación", which on the reader's screen would
 * claim to be THEIR position.
 */
export function redondear(coord) {
  return [Math.round(coord[0] * 1000) / 1000, Math.round(coord[1] * 1000) / 1000];
}

/** The option's identity across reloads and re-rankings: the códigos it rides, in order. */
export function viaKey(plan) {
  return (plan?.steps ?? [])
    .filter((step) => step.type === 'ride' && step.routeCode)
    .map((step) => String(step.routeCode).toUpperCase())
    .join('.');
}

/** The index of the plan that rides `via`, or -1 — a card number would not survive the list changing. */
export function planIndexForVia(plans, via) {
  const wanted = String(via ?? '').toUpperCase();
  return wanted ? plans.findIndex((plan) => viaKey(plan) === wanted) : -1;
}

/**
 * "Cerca de Calle 100": a GPS origin named by the option's first boarding, a GPS
 * destination by its last alighting — or a plain "Punto cercano" with no option.
 */
export function cercaDe(plan, end) {
  const rides = (plan?.steps ?? []).filter((step) => step.type === 'ride');
  const name = end === 'o' ? rides[0]?.fromName : rides[rides.length - 1]?.toName;
  return name ? `Cerca de ${name}` : 'Punto cercano';
}

/**
 * The query string of a trip.
 * @param {{
 *   origin?: { coord: [number, number], label?: string, code?: string, gps?: boolean } | null,
 *   destination?: { coord: [number, number], label?: string, code?: string, gps?: boolean } | null,
 *   mode?: string, sortBy?: string, depart?: string | null, enforceSchedules?: boolean,
 *   plan?: object | null
 * }} trip
 */
export function viajeParams(trip) {
  const sp = new URLSearchParams();
  const put = (prefix, end) => {
    if (!end?.coord) return;
    // A GPS end is rounded and relabelled, and its code dropped (there is none; a stop picked is not GPS).
    const coord = end.gps ? redondear(end.coord) : end.coord;
    sp.set(prefix, `${coord[1].toFixed(6)},${coord[0].toFixed(6)}`);
    const label = end.gps ? cercaDe(trip.plan, prefix) : end.label;
    if (label) sp.set(`${prefix}l`, label);
    if (end.code && !end.gps) sp.set(`${prefix}c`, end.code);
  };
  put('o', trip.origin);
  put('d', trip.destination);
  if (trip.mode && trip.mode !== 'mix') sp.set('m', trip.mode);
  if (trip.sortBy && trip.sortBy !== 'transfers') sp.set('p', trip.sortBy);
  if (trip.depart) sp.set('t', trip.depart);
  if (trip.enforceSchedules === false) sp.set('s', '0');
  const via = viaKey(trip.plan);
  if (via) sp.set('v', via);
  return sp.toString();
}

/** The whole link. */
export function viajeUrl(trip) {
  return `${WEB_ORIGIN}/#/plan?${viajeParams(trip)}`;
}
