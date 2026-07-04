/** Wiring shared across views/sheets, set once by main.ts after boot. */

import type { RouteListItem } from '@shared/types/transmilenio';
import type { StationRecord, TabId } from './state';

export interface AppContext {
  navigate: (tab: TabId) => void;
  /** Open a route: switches to the map, draws it, starts live tracking. */
  showRouteOnMap: (route: RouteListItem) => void;
  /** Switch to the map and center on a station/stop. */
  focusPoint: (rec: StationRecord) => void;
  /** Draw the user's blue dot on the map (no tab switch). */
  setUserLocation: (coord: [number, number]) => void;
  /** Jump to the Rutas tab pre-seeded with a search query. */
  openRoutesFiltered: (query: string) => void;
}

let ctx: AppContext | null = null;

export function setAppContext(next: AppContext): void {
  ctx = next;
}

export function app(): AppContext {
  if (!ctx) throw new Error('AppContext used before init');
  return ctx;
}
