/**
 * Scheduled service of the SITP zonal routes, from TRANSMILENIO's published
 * GTFS (spec §5.5.10) — the pure half of `sync_gtfs.ts`, which streams the feed
 * in and writes the result.
 *
 * The feed and the catalog cut the network differently, and the join is the
 * whole job:
 *  - A GTFS route is both directions of a service (`CA153` is A153 and C153),
 *    and a GTFS trip is usually the WHOLE ROUND TRIP: CA153's 123 stops are
 *    A153's 68 and then C153's 55, from Nogales de Suba back to it. Trips carry
 *    no `direction_id`, and the names name the códigos only sometimes
 *    (`"A153 Centro || C153 Suba La Gaitana"`, but `"T04" = "Portal Sur ||
 *    Potosí"`), so a trip is cut by WHERE IT STOPS: from its first stop, the
 *    catalog variant it keeps following longest, in that variant's order, is
 *    one piece; the next piece starts where that one stops being followed.
 *  - "In order" is what tells A153 from C153: the two share most stops in
 *    opposite directions. Names only break ties.
 *  - Service ids are day sets: 1 weekdays, 2 Saturday, 4 Sunday — and festivos,
 *    which `calendar_dates` moves onto 4 (and off the rest). Trips use only those
 *    three, so a day type is just the service id.
 *
 * It is the plan, not the operation: what riders see is labelled "programado".
 */

import { destinoDe, type Dia, type Periodo, type SentidoHorario } from '../../../shared/horario_programado.js';

export { destinoDe };
export type { Dia, SentidoHorario };
export const DIA_POR_SERVICIO: Record<string, Dia> = { '1': 'LV', '2': 'S', '4': 'DF' };

/** Periods "every N minutes" is told in, [from, to) in minutes after midnight. */
export const PERIODOS: Array<[number, number]> = [
  [0, 360],
  [360, 540],
  [540, 960],
  [960, 1140],
  [1140, 1320],
  [1320, 1800],
];

/** Stops in a row a piece may pass that its variant does not list (the feed has a few the catalog lacks). */
const MAX_SALTO = 2;
/** A piece shorter than this many matched stops is noise, not a service. */
const MIN_TRAMO = 4;

export interface CatalogVariant {
  codigo: string;
  nombre: string;
  stops: string[];
}

export interface GtfsRoute {
  route_id: string;
  route_short_name?: string;
  route_long_name?: string;
}

export interface GtfsTrip {
  trip_id: string;
  route_id: string;
  service_id: string;
}

export interface GtfsZonalReport {
  trips: number;
  /** Stop visits across those trips, and how many fell in a piece some variant claimed. */
  stops: number;
  stopsPlaced: number;
  patterns: number;
  /** GTFS routes with trips that left over a fifth of their stops unplaced, and how many. */
  unmatchedRoutes: Record<string, number>;
}

/** The códigos a GTFS route's own names spell out: `CA153` + "A153 Centro || C153 …". */
export function namedCodigos(route: GtfsRoute): Set<string> {
  const out = new Set<string>();
  const short = String(route.route_short_name ?? '').trim().toUpperCase();
  if (short) out.add(short);
  for (const half of String(route.route_long_name ?? '').split('||')) {
    const m = /^\s*([A-Z]{0,2}\d+[A-Z]?|\d+-\d+)\s/i.exec(half);
    if (m) out.add(m[1].toUpperCase());
  }
  return out;
}

interface VariantIndex {
  variants: CatalogVariant[];
  /** Stop code → [variant, its first position there]. */
  byStop: Map<string, Array<[number, number]>>;
  /** Per variant, stop code → its first position. */
  positions: Array<Map<string, number>>;
}

export function indexVariants(variants: CatalogVariant[]): VariantIndex {
  const byStop = new Map<string, Array<[number, number]>>();
  const positions = variants.map((variant, vi) => {
    const at = new Map<string, number>();
    variant.stops.forEach((stop, pos) => {
      // A loop passes a stop twice; its first visit is the one the order test reads.
      if (at.has(stop)) return;
      at.set(stop, pos);
      let list = byStop.get(stop);
      if (!list) byStop.set(stop, (list = []));
      list.push([vi, pos]);
    });
    return at;
  });
  return { variants, byStop, positions };
}

