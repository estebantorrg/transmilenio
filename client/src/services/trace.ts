/**
 * Route traces as the spine of the network (spec §5.6.3).
 *
 * Every route variant in the catalog ships `trazado` — the real driven polyline
 * (99.0% of the 1031 presented routes have one, and the catalog's own stops sit
 * on it to a median of 4 m). The planner used to ignore it twice over:
 *
 *   1. **Cost.** A ride leg was charged the straight-line distance between two
 *      consecutive stops. Measured against the trace, that under-counts the
 *      metres a bus actually drives by 7% (troncal median) and 11% (zonal
 *      median) — but the error is not a constant: it spans 1.00×–2.06× per
 *      route. A winding SITP loop was therefore priced like a straight avenue
 *      and won rankings it should have lost. A single calibration constant
 *      cannot absorb a spread like that; only the trace can.
 *   2. **Geometry.** The drawn leg was cut out of the trace by *nearest vertex*.
 *      On the browser's catalog (traces capped for transport, §5.1.4) vertices
 *      are hundreds of metres apart, so the ride polyline began a mean 305 m —
 *      and up to 1.4 km — away from the station the rider boards at, leaving a
 *      visible gap between the walking leg and the bus leg on the map.
 *
 * This module fixes both at the root: each route's stops are projected **once**
 * onto its own trace, in order, and everything downstream reads that index —
 * distances are along-the-line differences, geometry is a slice between two
 * projected points, and both are O(1) per leg instead of a full scan per step.
 *
 * The projection is monotone by construction (stop *k+1* may not land before
 * stop *k*), because the alternative — independent nearest-point snapping — is
 * exactly what breaks on the loop routes that make up most of the SITP network,
 * where the outbound and return legs run down the same street metres apart.
 *
 * Every index is gated before it is trusted (`buildTraceIndex` returns `null`
 * on failure), so a route whose trace and stop list genuinely disagree keeps the
 * old straight-line behaviour instead of getting a confidently wrong answer
 * (spec §1 certainty, §4.2 graceful degradation).
 */

import { haversineMeters } from '../utils/geo';

export type LngLat = [number, number];

export interface TraceIndex {
  /** The route's trace, stitched into one polyline in riding order. */
  line: LngLat[];
  /** `cumulative[i]` = metres along `line` from its start to vertex `i`. */
  cumulative: Float64Array;
  /** `stopAlong[k]` = metres along `line` where the route's stop `k` sits. */
  stopAlong: Float64Array;
  /** `stopSeg[k]` = index of the `line` segment stop `k` projects onto. */
  stopSeg: Int32Array;
  /** `stopPoint[k]` = the stop's exact projection onto `line`. */
  stopPoint: LngLat[];
  /**
   * `1` when stop `k` genuinely sits on this trace. A `0` disables only the two
   * legs that touch it — the rest of the route still rides its own trace.
   */
  stopOk: Uint8Array;
  /** Largest perpendicular projection error over the matched stops, in metres. */
  maxError: number;
  /** How many stops did not match the trace. */
  unmatched: number;
}

/**
 * A stop may sit slightly "behind" the previous one — opposite kerbs of the same
 * street project onto the line in either order. Tolerated; anything larger is a
 * genuine backtrack and the projection must move forward instead.
 */
const BACKTRACK_TOLERANCE_M = 30;

/**
 * A stop further than this from its own route's trace means the two do not
 * describe the same journey (a stale trace, a merged variant, an upstream
 * mismatch), and the leg falls back to the straight line.
 *
 * It also bounds the visible defect, because a stop matched at the limit is a
 * drawn ride leg that begins that far from the station. Measured over the
 * committed catalog, trace coverage is flat at 93.1% of ride legs anywhere in
 * 80–220 m — the per-leg gating absorbs the difference — while the worst drawn
 * gap tracks the tolerance one-for-one (160 → 158 m, 100 → 99 m). So this is
 * set by what may appear on the map, not by what it costs in coverage; the
 * headroom over the 17 m 99th percentile still covers a platform whose pin sits
 * off the busway.
 */
const MAX_SNAP_ERROR_M = 100;

/**
 * The projected span between the first and last stop, compared with the
 * straight-line stop chain. Below the floor the projection collapsed (every
 * stop landed on the same piece of line); above the ceiling it ran the long way
 * around a loop. Observed range on the real catalog: 1.00×–2.06×.
 */
const MIN_SPAN_RATIO = 0.75;
const MAX_SPAN_RATIO = 3;

