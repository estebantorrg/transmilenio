/**
 * Where a route boards at one of its stops — the one answer the route page
 * (`client/src/ui/routePage.ts`) and its prerendered twin
 * (`server/src/prerender_seo.ts`) both give, spec §5.5.5.
 *
 * Two things a stop's name does not say:
 *
 *  · **Which platform**, at a stop the catalog files as two stations
 *    (Ricaurte, Av. Jiménez — `station_platforms.js`): the one whose wagons
 *    carry the route.
 *  · **Which vagón**, as its sign reads: from the station's plan where its sheet
 *    has been read (`planoLayout`), else from the plate number published for the
 *    catalog wagon the route is filed under (`vagonLabels`). A código the plan
 *    places on two vagones — one per direction — is settled by the destination
 *    the plan files against it; where it cannot be settled no vagón is given,
 *    rather than one of the two.
 */

import { platformsOf, platformStation } from './station_platforms.js';

/** Accent/case fold, punctuation to spaces: "Héroes" and "HEROES" agree. */
function fold(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * @param {any} parent      The catalog stop the route lists (`wagons`, `planoLayout`, `vagonLabels`).
 * @param {string} codigo   The route's código.
 * @param {string} [destino] The destination of the route variant being read.
 * @returns {{ station: any, platform?: any, vagon?: string, wagons: string[] } | null}
 *   `station` is the platform the route stops at (or the stop itself), `wagons`
 *   the catalog wagon letters carrying the route there.
 */
export function abordajeEn(parent, codigo, destino) {
  if (!parent) return null;
  const code = String(codigo ?? '').trim().toUpperCase();
  const wagons = Object.entries(parent.wagons ?? {})
    .filter(([key, routes]) => key !== '0' && (routes ?? []).some((r) => String(r.codigo).toUpperCase() === code))
    .map(([key]) => key.trim().toUpperCase());

  const platforms = platformsOf(parent.codigo);
  const platform = platforms.length ? platforms.find((p) => wagons.some((w) => p.wagones.includes(w))) : undefined;
  const station = platform ? platformStation(platform, parent) ?? parent : parent;

  const hacia = fold(destino);
  const enPlano = [];
  for (const row of station.planoLayout?.rows ?? []) {
    for (const v of row.vagones ?? []) {
      if (v.sinPlaca) continue;
      for (const [lado, codes] of [['arriba', v.arriba], ['abajo', v.abajo]]) {
        if (!(codes ?? []).some((c) => String(c).toUpperCase() === code)) continue;
        const destinos = lado === 'abajo' ? v.destinosAbajo ?? v.destinos : v.destinos;
        enPlano.push({ vagon: String(v.vagon), destino: destinos?.[code] });
      }
    }
  }
  let vagon;
  const distintos = [...new Set(enPlano.map((p) => p.vagon))];
  if (distintos.length === 1) vagon = distintos[0];
  else if (distintos.length > 1 && hacia) {
    // The plan files a destination against each; the variant's own destination
    // picks one. Compared on a prefix, because the plan writes "Portal Sur" where
    // the catalog writes "Portal Sur - JFK Coop. Financiera".
    const elegidos = [
      ...new Set(
        enPlano
          .filter((p) => p.destino && (hacia.startsWith(fold(p.destino)) || fold(p.destino).startsWith(hacia)))
          .map((p) => p.vagon)
      ),
    ];
    if (elegidos.length === 1) vagon = elegidos[0];
  }
  // The plate, where the plan has nothing to say about this código at all.
  if (!vagon && enPlano.length === 0 && wagons.length === 1) {
    const plate = station.vagonLabels?.[wagons[0]] ?? parent.vagonLabels?.[wagons[0]];
    if (plate) vagon = String(plate);
  }

  return { station, ...(platform ? { platform } : {}), ...(vagon ? { vagon } : {}), wagons };
}

/**
 * The platforms of a merged stop (Ricaurte, Av. Jiménez) a route calls at, in
 * travel order — the planner's nodes for that stop. One for every route but the
 * service that leaves from one half and calls at the other on its way out
 * (`paranAlSalir`: route 5 at Av. Jiménez).
 *
 * @param {any} parent        The catalog stop the route lists.
 * @param {string} codigo     The route's código.
 * @param {boolean} [saliendo] The stop is the route's first.
 * @returns {import('./station_platforms.js').StationPlatform[]} Empty where the
 *   stop is not a merged one, or no wagon carries the route — its half is then
 *   not known, and it is not guessed.
 */
export function plataformasDe(parent, codigo, saliendo) {
  const halves = platformsOf(parent?.codigo);
  if (!halves.length) return [];
  const platform = abordajeEn(parent, codigo)?.platform;
  if (!platform) return [];
  const code = String(codigo ?? '').trim().toUpperCase();
  return saliendo
    ? [platform, ...halves.filter((half) => half !== platform && half.paranAlSalir?.includes(code))]
    : [platform];
}

/** "Vagón 3", or the sign as it stands where it is not a number ("T7"). */
export function vagonTexto(vagon) {
  return /^\d+$/.test(String(vagon)) ? `Vagón ${vagon}` : String(vagon);
}
