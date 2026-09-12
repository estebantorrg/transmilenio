/**
 * The one loaded copy of TRANSMILENIO's measured speeds and headways (spec
 * §5.6.5), and the only place that is told when it changes.
 *
 * Two consumers read it — the planner graph (`router.ts`, per edge) and the
 * voice/live ETA (`routeEta.ts`, per ride) — and they must never disagree about
 * how fast a bus is at 18:00 on a Tuesday. Holding it here, rather than in
 * either of them, means one fetch, one prepared form, and one notification when
 * a late-arriving payload lands.
 */

import { prepareCalibration } from '../../../shared/calibration.js';
import type { PlannerCalibrationData, PreparedCalibration } from '../../../shared/calibration.js';

let current: PreparedCalibration | null = null;
const listeners = new Set<() => void>();

/**
 * Loads the calibration, or clears it with `null` (the constants then decide
 * everything again). Consumers are notified so a graph already built is re-costed.
 */
export function setPlannerCalibration(data: PlannerCalibrationData | null): void {
  current = data ? prepareCalibration(data) : null;
  for (const listener of listeners) listener();
}

/** The prepared calibration, or null when none is loaded. */
export function getCalibration(): PreparedCalibration | null {
  return current;
}

/** Subscribe to loads/clears. Returns the unsubscribe. */
export function onCalibrationChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
