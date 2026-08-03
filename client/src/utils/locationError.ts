/**
 * Why a location fix failed — one classification for every surface that asks for
 * one (spec §1.1 R2).
 *
 * A denied permission, a device that never got a fix, and a rider outside the
 * city need three different reactions, and every one of the app's locate buttons
 * used to collapse them into "No se pudo ubicarte" — a message that names no
 * cause and offers no next step. The caller adds the next step (drag the marker,
 * pick on the map, open browser settings); the cause is decided here.
 */

export type LocationFailure = 'denied' | 'outside' | 'unavailable';

export function classifyLocationFailure(err: unknown): LocationFailure {
  if (err instanceof Error && err.message.includes('Bogotá')) return 'outside';
  // `GeolocationPositionError` is not a constructor in every engine, so the
  // instanceof is guarded and the numeric code is the fallback check.
  if (
    typeof GeolocationPositionError !== 'undefined' &&
    err instanceof GeolocationPositionError &&
    err.code === err.PERMISSION_DENIED
  ) {
    return 'denied';
  }
  if (typeof err === 'object' && err !== null && (err as GeolocationPositionError).code === 1) return 'denied';
  return 'unavailable';
}

/** Short, cause-naming headline. Surfaces append their own recovery. */
export const LOCATION_FAILURE_MESSAGE: Record<LocationFailure, string> = {
  denied: 'Permiso de ubicación denegado',
  outside: 'Estás fuera de Bogotá',
  unavailable: 'No se pudo obtener tu ubicación (sin señal GPS)',
};

export function locationFailureMessage(err: unknown): string {
  return LOCATION_FAILURE_MESSAGE[classifyLocationFailure(err)];
}
