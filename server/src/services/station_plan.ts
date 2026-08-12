/**
 * Which services board which side of a vagón, and which way each side faces —
 * resolved once, here, and shipped on the light catalog as `station.wagonPlan`.
 *
 * This is the model behind the estación page's plan (spec §5.5.4) and the app's
 * station popup. It lives server-side and travels as data for the same reason
 * `vagonLabels` does: the two clients and the prerenderer are three surfaces
 * onto one network, and a direction derived three times is a direction that can
 * disagree three ways. `isZonalService`, `printedVagonLabels` and `stopTagColor`
 * are already mirrored across the package boundary; this one is deliberately
 * NOT, because it is real logic (bearings, axis splitting, terminus detection)
 * rather than a three-line predicate.
 *
 * A group is `{ sentido, arrival?, ids }`, where `ids` are route **variant** ids
 * — the same código runs both ways, so the código alone cannot say which side a
 * service boards from.
 */

import { isZonalService } from './route_type.js';

export interface PlanGroup {
  /** Cardinal these services leave towards, or null when it can't be derived. */
  sentido: string | null;
  /** These services END here: they arrive and are never boarded onward. */
  arrival?: boolean;
  /** Route variant ids, in catalog order. */
  ids: string[];
}

interface PlanStop {
  codigo?: string;
  coordenada?: string;
}
interface PlanVariant {
  id?: string;
  stops?: PlanStop[];
}
interface PlanWagonEntry {
  id?: string;
  sistema?: string;
  tipoServicio?: string;
}

/**
 * Four points, not eight — Bogotá's grid is not square to true north.
 *
 * The bearings are true, but the corridors run along a tilted grid: the
 * Autopista Norte climbs at 9.4° and Caracas northbound out of Usme at 23.8°,
 * and every rider and every sign calls both of those *norte*. On eight points
 * the second crosses the 22.5° boundary and reads "nororiente", a word nobody
 * uses. Over all 1 599 consecutive troncal hops, the share of bearings within
 * 10° of a boundary — where a street bend flips the label — is 35.7% on eight
 * points against 19.7% on four. Do not restore eight points for precision that
 * is not there, and do not rotate the rose: Portal Norte is the northernmost
 * station in the catalog (lat 4.7555 against Portal Usme's 4.5318).
 */
const CARDINALS = ['norte', 'oriente', 'sur', 'occidente'];

function parseCoordinate(value: string | undefined): { lat: number; lon: number } | null {
  const [lat, lon] = String(value || '').split(',').map((n) => Number(n.trim()));
  return Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : null;
}

/** Compass bearing from a to b, in degrees clockwise from north. */
function bearing(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  // Equirectangular is ample at city scale and avoids trig-heavy great circles.
  const x = (b.lon - a.lon) * Math.cos(((a.lat + b.lat) / 2) * (Math.PI / 180));
  const y = b.lat - a.lat;
  return (Math.atan2(x, y) * 180) / Math.PI;
}

/**
 * Averages bearings as unit vectors — the mean of 350° and 10° is 0°, not 180°.
 *
 * Returns null unless the services genuinely agree. The test is on the **mean**
 * resultant length, not the sum: summing grew with the number of services, so a
 * four-service vagón split two-and-two cleared the bar and printed a direction
 * that was simply wrong.
 */
function meanCardinal(bearings: number[]): string | null {
  if (bearings.length === 0) return null;
  let sx = 0;
  let sy = 0;
  for (const deg of bearings) {
    sx += Math.sin((deg * Math.PI) / 180);
    sy += Math.cos((deg * Math.PI) / 180);
  }
  if (Math.hypot(sx, sy) / bearings.length < 0.6) return null;
  const mean = (Math.atan2(sx, sy) * 180) / Math.PI;
  return CARDINALS[Math.round(((mean + 360) % 360) / 90) % 4];
}

/**
 * Splits a vagón's services into the directions it serves — what an official
 * plano draws as badges above and below the platform.
 *
 * An earlier version *averaged* a vagón's bearings into one label, found they
 * cancelled at most stations, and concluded vagones had no direction. That was
 * backwards: a vagón is usually an island platform serving **both** ways, so the
 * bearings are supposed to disagree. Split on the principal axis (doubled
 * angles, so opposite headings reinforce instead of cancelling), then label each
 * group from its own mean. Verified against the planos for General Santander and
 * Calle 40 Sur: every vagón, both directions, identical to the printed diagram.
 */
