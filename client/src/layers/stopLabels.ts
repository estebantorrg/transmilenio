import { haversineMeters } from '../utils/geo';

/**
 * Within this distance two trip labels would print on top of each other at the
 * zooms a plan is read at, so they become one. A transfer through a station or
 * its tunnel stays under it; two different stops of a trip are farther apart.
 */
export const LABEL_MERGE_METERS = 150;

type StopFeature = GeoJSON.Feature<GeoJSON.Point, { kind: string; label: string; color: string }>;

/**
 * The trip's stop markers with labels that would collide stacked into one.
 *
 * A transfer is the end of one ride and the start of the next, or two ends a
 * short walk apart, and each end has its own marker and label: drawn at one
 * spot with overlap allowed they printed as "TrSubirarG112" (Reddit, 29 Oct
 * 2026). Every marker stays (each circle marks a real place); a label within
 * LABEL_MERGE_METERS of an earlier one joins it as another line instead.
 */
export function mergeStopLabels(features: StopFeature[], meters = LABEL_MERGE_METERS): StopFeature[] {
  const out = features.map((f) => ({ ...f, properties: { ...f.properties } }));
  for (let i = 0; i < out.length; i++) {
    const here = out[i];
    if (!here.properties.label) continue;
    const at = here.geometry.coordinates as [number, number];
    const host = out
      .slice(0, i)
      .find((o) => o.properties.label && haversineMeters(o.geometry.coordinates as [number, number], at) < meters);
    if (!host) continue;
    if (!host.properties.label.split('\n').includes(here.properties.label)) {
      host.properties.label += `\n${here.properties.label}`;
    }
    here.properties.label = '';
  }
  return out;
}
