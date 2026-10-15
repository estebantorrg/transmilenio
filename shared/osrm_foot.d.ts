export interface FootRoute {
  /** Routed geometry, [lng, lat], between the points OSRM snapped to. */
  coordinates: [number, number][];
  /** Walked metres: the routed path plus both snap legs. */
  distance: number;
}

export declare const FOOT_HEADERS: Record<string, string>;
export declare const FOOT_CREDIT_HTML: string;
export declare const FOOT_MIN_INTERVAL_MS: number;
export declare function footRouteUrl(from: [number, number], to: [number, number]): string;
export declare function readFootRoute(data: unknown): FootRoute | null;
export declare function createPacer(intervalMs: number, maxWaitMs: number): (now?: number) => number | null;
