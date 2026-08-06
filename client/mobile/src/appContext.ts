/** Wiring shared across views/sheets, set once by main.ts after boot. */

import type { RouteListItem } from '@shared/types/transmilenio';
import type { JourneyPlan } from '@shared/services/router';
import type { StationRecord, TabId } from './state';

export interface AppContext {
  navigate: (tab: TabId) => void;
  /** Open a route: switches to the map, draws it, starts live tracking. */
  showRouteOnMap: (route: RouteListItem) => void;
  /** Switch to the map and center on a station/stop. */
  focusPoint: (rec: StationRecord) => void;
  /** Draw the user's blue dot on the map (no tab switch). */
  setUserLocation: (coord: [number, number]) => void;
  /**
   * Open the Planear tab, optionally seeding one endpoint ("Desde aquí" /
   * "Hasta aquí" on a place sheet). The planner is a screen, so the other
   * endpoint and any previous answer survive the trip.
   */
  openPlanner: (seed?: { role: 'origin' | 'destination'; coord: [number, number]; code?: string; name: string }) => void;
  /**
   * Plan a trip the rider described out loud (spec §5.9 `viaje`): seed both
   * endpoints and run the search, so "¿cómo llego a la Calle 100?" lands on
   * itineraries instead of on a form with two empty fields. Separate from
   * {@link openPlanner}, which seeds one endpoint and deliberately waits for the
   * rider to fill the other.
   */
  planTrip: (trip: {
    destination: { coord: [number, number]; code?: string; name: string };
    origin?: { coord: [number, number]; name: string } | null;
  }) => void;
  /** Jump to the Rutas tab filtered to a troncal line (Explora por línea). */
  openLine: (letter: string) => void;
  /** Jump to the Rutas tab filtered to a SITP numeric zone (1–13). */
  openZone: (zone: number) => void;
  /** Clear the map's active route/banner if one is showing. Returns true if it did. */
  dismissMapRoute: () => boolean;
  /**
   * Ask the rider to tap a point on the map — the fallback for every flow that
   * wants a location when the GPS can't give one (denied, no fix, or simply
   * planning from somewhere you aren't). Resolves null if cancelled.
   */
  pickPointOnMap: (prompt: string) => Promise<[number, number] | null>;
  /** Cancel an in-progress map pick. Returns true if one was running. */
  cancelPointPick: () => boolean;
  /** Show a planned itinerary on the map (planner → "Ver en el mapa"). */
  showJourneyOnMap: (plan: JourneyPlan, summary: string) => void;
  /** Clear a drawn itinerary. Returns true if one was showing. */
  dismissMapJourney: () => boolean;
}

let ctx: AppContext | null = null;

export function setAppContext(next: AppContext): void {
  ctx = next;
}

export function app(): AppContext {
  if (!ctx) throw new Error('AppContext used before init');
  return ctx;
}
