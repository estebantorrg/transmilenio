/**
 * Which routes pass through the barrio a rider typed, from two sources because
 * neither is enough. The catalog's stop names cover every route, but say
 * `Hsp. Occidente` and not the landmark a rider knows. The printed hitos
 * (`shared/tabla_rutero.js`) name those landmarks, but only for 370 routes and
 * only a handful per route: Modelia is 16 routes by hito, 58 by stop, 62 by both.
 */

import { coincideBarrio, palabrasBarrio, textoBarrio } from '../../../shared/barrios.js';
import { sentidosHacia, type RuterosTradicionales } from '../../../shared/tabla_rutero.js';
import type { RouteListItem } from '../types/transmilenio';
import { loadRuteros } from './ruteros';

interface Lugar {
  nombre: string;
  texto: string;
}

let rutas: RuterosTradicionales['rutas'] | null = null;
let lugaresPorRuta = new WeakMap<RouteListItem, Lugar[]>();
const textos = new Map<string, string>();

/** Calls back once, the first time the printed hitos are in. */
export function loadHitos(onLoaded: () => void): void {
  if (rutas) return;
  void loadRuteros().then((loaded) => {
    if (!loaded || rutas) return;
    rutas = loaded.rutas;
    lugaresPorRuta = new WeakMap();
    onLoaded();
  });
}

function lugar(nombre: string): Lugar {
  let texto = textos.get(nombre);
  if (texto === undefined) {
    texto = textoBarrio(nombre);
    textos.set(nombre, texto);
  }
  return { nombre, texto };
}

/** This direction's places: stops first, since they are what a rider gets off at. */
function lugaresDe(route: RouteListItem): Lugar[] {
  let lugares = lugaresPorRuta.get(route);
  if (lugares) return lugares;
  // The sentido printed for this direction, by the rule the route page draws it by.
  const ruta = rutas?.[route.code];
  const byName = sentidosHacia(ruta, route.name);
  const sentidos = byName.length ? byName : sentidosHacia(ruta, route.destination);
  lugares = [
    ...(route.stops ?? []).map((stop) => stop.nombre),
    ...sentidos.flatMap((sentido) => sentido.filas.map((fila) => fila[2])),
  ]
    .filter(Boolean)
    .map(lugar);
  lugaresPorRuta.set(route, lugares);
  return lugares;
}

/**
 * Route id → the place it passes that the query names, in the order given. A
 * Ciclovía variant is left out when its ordinary service passes there too: it is
 * the same bus on its Sunday detour, and listing both doubled every row.
 */
export function rutasQuePasan(routes: RouteListItem[], consulta: string): Map<string, string> {
  const palabras = palabrasBarrio(consulta);
  const pasan = new Map<string, string>();
  if (!palabras) return pasan;
  const ordinarias = new Set<string>();
  const hallazgos: Array<[RouteListItem, string]> = [];
  for (const route of routes) {
    const hallado = lugaresDe(route).find((l) => coincideBarrio(l.texto, palabras));
    if (!hallado) continue;
    hallazgos.push([route, hallado.nombre]);
    if (!/ciclov/i.test(route.name)) ordinarias.add(route.code);
  }
  for (const [route, nombre] of hallazgos) {
    if (!/ciclov/i.test(route.name) || !ordinarias.has(route.code)) pasan.set(route.id, nombre);
  }
  return pasan;
}
