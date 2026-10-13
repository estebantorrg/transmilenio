/**
 * The destination names a live lookup tries for a route, best first.
 *
 * The troncal live endpoint only answers to the exact name it files a direction
 * under (spec §5.2.4), and the catalog spells that name several ways — the
 * destination stop, the variant's own `nombre`, either half of a hyphenated
 * name. So every lookup carries the candidates, destination first.
 *
 * Its own module, with nothing behind it but the shared name splitter, because
 * the planner needs it too (the live wait at the first boarding, §5.6.6) and
 * `routeCatalog.ts` brings the colour tables with it: the router has to stay
 * loadable on its own, from the app, the website, the Node bench and the
 * non-browser specs alike. `routeCatalog.ts` re-exports it, so its existing
 * callers are unchanged.
 */

import type { RouteListItem } from '../types/transmilenio';
import { addUniqueLiveName } from '../../../shared/live_names.js';

export function getLiveNameCandidates(route: RouteListItem): string[] {
  const candidates: string[] = [];
  const add = (value: unknown) => addUniqueLiveName(candidates, String(value || '').trim());
  add(route.destination);
  add(route.catalogNombre);
  add(route.name);
  add(route.origin);
  route.stops?.slice(0, 1).forEach((stop) => add(stop.nombre));
  route.stops?.slice(-1).forEach((stop) => add(stop.nombre));
  return candidates;
}
