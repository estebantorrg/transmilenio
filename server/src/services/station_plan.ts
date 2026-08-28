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

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { isZonalService } from './route_type.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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
 * What riders call each direction, per corridor — answered by the maintainer,
 * not computed (`data/corridor_directions.json`, `data/station_corridors.json`).
 *
 * A bearing cannot name a direction here. Bogotá's grid is not square to true
 * north, and a corridor keeps ONE name for its axis along its whole length even
 * where the road bends: Calle 26 is oriente/occidente even where its bearing
 * swings north, and the NQS stays norte/sur through the Soacha stretch that
 * physically runs east-west. Naming from the compass disagreed with the street
 * on eight of the twelve corridors, so the compass no longer gets a vote — it
 * only decides WHICH END of a corridor a platform serves, never what that end
 * is called.
 */
const CORRIDOR_DIRECTIONS: Record<string, { axisBearing: number; positive: string; negative: string }> = (() => {
  try {
    return JSON.parse(readFileSync(path.resolve(__dirname, '..', 'data', 'corridor_directions.json'), 'utf-8')).corridors ?? {};
  } catch {
    console.warn('[TM API] corridor_directions.json unreadable; platform directions will be omitted.');
    return {};
  }
})();

const STATION_CORRIDOR_FILE: { corridors?: Record<string, string>; letters?: Record<string, string> } = (() => {
  try {
    return JSON.parse(readFileSync(path.resolve(__dirname, '..', 'data', 'station_corridors.json'), 'utf-8'));
  } catch {
    console.warn('[TM API] station_corridors.json unreadable; platform directions will be omitted.');
    return {};
  }
})();

const STATION_CORRIDORS: Record<string, string> = STATION_CORRIDOR_FILE.corridors ?? {};

/** Corridor name → its troncal letter (`Autonorte` → `B`), the key both clients
 *  colour a corridor by (§5.4.3). Joined from ArcGIS `letra_trazado_troncal`,
 *  see the file's `_meta`. TransMiCable is not a troncal and has none. */
const CORRIDOR_LETTERS: Record<string, string> = STATION_CORRIDOR_FILE.letters ?? {};

export interface StationCorridor {
  /** The corridor as the official station maps name it ("Autonorte"). */
  nombre: string;
  /** Its troncal letter, absent where the corridor has none (TransMiCable). */
  letra?: string;
  /**
   * What riders call the corridor's two directions ("norte"/"sur"), from
   * `corridor_directions.json`.
   *
   * Shipped because the drawn plan needs the station's sides to mean ONE thing
   * each, the way the operator's `Plano de ubicación` does: one direction along
   * the top edge, the other along the bottom, named once. Without it the plan
   * can only put a vagón's first group above and the rest below, which is an
   * ordering accident — at Bicentenario that printed `occidente` over one vagón
   * and `sur` over the next, so neither side of the drawing meant anything.
   * Absent for a corridor with no answered axis (TransMiCable).
   */
  sentidos?: { positive: string; negative: string };
}

/**
 * The troncal corridor a station physically sits on, shipped on the light
 * catalog so both clients can key a station's colour off it (spec §5.5.6).
 *
 * Answered, not derived: ArcGIS's own `troncal_estacion` is a station-level
 * label that does not always name one corridor ("CR 7-10" is two of them), and
 * the nearest corridor centreline is exactly wrong where it matters most — at
 * Av. Jiménez three of them pass within metres. `station_corridors.json` is the
 * official station-maps answer, station by station.
 */
export function stationCorridor(stationCode: string): StationCorridor | null {
  const nombre = STATION_CORRIDORS[String(stationCode).toUpperCase()];
  if (!nombre) return null;
  const letra = CORRIDOR_LETTERS[nombre];
  const axis = CORRIDOR_DIRECTIONS[nombre];
  const sentidos = axis ? { positive: axis.positive, negative: axis.negative } : undefined;
  return { nombre, ...(letra ? { letra } : {}), ...(sentidos ? { sentidos } : {}) };
}

