/** The printed ruteros (`shared/tabla_rutero.js`), one fetch for every surface that reads them. */

import type { RuterosTradicionales } from '../../../shared/tabla_rutero.js';
import { api } from './api';

let promise: Promise<RuterosTradicionales | null> | null = null;
let cargados: RuterosTradicionales | null = null;

export const ruterosCargados = (): RuterosTradicionales | null => cargados;

/** Fetched once per session; `null` if the fetch fails. */
export function loadRuteros(): Promise<RuterosTradicionales | null> {
  promise ??= api
    .getRuterosTradicionales()
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