/** One direction of a trip: stops `from`..`to` (inclusive) of its sequence, run as variant `vi`. */
export interface Tramo {
  from: number;
  to: number;
  vi: number;
}

/**
 * Cuts a trip's stop sequence into the variants it runs, in turn. From each
 * start, every variant that stops there is followed forward — a stop counts
 * when the variant lists it further along than the last — until it is lost for
 * more than `MAX_SALTO` stops; the one followed for most stops is the piece.
 */
export function segmentPattern(pattern: string[], index: VariantIndex, named: Set<string>): Tramo[] {
  // Where the route's names are catalog códigos, only those are candidates: on a
  // shared street another código follows the trip just as long, and would take
  // its departures (731 had half again as many as it runs). Names that match
  // nothing in the catalog leave every variant in play.
  const restrict = index.variants.some((v) => named.has(v.codigo.toUpperCase()));
  const out: Tramo[] = [];
  let start = 0;
  while (start < pattern.length - 1) {
    let best: { vi: number; to: number; hits: number; isNamed: boolean; share: number } | null = null;
    for (const [vi, firstPos] of index.byStop.get(pattern[start]) ?? []) {
      const variant = index.variants[vi];
      if (restrict && !named.has(variant.codigo.toUpperCase())) continue;
      const at = index.positions[vi];
      let last = firstPos;
      let to = start;
      let hits = 1;
      let missed = 0;
      for (let j = start + 1; j < pattern.length && missed <= MAX_SALTO; j++) {
        const pos = at.get(pattern[j]);
        if (pos !== undefined && pos > last) {
          last = pos;
          to = j;
          hits++;
          missed = 0;
        } else missed++;
      }
      const candidate = { vi, to, hits, isNamed: named.has(variant.codigo.toUpperCase()), share: hits / variant.stops.length };
      if (
        !best ||
        candidate.hits > best.hits ||
        (candidate.hits === best.hits &&
          (candidate.isNamed !== best.isNamed ? candidate.isNamed : candidate.share > best.share))
      ) {
        best = candidate;
      }
    }
    if (best && best.hits >= MIN_TRAMO) {
      out.push({ from: start, to: best.to, vi: best.vi });
      // The turnaround stop ends one direction and starts the next.
      start = best.to;
    } else {
      start++;
    }
  }
  return out;
}

/** "HH:MM:SS", hours past 24 allowed, as whole minutes. */
export function gtfsMinutes(value: string): number {
  const [h, m] = value.split(':');
  return Number(h) * 60 + Number(m);
}

function quartiles(sorted: number[]): [number, number] {
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1) + 0.5))];
  return [Math.max(1, Math.round(at(0.25))), Math.max(1, Math.round(at(0.75)))];
}

/**
 * Where a direction's departures are counted: its first paradero that at
 * least half as many buses pass as its busiest one. Not wherever a trip
 * happens to begin — a bus entering service from the depot starts mid-route,
 * and counting that start as a departure ran A302's last bus to 23:57 against
 * the 22:00 TRANSMILENIO's own cabecera table gives. Not blindly the first
 * paradero either: the catalog lists a few terminal-loop stops the feed never
 * serves (731 towards Bosa San José).
 */
export function referencia(visits: number[][]): number {
  const most = Math.max(...visits.map((v) => v.length));
  return visits.findIndex((v) => v.length >= most / 2);
}

/** Each period's departures and usual gap, from a day's sorted departures. */
export function cadaPorPeriodo(departures: number[]): Array<Periodo | null> {
  return PERIODOS.map(([from, to]) => {
    let n = 0;
    const gaps: number[] = [];
    departures.forEach((d, i) => {
      if (d < from || d >= to) return;
      n++;
      if (i > 0) gaps.push(d - departures[i - 1]);
    });
    if (!n) return null;
    return gaps.length ? [n, ...quartiles(gaps.sort((a, b) => a - b))] : [n, null, null];
  });
}

