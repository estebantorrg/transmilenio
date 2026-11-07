/**
 * Troncal ride speeds from TRANSMILENIO's published schedule (spec §5.6.5), the
 * pure half of `sync_troncal_speeds.ts`.
 *
 * The zonal fleet's speeds were measured from its GPS (`scripts/calibration`);
 * nothing like that exists for the troncal, so its edges ran on one constant —
 * 34 km/h cruise plus half a minute a stop — that made every troncal ride
 * 28–31 km/h. Followed live, the troncal makes 16–22 km/h on a weekday morning
 * (`scratch/live-spike`, 2026-10-05), and the GTFS schedule agrees with that to
 * ~10 % on every route measured, where the constant was 1.4–1.7× too fast. So
 * the schedule is the troncal's measurement: per stretch between consecutive
 * served stops, one base speed, and one troncal-wide multiplier per day type and
 * hour — the same shape as the zonal file, so the planner reads both alike.
 */

export type DayType = 'H' | 'S' | 'F';
const DAY_TYPES: DayType[] = ['H', 'S', 'F'];

/** One scheduled call of a trip: where (catalog código), when (s after the service day's midnight), how far along (m). */
export interface ScheduledCall {
  seq: number;
  code: string;
  seconds: number;
  /** `shape_dist_traveled`, metres; NaN when the feed leaves it out. */
  dist: number;
  lat: number;
  lon: number;
}

export interface TroncalSpeeds {
  /** from código → to código → base speed, km/h (weekday 06–20 h median). */
  pairs: Record<string, Record<string, number>>;
  /** Day type → 24 hourly multipliers on the base speed; 0 = no scheduled troncal service that hour. */
  factor: Record<DayType, number[]>;
}

/** Feed glitches: two calls at one minute over kilometres, or a "stretch" back up the line. */
const MIN_KMH = 4;
const MAX_KMH = 80;
const MIN_METERS = 50;
/** The base is the working day the planner is asked about most. */
const BASE_HOURS: [number, number] = [6, 20];

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function haversine(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const r = Math.PI / 180;
  const a = Math.sin(((lat2 - lat1) * r) / 2) ** 2 +
    Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(((lon2 - lon1) * r) / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.sqrt(a));
}

/**
 * Accumulates scheduled trips and returns per-stretch base speeds and the
 * troncal's hourly profile. `dayTypes` is what the trip's service runs on.
 */
export function createTroncalSpeedBuilder() {
  // pair → day type → hour → km/h samples
  const samples = new Map<string, Record<DayType, number[][]>>();

  function addTrip(calls: ScheduledCall[], dayTypes: DayType[]): void {
    if (dayTypes.length === 0 || calls.length < 2) return;
    const ordered = [...calls].sort((a, b) => a.seq - b.seq);
    for (let i = 0; i + 1 < ordered.length; i++) {
      const a = ordered[i];
      const b = ordered[i + 1];
      if (!a.code || !b.code || a.code === b.code) continue;
      const seconds = b.seconds - a.seconds; // departure to departure: the dwell at `b` is part of the ride, as on a zonal stretch
      const fromShape = b.dist - a.dist;
      const meters = Number.isFinite(fromShape) && fromShape > 0 ? fromShape : haversine(a.lat, a.lon, b.lat, b.lon);
      if (!(seconds > 0) || meters < MIN_METERS) continue;
      const kmh = (meters / 1000) / (seconds / 3600);
      if (kmh < MIN_KMH || kmh > MAX_KMH) continue;
      const key = `${a.code}>${b.code}`;
      let byDay = samples.get(key);
      if (!byDay) {
        byDay = { H: [], S: [], F: [] };
        samples.set(key, byDay);
      }
      const hour = Math.floor(a.seconds / 3600) % 24;
      for (const day of dayTypes) (byDay[day][hour] ??= []).push(kmh);
    }
  }

  function build(): TroncalSpeeds {
    const pairs: Record<string, Record<string, number>> = {};
    const ratios: Record<DayType, number[][]> = { H: [], S: [], F: [] };
    for (const [key, byDay] of samples) {
      const working = byDay.H.slice(BASE_HOURS[0], BASE_HOURS[1] + 1).flat().filter(Boolean);
      const all = DAY_TYPES.flatMap((d) => byDay[d].flat().filter(Boolean));
      const pool = working.length ? working : all;
      if (pool.length === 0) continue;
      const base = median(pool);
      const [from, to] = key.split('>');
      (pairs[from] ??= {})[to] = Math.round(base * 10) / 10;
      for (const day of DAY_TYPES) {
        byDay[day].forEach((hourSamples, hour) => {
          if (hourSamples?.length) (ratios[day][hour] ??= []).push(median(hourSamples) / base);
        });
      }
    }
    const factor = {} as Record<DayType, number[]>;
    for (const day of DAY_TYPES) {
      factor[day] = Array.from({ length: 24 }, (_, hour) =>
        ratios[day][hour]?.length ? Math.round(median(ratios[day][hour]) * 1000) / 1000 : 0
      );
    }
    return { pairs, factor };
  }

  return { addTrip, build };
}