/**
 * Below this share of stops matched, the polyline is not this route's journey at
 * all and the whole index is refused. Above it the trace is real and the odd
 * stray stop only costs its own two legs.
 */
const MIN_MATCHED_FRACTION = 0.6;

/** Vertices closer than this at a joint between two trace pieces are one point. */
const JOINT_WELD_M = 1;

/**
 * Search cut-off for the projection scan. A stop already matched to within
 * `CONFIDENT_SNAP_M` stops the scan `SCAN_LOOKAHEAD_M` further down the line;
 * without it every stop scans the remainder of its route's trace and building
 * the index over the whole catalog becomes quadratic. Both are far outside the
 * distribution the catalog produces (99th percentile snap error: 17 m).
 */
const CONFIDENT_SNAP_M = 60;
const SCAN_LOOKAHEAD_M = 800;

function isLngLat(value: unknown): value is number[] {
  return (
    Array.isArray(value) &&
    value.length >= 2 &&
    Number.isFinite(Number(value[0])) &&
    Number.isFinite(Number(value[1]))
  );
}

/**
 * Normalises the catalog's LineString / MultiLineString shapes to usable lines.
 *
 * A path that needs no normalising is handed back **as it came**, not copied.
 * The index is built for every route in the catalog and the map layer keeps the
 * originals alive regardless, so copying by default duplicated 156 000
 * coordinate pairs and cost ~10 MB of heap on a phone for nothing. Nothing
 * downstream mutates these arrays — `stitchPaths`, `orientLineToStops` and
 * `rotateLoopToFirstStop` each build a new array whenever they change anything.
 */
export function tracePaths(paths: number[][][] | undefined | null): LngLat[][] {
  if (!Array.isArray(paths)) return [];
  const out: LngLat[][] = [];
  for (const path of paths) {
    if (!Array.isArray(path)) continue;

    let clean = path.length > 1;
    for (let i = 0; clean && i < path.length; i++) {
      const point = path[i];
      if (!isLngLat(point) || typeof point[0] !== 'number' || typeof point[1] !== 'number') clean = false;
      else {
        const previous = path[i - 1];
        if (previous && previous[0] === point[0] && previous[1] === point[1]) clean = false;
      }
    }
    if (clean) {
      out.push(path as LngLat[]);
      continue;
    }

    const line: LngLat[] = [];
    for (const point of path) {
      if (!isLngLat(point)) continue;
      const lng = Number(point[0]);
      const lat = Number(point[1]);
      // Drop repeated vertices — they add segments of length zero, which carry
      // no shape and only cost projection work.
      const last = line[line.length - 1];
      if (last && last[0] === lng && last[1] === lat) continue;
      line.push([lng, lat]);
    }
    if (line.length > 1) out.push(line);
  }
  return out;
}

/**
 * Stitches a MultiLineString into one riding-order polyline. 8.9% of traced
 * routes ship several pieces.
 *
 * The catalog's own order is kept — it comes from the same `infoRuta` payload
 * that ordered the stops, so it is evidence, not noise. Only the *orientation*
 * of each following piece is decided here, by whichever end continues from
 * where the previous piece stopped. An earlier version instead chose the piece
 * nearest the first stop and worked outwards; on a route whose stop list starts
 * mid-line that reordered the trace into a journey nobody drives, and four in
 * ten multi-path routes lost their trace to it.
 *
 * **Not every joint is a joint.** Measured over the committed catalog, 31 of 109
 * joints are wider than 200 m and five are over a kilometre: those pieces are
 * disjoint branches, not a line cut in two. Welding them anyway invents a
 * straight segment kilometres long, and because ride distance is read off this
 * line, that phantom is charged to any leg spanning it and drawn across the map.
 * So the pieces are split into runs at every wide joint and the **longest run
 * wins**; stops on the discarded branches simply fail the per-stop gate and
 * their legs fall back to the straight line. Part of a route's trace is worth
 * more than all of it plus a fiction.
 */
const MAX_JOINT_GAP_M = 200;