/**
 * Collects `stop_times` rows one at a time — the file is 9.5 M rows in no
 * order, so it is held as four integer columns, never as objects — and builds
 * every zonal código's schedule from them.
 */
export function createGtfsZonalBuilder(trips: GtfsTrip[], stopCode: (stopId: string) => string | undefined) {
  const tripIndex = new Map<string, number>();
  trips.forEach((trip, i) => tripIndex.set(trip.trip_id, i));
  const stopIds = new Map<string, number>();
  const stopNames: string[] = [];

  let size = 0;
  let cap = 1 << 20;
  let colTrip = new Int32Array(cap);
  let colSeq = new Int32Array(cap);
  let colStop = new Int32Array(cap);
  let colTime = new Int32Array(cap);
  const grow = () => {
    cap *= 2;
    const more = (old: Int32Array) => {
      const next = new Int32Array(cap);
      next.set(old);
      return next;
    };
    colTrip = more(colTrip);
    colSeq = more(colSeq);
    colStop = more(colStop);
    colTime = more(colTime);
  };

  return {
    /** One `stop_times` row; rows of trips not handed in are skipped. */
    add(tripId: string, stopId: string, sequence: number, minutes: number): void {
      const t = tripIndex.get(tripId);
      if (t === undefined) return;
      const code = stopCode(stopId);
      if (!code) return;
      let s = stopIds.get(code);
      if (s === undefined) {
        s = stopNames.length;
        stopIds.set(code, s);
        stopNames.push(code);
      }
      if (size === cap) grow();
      colTrip[size] = t;
      colSeq[size] = sequence;
      colStop[size] = s;
      colTime[size] = minutes;
      size++;
    },

    build(routes: GtfsRoute[], variants: CatalogVariant[]): { rutas: Record<string, SentidoHorario[]>; report: GtfsZonalReport } {
      // Rows by trip (counting sort), then each trip's rows by stop_sequence.
      const offsets = new Int32Array(trips.length + 1);
      for (let i = 0; i < size; i++) offsets[colTrip[i] + 1]++;
      for (let t = 0; t < trips.length; t++) offsets[t + 1] += offsets[t];
      const fill = offsets.slice(0, trips.length);
      const order = new Int32Array(size);
      for (let i = 0; i < size; i++) order[fill[colTrip[i]]++] = i;
      const rowsOf = (t: number): number[] =>
        Array.from(order.subarray(offsets[t], offsets[t + 1])).sort((a, b) => colSeq[a] - colSeq[b]);

      const index = indexVariants(variants);
      const routeById = new Map(routes.map((r) => [r.route_id, r]));
      const namedByRoute = new Map<string, Set<string>>();
      const tramosByPattern = new Map<string, Tramo[]>();
      const tripTramos: Array<Tramo[] | undefined> = new Array(trips.length);
      const report: GtfsZonalReport = { trips: 0, stops: 0, stopsPlaced: 0, patterns: 0, unmatchedRoutes: {} };

      for (let t = 0; t < trips.length; t++) {
        if (offsets[t + 1] === offsets[t]) continue;
        report.trips++;
        const trip = trips[t];
        const rows = rowsOf(t);
        const key = trip.route_id + '|' + rows.map((r) => colStop[r]).join('.');
        let tramos = tramosByPattern.get(key);
        if (!tramos) {
          let named = namedByRoute.get(trip.route_id);
          if (!named) namedByRoute.set(trip.route_id, (named = namedCodigos(routeById.get(trip.route_id) ?? { route_id: trip.route_id })));
          tramos = segmentPattern(rows.map((r) => stopNames[colStop[r]]), index, named);
          tramosByPattern.set(key, tramos);
          report.patterns++;
        }
        tripTramos[t] = tramos;
        // A turnaround stop closes one piece and opens the next: count it once.
        const placed = new Set(tramos.flatMap((p) => Array.from({ length: p.to - p.from + 1 }, (_, i) => p.from + i))).size;
        report.stops += rows.length;
        report.stopsPlaced += placed;
        if (placed < rows.length * 0.8) {
          const name = routeById.get(trip.route_id)?.route_short_name || trip.route_id;
          report.unmatchedRoutes[name] = (report.unmatchedRoutes[name] ?? 0) + 1;
        }
      }

      // Per código, the variant most of its pieces follow gives the stop order.
      // A direction is código + destination; the variant most pieces follow gives its stop order.
      const sentidoOf = (vi: number) => `${variants[vi].codigo}\u0000${destinoDe(variants[vi].nombre)}`;
      const tripsByVariant = new Map<number, number>();
      for (const tramos of tripTramos) for (const p of tramos ?? []) tripsByVariant.set(p.vi, (tripsByVariant.get(p.vi) ?? 0) + 1);
      const dominant = new Map<string, number>();
      const piecesBySentido = new Map<string, number>();
      for (const [vi, n] of tripsByVariant) {
        const key = sentidoOf(vi);
        piecesBySentido.set(key, (piecesBySentido.get(key) ?? 0) + n);
        const current = dominant.get(key);
        if (current === undefined || n > (tripsByVariant.get(current) ?? 0)) dominant.set(key, vi);
      }

      interface Acc {
        /** Per `paradas` position, every scheduled pass that day. */
        visits: number[][];
      }
      const acc = new Map<string, Partial<Record<Dia, Acc>>>();
      const posIn = new Map<number, Map<number, number>>();
      for (let t = 0; t < trips.length; t++) {
        const tramos = tripTramos[t];
        const dia = DIA_POR_SERVICIO[trips[t].service_id];
        if (!tramos?.length || !dia) continue;
        const rows = rowsOf(t);
        for (const tramo of tramos) {
          const codigo = sentidoOf(tramo.vi);
          const main = dominant.get(codigo)!;
          let positions = posIn.get(main);
          if (!positions) {
            positions = new Map();
            variants[main].stops.forEach((stop, pos) => {
              const s = stopIds.get(stop);
              if (s !== undefined && !positions!.has(s)) positions!.set(s, pos);
            });
            posIn.set(main, positions);
          }
          let byDia = acc.get(codigo);
          if (!byDia) acc.set(codigo, (byDia = {}));
          const day = (byDia[dia] ??= { visits: variants[main].stops.map(() => []) });
          for (let i = tramo.from; i <= tramo.to; i++) {
            const pos = positions.get(colStop[rows[i]]);
            if (pos !== undefined) day.visits[pos].push(colTime[rows[i]]);
          }
        }
      }

      const rutas: Record<string, SentidoHorario[]> = {};
      // Busiest direction first within a código; códigos in reading order.
      const keys = [...acc.keys()].sort((a, b) => (piecesBySentido.get(b) ?? 0) - (piecesBySentido.get(a) ?? 0));
      for (const key of keys) {
        const dias: SentidoHorario['dias'] = {};
        for (const [dia, day] of Object.entries(acc.get(key)!) as Array<[Dia, Acc]>) {
          const desde = referencia(day.visits);
          const departures = day.visits[desde].sort((a, b) => a - b);
          dias[dia] = {
            desde,
            salidas: departures.length,
            primera: departures[0],
            ultima: departures[departures.length - 1],
            cada: cadaPorPeriodo(departures),
            pasos: day.visits.map((times) => (times.length ? [Math.min(...times), Math.max(...times)] : null)),
          };
        }
        const main = variants[dominant.get(key)!];
        (rutas[main.codigo] ??= []).push({ destino: destinoDe(main.nombre), paradas: main.stops, dias });
      }
      const ordered: Record<string, SentidoHorario[]> = {};
      for (const codigo of Object.keys(rutas).sort((a, b) => a.localeCompare(b, 'es', { numeric: true }))) ordered[codigo] = rutas[codigo];
      return { rutas: ordered, report };
    },
  };
}
