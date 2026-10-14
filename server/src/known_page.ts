import { legalDocForPath } from '../../shared/legal.js';
import { codigosActuales } from '../../shared/renumeraciones.js';
import { stationPlatform } from '../../shared/station_platforms.js';

/**
 * Whether a path the static mounts did not serve is still a page the app draws
 * (spec §5.5.8). The shell goes out either way — the app says "no existe" on its
 * own (`client/src/ui/notFoundPage.ts`) — but with a 404 when this is false,
 * instead of the 200 that made every made-up or retired address a soft 404.
 *
 * "No file" cannot mean "no page": only the troncal pages are prerendered, and a
 * zonal `/ruta/<código>/` is a real page that exists only in the bundle. So the
 * catalog answers, and it errs towards 200 — a 404 on a page that works gets it
 * de-indexed, while a 200 on one that does not is only the soft 404 it was.
 */
export function isKnownPage(pathname: string, catalog: { routes?: object; stations?: object }): boolean {
  if (pathname === '/' || legalDocForPath(pathname)) return true;
  // Drawn by the bundle alone, from `/api/novedades` (`ui/novedadesPage.ts`).
  if (/^\/novedades\/?$/.test(pathname)) return true;

  // Códigos are letters, digits and hyphens, so a slug is its código lowercased.
  const ruta = pathname.match(/^\/ruta\/([^/]+)\/?$/);
  if (ruta) {
    const slug = ruta[1].toLowerCase();
    return (
      Object.keys(catalog.routes ?? {}).some((code) => code.toLowerCase() === slug) ||
      // A código retired by renumbering still opens the route under its new one.
      codigosActuales(slug).length > 0
    );
  }

  // The código is whatever follows the last hyphen (`parseStationPathname`).
  const estacion = pathname.match(/^\/estacion\/(?:.+-)?([^/-]+)\/?$/);
  if (estacion) {
    const code = estacion[1].toUpperCase();
    return (
      Object.keys(catalog.stations ?? {}).some((key) => key.toUpperCase() === code) ||
      Boolean(stationPlatform(code))
    );
  }

  return false;
}
