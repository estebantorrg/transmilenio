/** The printed ruteros (`shared/tabla_rutero.js`), one fetch for every surface that reads them. */

import { sentidosHacia, type RuterosTradicionales, type SentidoRutero } from '../../../shared/tabla_rutero.js';
import type { RouteListItem } from '../types/transmilenio';
import { api, type RuterosTradicionalesResponse } from './api';

let promise: Promise<RuterosTradicionales | null> | null = null;
let cargados: RuterosTradicionales | null = null;
let leer = (): Promise<RuterosTradicionalesResponse> => api.getRuterosTradicionales();

export const ruterosCargados = (): RuterosTradicionales | null => cargados;

/** Where they are read from: our API, or the copy bundled in the APK (`client/mobile/src/data.ts`). */
export function leerRuterosDe(fuente: () => Promise<RuterosTradicionalesResponse>): void {
  leer = fuente;
}

/** Fetched once per session; `null` if the fetch fails. */
export function loadRuteros(): Promise<RuterosTradicionales | null> {
  promise ??= leer()
    .then((res) => (cargados = res.success && res.rutas ? { fuente: res.fuente, rutas: res.rutas } : null))
    .catch(() => null)
    // A failed fetch is not the answer for the session: a page opened a minute
    // later asks again (not every re-render — the live card refreshes the page).
    .then((loaded) => {
      if (!loaded) window.setTimeout(() => (promise = null), 60_000);
      return loaded;
    });
  return promise;
}

/** The sentidos printed for this direction, by the rule the route page draws it by; empty until loaded. */
export function sentidosDeRuta(route: RouteListItem): SentidoRutero[] {
  const ruta = cargados?.rutas[route.code];
  const byName = sentidosHacia(ruta, route.name);
  return byName.length ? byName : sentidosHacia(ruta, route.destination);
}
