/** The part of a planner itinerary (`JourneyPlan`) a link reads. */
export interface ViajePlan {
  steps: Array<{ type: string; routeCode?: string; fromName?: string; toName?: string }>;
}

export interface ViajeEnd {
  coord: [number, number];
  label?: string;
  code?: string;
  /** The device's own position: rounded and relabelled before it travels. */
  gps?: boolean;
}

export interface Viaje {
  origin?: ViajeEnd | null;
  destination?: ViajeEnd | null;
  mode?: string;
  sortBy?: string;
  /** "YYYY-MM-DDTHH:MM", or null/absent for "now". */
  depart?: string | null;
  enforceSchedules?: boolean;
  /** The chosen option. */
  plan?: ViajePlan | null;
}

export declare const WEB_ORIGIN: string;
export declare function redondear(coord: [number, number]): [number, number];
export declare function viaKey(plan: ViajePlan | null | undefined): string;
export declare function planIndexForVia(plans: ViajePlan[], via: string | null | undefined): number;
export declare function cercaDe(plan: ViajePlan | null | undefined, end: 'o' | 'd'): string;
export declare function viajeParams(trip: Viaje): string;
export declare function viajeUrl(trip: Viaje): string;
export declare function viajePreview(query: string): { title: string; description: string };