/** Smallest angle between two bearings, 0–180. */
function angleBetween(a: number, b: number): number {
  return Math.abs((((a - b) % 360) + 540) % 360 - 180);
}

/**
 * The name for a heading at a station, from the corridor it sits on.
 *
 * Along the corridor's axis it takes that corridor's own pair. Perpendicular to
 * it, the bus has left the corridor — at Museo Nacional one service turns off
 * Carrera 7 onto Calle 26 — so it takes the crossing pair instead, oriented by
 * the compass, which is the one case where east/west and north/south are not in
 * dispute. Returns null when there is no corridor on file: withholding the
 * label is better than inventing one (§5.5.4).
 */
function labelFor(stationCode: string, bearing: number): string | null {
  const corridor = CORRIDOR_DIRECTIONS[STATION_CORRIDORS[String(stationCode).toUpperCase()] ?? ''];
  if (!corridor) return null;

  const along = angleBetween(bearing, corridor.axisBearing);
  if (along <= 60) return corridor.positive;
  if (along >= 120) return corridor.negative;

  // Off-axis: name it on the crossing pair. A corridor running north–south is
  // crossed by oriente/occidente and vice versa.
  const northSouth = corridor.positive === 'norte' || corridor.positive === 'sur';
  const east = Math.sin((bearing * Math.PI) / 180) > 0;
  const north = Math.cos((bearing * Math.PI) / 180) > 0;
  return northSouth ? (east ? 'oriente' : 'occidente') : north ? 'norte' : 'sur';
}

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
function meanCardinal(stationCode: string, bearings: number[]): string | null {
  if (bearings.length === 0) return null;
  let sx = 0;
  let sy = 0;
  for (const deg of bearings) {
    sx += Math.sin((deg * Math.PI) / 180);
    sy += Math.cos((deg * Math.PI) / 180);
  }
  if (Math.hypot(sx, sy) / bearings.length < 0.6) return null;
  const mean = (Math.atan2(sx, sy) * 180) / Math.PI;
  return labelFor(stationCode, (mean + 360) % 360);
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
function splitDirections(stationCode: string, all: Array<{ id: string; deg: number | null; terminates: boolean }>): PlanGroup[] {
  const arrivals = all.filter((e) => e.terminates).map((e) => e.id);
  const entries = all.filter((e) => !e.terminates);
  const tail = (groups: PlanGroup[]): PlanGroup[] =>
    arrivals.length ? [...groups, { sentido: null, arrival: true, ids: arrivals }] : groups;

  const known = entries.filter((e) => e.deg !== null) as Array<{ id: string; deg: number }>;
  const unknown = entries.filter((e) => e.deg === null).map((e) => e.id);
  if (known.length === 0) return tail(entries.length ? [{ sentido: null, ids: entries.map((e) => e.id) }] : []);

  // Group by the NAME each service's heading earns, not by geometry. An earlier
  // version split the vagón on its principal axis and then named each half from
  // its mean, which forced every service on a platform into one of two buckets —
  // so at Museo Nacional the bus that turns west onto Calle 26 was averaged in
  // with the ones climbing Carrera 7 and inherited their "norte". A platform can
  // genuinely send buses three ways, and the name is what a rider reads.
  const byLabel = new Map<string, string[]>();
  for (const e of known) {
    const label = labelFor(stationCode, e.deg) ?? '';
    if (!byLabel.has(label)) byLabel.set(label, []);
    byLabel.get(label)!.push(e.id);
  }

  const out: PlanGroup[] = [...byLabel.entries()].map(([label, ids]) => ({ sentido: label || null, ids }));
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

    const groups = splitDirections(code, scored);
    if (groups.length > 0) plan[wagon] = groups;
  }

  return Object.keys(plan).length > 0 ? plan : undefined;
}