/** Which day types a GTFS `calendar.txt` row runs on. */
export function dayTypesOf(row: Record<string, string>): DayType[] {
  const on = (day: string) => row[day] === '1';
  const out: DayType[] = [];
  if (['monday', 'tuesday', 'wednesday', 'thursday', 'friday'].some(on)) out.push('H');
  if (on('saturday')) out.push('S');
  if (on('sunday')) out.push('F');
  return out;
}

export interface RegistryStation {
  nodo: string;
  lat: number;
  lon: number;
}

/**
 * GTFS stop → the catalog código its calls are filed under. A troncal platform
 * is its station: the feed's `parent_station` is the station's ArcGIS node
 * (TRANSMILENIO's answer to petición B), which `troncal_stations.json` keys by
 * catalog código; stations the register files under a newer node (Portal Usme,
 * the Soacha extension…) are matched to the nearest register station within
 * `maxMeters`. Past both, a station whose feed id is the number of a catalog
 * `TM…` código is that station: the newest ones (Danubio 90008, Calle 53 – UMB
 * 90012) sit 360 m from their register point or outside the register, and on
 * every 9000x station checked the two agree. A street stop is its cenefa,
 * without the feed's `_TM` suffix.
 */
export function stopCodeResolver(
  stops: Array<Record<string, string>>,
  registry: Record<string, RegistryStation>,
  catalogCodes: Set<string> = new Set(),
  maxMeters = 250
): Map<string, string> {
  const byNodo = new Map(Object.entries(registry).map(([code, s]) => [String(Number(s.nodo)), code]));
  const stations = new Map(stops.filter((s) => s.location_type === '1').map((s) => [s.stop_id, s]));
  const stationCode = new Map<string, string | null>();
  const codeOfStation = (id: string): string | null => {
    if (stationCode.has(id)) return stationCode.get(id)!;
    let code = byNodo.get(String(Number(id))) ?? null;
    const row = stations.get(id);
    if (!code && row) {
      const lat = Number(row.stop_lat);
      const lon = Number(row.stop_lon);
      let best = maxMeters;
      for (const [candidate, s] of Object.entries(registry)) {
        const d = haversine(lat, lon, s.lat, s.lon);
        if (d < best) {
          best = d;
          code = candidate;
        }
      }
    }
    if (!code && catalogCodes.has(`TM${Number(id)}`)) code = `TM${Number(id)}`;
    stationCode.set(id, code);
    return code;
  };

  const out = new Map<string, string>();
  for (const s of stops) {
    const code = s.parent_station ? codeOfStation(s.parent_station) : s.stop_code.trim().replace(/_TM$/i, '');
    if (code) out.set(s.stop_id, code);
  }
  return out;
}