function stitchPaths(paths: LngLat[][]): LngLat[] {
  if (paths.length === 1) return paths[0];

  const runs: LngLat[][] = [];
  let line: LngLat[] = paths[0].slice();

  for (let p = 1; p < paths.length; p++) {
    const piece = paths[p];
    const tail = line[line.length - 1];
    const headGap = haversineMeters(tail, piece[0]);
    const tailGap = haversineMeters(tail, piece[piece.length - 1]);
    const reversed = tailGap < headGap;
    const oriented = reversed ? [...piece].reverse() : piece;
    const gap = reversed ? tailGap : headGap;

    if (gap > MAX_JOINT_GAP_M) {
      runs.push(line);
      line = oriented.slice();
      continue;
    }

    // Weld a true joint so the line carries no duplicate vertex.
    const start = gap < JOINT_WELD_M ? 1 : 0;
    for (let i = start; i < oriented.length; i++) line.push(oriented[i]);
  }
  runs.push(line);

  if (runs.length === 1) return runs[0];

  let best = runs[0];
  let bestLength = -1;
  for (const run of runs) {
    let length = 0;
    for (let i = 0; i < run.length - 1; i++) length += haversineMeters(run[i], run[i + 1]);
    if (length > bestLength) { bestLength = length; best = run; }
  }
  return best;
}

/**
 * Reverses the trace when the route's stops run backwards along it. Direction is
 * not recoverable from the polyline alone — the catalog stores one `trazado` per
 * variant but does not promise it points the way the variant is ridden — so the
 * stops decide: a handful of them, projected independently and read in order,
 * either climb the line or descend it.
 */
function orientLineToStops(line: LngLat[], stops: ReadonlyArray<{ coordinate: LngLat }>): LngLat[] {
  const samples = Math.min(stops.length, 12);
  if (samples < 3 || line.length < 4) return line;

  const positions: number[] = [];
  for (let s = 0; s < samples; s++) {
    const stop = stops[Math.round((s * (stops.length - 1)) / (samples - 1))].coordinate;
    let bestSeg = 0;
    let bestDist = Infinity;
    for (let i = 0; i < line.length - 1; i++) {
      const d = roughSegmentDistance(stop, line[i], line[i + 1]);
      if (d < bestDist) { bestDist = d; bestSeg = i; }
    }
    positions.push(bestSeg);
  }

  let forward = 0;
  let backward = 0;
  for (let i = 0; i < positions.length - 1; i++) {
    if (positions[i + 1] > positions[i]) forward++;
    else if (positions[i + 1] < positions[i]) backward++;
  }
  return backward > forward ? [...line].reverse() : line;
}

/**
 * A trace whose two ends meet is a **loop**, and the catalog does not promise
 * that the stop list starts where the polyline does: measured on the committed
 * catalog, route 97's first stop sits 26.2 km into its own 45.3 km trace, and
 * route 91's 30.3 km into 60.8 km. Read forwards from vertex zero, every stop
 * before the wrap looks like a backtrack and gets rejected. Rotating the loop to
 * begin at the first stop makes the whole ride monotone again.
 *
 * `CLOSURE_M` is what counts as "the two ends meet" — generous, because an
 * out-and-back trace closes at a terminal loop rather than at a point.
 */
const CLOSURE_M = 400;

interface Projection {
  seg: number;
  along: number;
  error: number;
  point: LngLat;
}

/**
 * Projects `point` onto the segment `line[i] → line[i+1]`, in a local planar
 * frame (Bogotá spans 0.3° — the cosine correction is exact enough that the
 * projected parameter differs from the geodesic one far below the metre).
 */
function projectOnSegment(point: LngLat, line: LngLat[], i: number, cumulative: Float64Array): Projection {
  const a = line[i];
  const b = line[i + 1];
  const cosLat = Math.cos((a[1] * Math.PI) / 180);
  const bx = (b[0] - a[0]) * cosLat;
  const by = b[1] - a[1];
  const px = (point[0] - a[0]) * cosLat;
  const py = point[1] - a[1];
  const denom = bx * bx + by * by;
  let t = denom === 0 ? 0 : (px * bx + py * by) / denom;
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  const projected: LngLat = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  return {
    seg: i,
    along: cumulative[i] + (cumulative[i + 1] - cumulative[i]) * t,
    error: haversineMeters(point, projected),
    point: projected,
  };
}

/**
 * Squared planar distance from `point` to segment `a→b`, in degrees² with the
 * longitude axis scaled to metres-equivalent. Only used to *compare* candidates,
 * never reported, so the cheap form is enough — and it keeps the loop-rotation
 * scan off the trigonometry that a full projection would pay per segment.
 */
function roughSegmentDistance(point: LngLat, a: LngLat, b: LngLat): number {
  const cosLat = Math.cos((a[1] * Math.PI) / 180);
  const bx = (b[0] - a[0]) * cosLat;
  const by = b[1] - a[1];
  const px = (point[0] - a[0]) * cosLat;
  const py = point[1] - a[1];
  const denom = bx * bx + by * by;
  let t = denom === 0 ? 0 : (px * bx + py * by) / denom;
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  const dx = px - bx * t;
  const dy = py - by * t;
  return dx * dx + dy * dy;
}

