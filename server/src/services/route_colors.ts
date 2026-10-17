/**
 * The colour a service's chip is drawn in on the prerendered pages and social
 * cards — the app's palette, not the catalog's, read from the one copy the app
 * reads too (`shared/route_colors.js`).
 *
 * Letting these pages fall back to the raw catalog colour is what put them out
 * of step with the app: measured over the 1 755 services filed on the 139
 * estación pages, **1 622 (92.4%)** were drawn in a different colour from the
 * app's chip for the same route. The hand mirror that replaced it drifted too
 * (two-letter prefixes), hence the shared module (spec §5.4.3: both clients
 * render the same transit semantics, and these pages are a third surface onto
 * the same network).
 */

import { TRONCAL_COLORS, getStopTagColor } from '../../../shared/route_colors.js';

export { TRONCAL_COLORS };

/** The chip colour for a service, given its código, catalog colour and network. */
export function stopTagColor(code: string, catalogColor: string | null | undefined, zonal: boolean): string {
  return getStopTagColor(code, catalogColor, zonal ? 'zonal' : 'troncal');
}
