export const ON_ROUTE_MAX_PERP_M: number;
export const PASSED_STOP_EPSILON_M: number;

export interface Projection {
  /** Distance from the point to its nearest point on the trace (m). */
  perp: number;
  /** Along-track distance of that nearest point from the trace's start (m). */
  along: number;
}

export function traceToPaths(trace: unknown): number[][][];
export function projectOntoPaths(paths: number[][][], pLng: number, pLat: number): Projection | null;