/**
 * Rotates a closed trace so it begins at the segment nearest the route's first
 * stop. A no-op on an open trace, and on a loop the stop list already starts at
 * the top of (see `CLOSURE_M`).
 */
function rotateLoopToFirstStop(line: LngLat[], firstStop: LngLat): LngLat[] {
  if (line.length < 4) return line;
  if (haversineMeters(line[0], line[line.length - 1]) > CLOSURE_M) return line;

  let bestSeg = 0;
  let bestDist = Infinity;
  for (let i = 0; i < line.length - 1; i++) {
    const d = roughSegmentDistance(firstStop, line[i], line[i + 1]);
    if (d < bestDist) { bestDist = d; bestSeg = i; }
  }
  if (bestSeg === 0) return line;

  // Re-cut the ring at `bestSeg` and close it again on that same vertex, so the
  // rotated line covers exactly the same ground and still ends where it starts.
  return [...line.slice(bestSeg, line.length - 1), ...line.slice(0, bestSeg + 1)];
}

/**
 * Why a route's stops could not be projected onto its trace. Reported through
 * the optional out-param so a diagnostic run (or a test) can tell "this route
 * ships no trace" from "this route's trace disagrees with its own stops",
 * instead of both surfacing as a silent fallback to straight lines.
 */
export type TraceIndexFailure = 'no-stops' | 'no-trace' | 'degenerate' | 'snap-error' | 'span';

/**
 * Builds the projection index for one route, or returns `null` when the trace
 * and the stop list do not describe the same journey (see the gates above).
 */
export function buildTraceIndex(
  stops: ReadonlyArray<{ coordinate: LngLat }>,
  paths: number[][][] | undefined | null,
  out?: { failure?: TraceIndexFailure; worstError?: number }
): TraceIndex | null {
  const fail = (reason: TraceIndexFailure, worstError?: number): null => {
    if (out) {
      out.failure = reason;
      if (worstError !== undefined) out.worstError = worstError;
    }
    return null;
  };

  if (!stops || stops.length < 2) return fail('no-stops');
  const pieces = tracePaths(paths);
  if (pieces.length === 0) return fail('no-trace');

  // Stitch the pieces, point the result the way the route is ridden, then bring
  // the loop's start to the first stop. Order matters: rotating a backwards line
  // only moves the problem.
  const line = rotateLoopToFirstStop(orientLineToStops(stitchPaths(pieces), stops), stops[0].coordinate);
  if (line.length < 2) return fail('degenerate');

  const cumulative = new Float64Array(line.length);
  for (let i = 0; i < line.length - 1; i++) {
    cumulative[i + 1] = cumulative[i] + haversineMeters(line[i], line[i + 1]);
  }
  const total = cumulative[line.length - 1];
  if (!(total > 0)) return fail('degenerate');

  const stopAlong = new Float64Array(stops.length);
  const stopSeg = new Int32Array(stops.length);
  const stopPoint: LngLat[] = new Array(stops.length);
  const stopOk = new Uint8Array(stops.length);
  let maxError = 0;
  let unmatched = 0;
  let floor = 0;

  for (let k = 0; k < stops.length; k++) {
    const coordinate = stops[k].coordinate;

    // Start where the previous stop landed, backed off far enough to cover the
    // tolerated backtrack — everything before that is unreachable by definition,
    // so the whole pass stays linear in the trace rather than quadratic.
    let startSeg = k === 0 ? 0 : stopSeg[k - 1];
    while (startSeg > 0 && cumulative[startSeg] > floor - BACKTRACK_TOLERANCE_M) startSeg--;

    let best: Projection | null = null;
    for (let i = startSeg; i < line.length - 1; i++) {
      if (cumulative[i + 1] < floor - BACKTRACK_TOLERANCE_M) continue;
      // Once a clean projection is in hand, the rest of the line cannot beat it:
      // stop scanning a 30 km trace to place a stop already matched to metres.
      if (best && best.error <= CONFIDENT_SNAP_M && cumulative[i] > best.along + SCAN_LOOKAHEAD_M) break;
      const candidate = projectOnSegment(coordinate, line, i, cumulative);
      if (candidate.along < floor - BACKTRACK_TOLERANCE_M) continue;
      if (!best || candidate.error < best.error) best = candidate;
    }

    // Nothing ahead of the floor (a stop past the end of the trace): fall back
    // to the closest point anywhere on the line and let the error gate judge it.
    if (!best) {
      for (let i = 0; i < line.length - 1; i++) {
        const candidate = projectOnSegment(coordinate, line, i, cumulative);
        if (!best || candidate.error < best.error) best = candidate;
      }
    }

    const chosen = best;
    if (!chosen) return fail('degenerate');

    stopAlong[k] = chosen.along;
    stopSeg[k] = chosen.seg;
    stopPoint[k] = chosen.point;

    // Per-stop, not per-route. One stop that does not sit on this trace is
    // ordinary catalog noise (a variant merged with another's `trazado`, an
    // upstream edit); rejecting the whole route for it threw away every other
    // leg too, and cost 183 of the 1031 routes their trace outright. A stop
    // that fails here only disables the two legs touching it.
    if (chosen.error > MAX_SNAP_ERROR_M) {
      // The floor is deliberately not advanced: a position we do not believe
      // must not constrain where the next stop is allowed to land.
      unmatched++;
      continue;
    }

    stopOk[k] = 1;
    if (chosen.error > maxError) maxError = chosen.error;
    floor = chosen.along;
  }

  // A trace that matches almost none of the stops is not this route's trace.
  if (stops.length - unmatched < stops.length * MIN_MATCHED_FRACTION) {
    return fail('snap-error', unmatched / stops.length);
  }

  // Span sanity over the stops that did match: the projection must cover roughly
  // the ground the stop chain covers. A collapsed or wrapped-around projection
  // fails here.
  let firstOk = -1;
  let lastOk = -1;
  for (let k = 0; k < stops.length; k++) {
    if (!stopOk[k]) continue;
    if (firstOk < 0) firstOk = k;
    lastOk = k;
  }
  if (firstOk >= 0 && lastOk > firstOk) {
    let chain = 0;
    for (let k = firstOk; k < lastOk; k++) {
      chain += haversineMeters(stops[k].coordinate, stops[k + 1].coordinate);
    }
    const span = stopAlong[lastOk] - stopAlong[firstOk];
    if (chain > 200 && (span < chain * MIN_SPAN_RATIO || span > chain * MAX_SPAN_RATIO)) {
      return fail('span', span / chain);
    }
  }

  if (out) out.worstError = maxError;
  return { line, cumulative, stopAlong, stopSeg, stopPoint, stopOk, maxError, unmatched };
}