function splitDirections(all: Array<{ id: string; deg: number | null; terminates: boolean }>): PlanGroup[] {
  const arrivals = all.filter((e) => e.terminates).map((e) => e.id);
  const entries = all.filter((e) => !e.terminates);
  const tail = (groups: PlanGroup[]): PlanGroup[] =>
    arrivals.length ? [...groups, { sentido: null, arrival: true, ids: arrivals }] : groups;

  const known = entries.filter((e) => e.deg !== null) as Array<{ id: string; deg: number }>;
  const unknown = entries.filter((e) => e.deg === null).map((e) => e.id);
  if (known.length === 0) return tail(entries.length ? [{ sentido: null, ids: entries.map((e) => e.id) }] : []);

  let sx = 0;
  let sy = 0;
  for (const e of known) {
    sx += Math.sin((2 * e.deg * Math.PI) / 180);
    sy += Math.cos((2 * e.deg * Math.PI) / 180);
  }
  const axis = Math.atan2(sx, sy) / 2;
  const ax = Math.sin(axis);
  const ay = Math.cos(axis);

  const groups: Array<Array<{ id: string; deg: number }>> = [[], []];
  for (const e of known) {
    const dot = Math.sin((e.deg * Math.PI) / 180) * ax + Math.cos((e.deg * Math.PI) / 180) * ay;
    groups[dot >= 0 ? 0 : 1].push(e);
  }

  const out: PlanGroup[] = groups
    .filter((g) => g.length > 0)
    .map((g) => ({ sentido: meanCardinal(g.map((e) => e.deg)), ids: g.map((e) => e.id) }));
  // Services whose heading cannot be derived are listed plainly, never guessed.
  if (unknown.length) out.push({ sentido: null, ids: unknown });
  return tail(out);
}

/**
 * Wagon key → its direction groups, for one station. Wagons that resolve to
 * nothing are omitted, and a station with no usable plan yields `undefined` so
 * the field simply does not ship.
 */
export function buildWagonPlan(
  stationCode: string,
  stationCoordenada: string | undefined,
  wagons: Record<string, PlanWagonEntry[]>,
  variantById: Map<string, PlanVariant>
): Record<string, PlanGroup[]> | undefined {
  const here = parseCoordinate(stationCoordenada);
  const code = String(stationCode).toUpperCase();
  const plan: Record<string, PlanGroup[]> = {};

  for (const [wagon, entries] of Object.entries(wagons || {})) {
    const scored: Array<{ id: string; deg: number | null; terminates: boolean }> = [];
    for (const entry of entries || []) {
      const id = String(entry?.id ?? '');
      if (!id) continue;
      // Zonal services carry no direction on any surface — the estación page
      // lists them flat under "Alimentadores y servicios zonales" and so does
      // the popup. Including them here is not merely wasted: wagon "0" pools
      // both networks, so at Portal El Dorado the 24 zonal services dragged the
      // principal axis that its two troncal ones (M86, K86) are labelled from,
      // and flipped that group from occidente to norte.
      if (isZonalService(entry.sistema, entry.tipoServicio)) continue;
      const stops = variantById.get(id)?.stops ?? [];
      const at = here && stops.length ? stops.findIndex((s) => String(s.codigo).toUpperCase() === code) : -1;
      // Last stop of the variant: the service ends here, so there is no onward
      // heading. Reusing the leg *into* the station — which is what a last stop
      // otherwise gets — advertised southbound boarding at Portal Usme, where
      // southbound service ends.
      const terminates = at >= 0 && at === stops.length - 1;

      let deg: number | null = null;
      if (here && at >= 0 && !terminates) {
        const from = parseCoordinate(stops[at].coordenada);
        const to = parseCoordinate(stops[at + 1].coordenada);
        if (from && to) deg = bearing(from, to);
      }
      scored.push({ id, deg, terminates });
    }

    const groups = splitDirections(scored);
    if (groups.length > 0) plan[wagon] = groups;
  }

  return Object.keys(plan).length > 0 ? plan : undefined;
}
