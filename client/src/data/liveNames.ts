/**
 * The destination names a live lookup tries for a route, best first.
 *
 * The troncal live endpoint only answers to the exact name it files a direction
 * under (spec §5.2.4), and the catalog spells that name several ways — the
 * destination stop, the variant's own `nombre`, either half of a hyphenated
 * name. So every lookup carries the candidates, destination first.
 *
 * Its own module, with no dependencies, because the planner needs it too (the
 * live wait at the first boarding, §5.6.6) and `routeCatalog.ts` brings the
 * colour tables with it: the router has to stay loadable on its own, from the
 * app, the website, the Node bench and the non-browser specs alike.
 * `routeCatalog.ts` re-exports it, so its existing callers are unchanged.
 */

import type { RouteListItem } from '../types/transmilenio';

function addUniqueLiveName(candidates: string[], value: unknown): void {
  const text = String(value || '').trim();
  if (!text) return;

  const parts = text.split(/\s+[-–—]\s+/).map((part) => part.trim()).filter(Boolean);
  for (const part of parts.length > 1 ? [...parts].reverse() : parts) {
    const clean = part.trim();
    if (clean && !candidates.some((candidate) => candidate.toLowerCase() === clean.toLowerCase())) {
      candidates.push(clean);
    }
  }

  if (!candidates.some((candidate) => candidate.toLowerCase() === text.toLowerCase())) {
    candidates.push(text);
  }
}

export function getLiveNameCandidates(route: RouteListItem): string[] {
  const candidates: string[] = [];
  addUniqueLiveName(candidates, route.destination);
  addUniqueLiveName(candidates, route.catalogNombre);
  addUniqueLiveName(candidates, route.name);
  addUniqueLiveName(candidates, route.origin);
  route.stops?.slice(0, 1).forEach((stop) => addUniqueLiveName(candidates, stop.nombre));
  route.stops?.slice(-1).forEach((stop) => addUniqueLiveName(candidates, stop.nombre));
  return candidates;
}
