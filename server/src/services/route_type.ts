/**
 * Route service-type classification, server side.
 *
 * A deliberate mirror of `isZonalService` in `client/src/utils/routeType.ts` —
 * the two packages compile separately (`rootDir: ./src`), so the server cannot
 * import the client's copy. Change both together. It lives in its own module
 * rather than inside whichever file needed it first, because `prerender_seo.ts`
 * and `station_plan.ts` both classify services and a second private copy inside
 * the server would be the drift this comment exists to prevent.
 */

/**
 * A service belongs to the zonal network if its system or service type names the
 * zonal network (`TransMiZonal`, `…ZONAL`) or the feeder buses (`ALIMENTADOR`).
 * `TRANSMIZONAL` already contains the `ZONAL` substring.
 */
export function isZonalService(sistema?: string | null, tipoServicio?: string | null): boolean {
  const service = `${sistema ?? ''} ${tipoServicio ?? ''}`.toUpperCase();
  return service.includes('ZONAL') || service.includes('ALIMENTADOR');
}