/**
 * Metres driven between two stops of the route, or `null` when the pair is not
 * usable (out of range, either endpoint not on the trace, or projected out of
 * order). Callers keep the straight-line distance in that case.
 */
export function traceDistanceBetween(index: TraceIndex, fromOrd: number, toOrd: number): number | null {
  if (!traceCovers(index, fromOrd, toOrd)) return null;
  const distance = index.stopAlong[toOrd] - index.stopAlong[fromOrd];
  return distance > 0 ? distance : null;
}

/** Both ordinals exist and both stops were matched to the trace. */
function traceCovers(index: TraceIndex, fromOrd: number, toOrd: number): boolean {
  if (fromOrd < 0 || toOrd < 0) return false;
  if (fromOrd >= index.stopOk.length || toOrd >= index.stopOk.length) return false;
  return index.stopOk[fromOrd] === 1 && index.stopOk[toOrd] === 1;
}

/**
 * The trace between two stops, starting and ending **exactly** on their
 * projections — the reason a walking leg and the bus leg it feeds now meet on
 * the map instead of ending hundreds of metres apart.
 */
export function traceSliceBetween(index: TraceIndex, fromOrd: number, toOrd: number): LngLat[] | null {
  if (!traceCovers(index, fromOrd, toOrd)) return null;
  if (toOrd <= fromOrd) return null;
  // Same condition `traceDistanceBetween` refuses on. Two stops on opposite
  // kerbs can project up to `BACKTRACK_TOLERANCE_M` out of order, which leaves
  // no trace between them to draw — the segment loop below would fall through
  // and hand back a two-point line pretending to be the route.
  if (index.stopAlong[toOrd] <= index.stopAlong[fromOrd]) return null;

  const start = index.stopPoint[fromOrd];
  const end = index.stopPoint[toOrd];
  const out: LngLat[] = [start];
  // Interior vertices only: the projected endpoints already carry the partial
  // first and last segments.
  for (let i = index.stopSeg[fromOrd] + 1; i <= index.stopSeg[toOrd]; i++) {
    const vertex = index.line[i];
    const previous = out[out.length - 1];
    if (previous[0] === vertex[0] && previous[1] === vertex[1]) continue;
    out.push(vertex);
  }
  const last = out[out.length - 1];
  if (last[0] !== end[0] || last[1] !== end[1]) out.push(end);

  return out.length > 1 ? out : null;
}
