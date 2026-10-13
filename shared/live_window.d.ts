/** First/last minute of the Bogotá day the live feed is known to answer. */
export const LIVE_WINDOW_START_MINUTE: number;
export const LIVE_WINDOW_END_MINUTE: number;
/** Whether the live host is inside its service window at `epochMs`. */
export function liveWindowOpenAt(epochMs: number): boolean;
