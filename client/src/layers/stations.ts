/**
 * Troncal station layer — simplified.
 *
 * Renders stations as circles/labels. On click, shows a premium popup
 * with wagon → route data sourced from the TransMi app master catalog.
 * No more polygon rendering or geometric route guessing.
 */

import maplibregl from 'maplibre-gl';
import type { TroncalStationFeature } from '../types/transmilenio';
import { markClickHandled, normalizeRouteCode, normalizeRouteCodeForMatch } from './routes';
import { showPopup } from './popup';
import { planActionsHtml } from './popupActions';
import { escapeHTML, safeColor } from '../utils/html';
import { getStopTagColor } from '../utils/routeColors';
import type { MasterCatalog, CatalogRoute, CatalogPlanGroup } from '../types/catalog';
import {
  buildStationKey,
  normalizeStationName,
  resolveStationCatalog,
  stationNode,
  type ResolvedCatalogStation,
  type ResolvedCatalogWagons,
  type StationCatalogAudit,
} from './stationCatalogResolver';
import { catalogRouteNetwork, isZonalService } from '../utils/routeType';
import { isStationStopCode } from '../data/routeCatalog';
import { arrivalsSectionHtml, renderStopArrivals } from './arrivals';
import { stationPageHref } from '../ui/routeDetail';
import { initChipRowScroll } from '../ui/chipRow';

const APP_STOP_CODE_RE = /^TM\d+$/i;

/** The catalog TM… code to query live arrivals for — the resolved source stop
 *  (route stops are filed by these codes), falling back to a TM-shaped code. */
function stationArrivalsCode(
  resolved: ResolvedCatalogStation | undefined,
  stationCode: string
): string {
  const source = resolved?.sourceStops?.[0]?.codigo;
  if (source) return source;
  return APP_STOP_CODE_RE.test(stationCode) ? stationCode : '';
}

/** For verified-split stations, the route codes that board THIS platform's
 *  wagons — used to keep only this platform's arrivals from the union the server
 *  returns for the shared source code. `undefined` for normal stations (no
 *  filtering needed: their wagon set already equals the serving-route set). */
function platformAllowedCodes(resolved: ResolvedCatalogStation | undefined): string[] | undefined {
  if (!resolved || !resolved.matchMethod.startsWith('verified-split')) return undefined;
  const codes = new Set<string>();
  for (const routes of Object.values(resolved.wagons)) {
    for (const route of routes) if (route.codigo) codes.add(route.codigo);
  }
  return Array.from(codes);
}

const STATION_LAYERS = [
  'stations-circle',
  'stations-hitbox',
  'stations-labels',
];

// ─── Route Tag Formatting ───────────────────────────────

/**
 * The destination a chip is keyed by, with the catalog's abbreviation expanded.
 *
 * Chips are keyed on the destination because one código genuinely runs two ways
 * from one plate, and each end needs its own clickable tag. But the catalog
 * writes one destination two ways: El Tiempo files `K43` as both `P. ElDorado`
 * and `Portal Eldorado`. Those are two real variants — they differ EAST of the
 * station, via Perdomo against via General Santander — and from this plate,
 * westward, they are the same journey to the same portal. Keyed on the raw name
 * they drew two K43 chips under a sign that prints one, claiming a choice the
 * rider does not have.
 *
 * Every abbreviated destination in the catalog is a portal — `P. 80`, `P. Sur`,
 * `P. 20 DE JULIO`, ten of them — so expanding `P.` is enough to make the two
 * spellings one key, and it leaves the case the grouping exists for untouched:
 * `Universidades` and `Portal El Dorado` are different places and stay two
 * chips. Collapsed, the tag links to the código rather than to either variant,
 * which is the honest target when the sheet does not say which one you board.
 */
function destinationKey(nombre: string | null | undefined): string {
  return normalizeStationName(String(nombre ?? '').replace(/^\s*P\.\s*/i, 'PORTAL '));
}

function groupCatalogRoutesByDirection(routes: CatalogRoute[]): Array<{ code: string; primary: CatalogRoute; routes: CatalogRoute[] }> {
  const groups = new Map<string, { code: string; primary: CatalogRoute; routes: CatalogRoute[] }>();

  for (const route of routes) {
    const codeKey = normalizeRouteCodeForMatch(route.codigo);
    if (!codeKey) continue;

    // Key by code AND direction (destination name). A route that serves a wagon
    // in both directions — common for rutas fáciles like "1" → Universidades /
    // Portal Eldorado — must keep each end as its own clickable tag instead of
    // collapsing into a single tag that can only reach one direction.
    const key = `${codeKey}|${destinationKey(route.nombre)}`;

    const group = groups.get(key);
    if (group) {
      group.routes.push(route);
    } else {
      groups.set(key, { code: route.codigo, primary: route, routes: [route] });
    }
  }

  return Array.from(groups.values()).sort((a, b) =>
    normalizeRouteCode(a.code).localeCompare(normalizeRouteCode(b.code), undefined, { numeric: true }) ||
    String(a.primary.nombre || '').localeCompare(String(b.primary.nombre || ''), undefined, { numeric: true })
  );
}

function formatRouteTags(routes: CatalogRoute[], limit = 28): string {
  const groups = groupCatalogRoutesByDirection(routes);
  const visibleGroups = groups.slice(0, limit);
  const hiddenCount = groups.length - visibleGroups.length;
  const tags = visibleGroups
    .map((group) => {
      const route = group.primary;
      const color = safeColor(getStopTagColor(route.codigo, route.color, catalogRouteNetwork(route)), '#FB2C17');
      const routeId = group.routes.length === 1 && route.id ? `catalog-${route.id}` : '';
      const names = Array.from(new Set(group.routes.map((item) => item.nombre).filter(Boolean)));
      const title = names.join(' / ') || route.nombre;
      return `<span class="route-tag clickable" data-route-code="${escapeHTML(route.codigo)}" data-route-id="${escapeHTML(routeId)}" title="${escapeHTML(title)}" style="background:${color}; cursor:pointer;">${escapeHTML(route.codigo)}</span>`;
    })
    .join('');

  return hiddenCount > 0
    ? `${tags}<span class="route-tag muted">+${hiddenCount}</span>`
    : tags;
}

/**
 * A vagón's services split by the side they board from, when the catalog's plan
 * covers them (`wagonPlan`, spec §5.5.4). Returns null when it doesn't, and the
 * caller falls back to one undifferentiated row of tags.
 *
 * The split is the whole point of a plano: "which routes serve this station" is
 * answered by a list, but "which side do I stand on" is not, and that is the
 * question a rider standing on the platform actually has. `arrival` groups are
 * the services that END here — they are shown, because they do use the platform,
 * but never under a direction, since there is nothing to board them towards.
 */
function buildDirectionRowsHtml(
  routes: CatalogRoute[],
  groups: CatalogPlanGroup[] | undefined
): string | null {
  if (!groups?.length) return null;
  const byId = new Map(routes.map((r) => [String(r.id ?? ''), r]));
  const rows: string[] = [];

  for (const group of groups) {
    const members = group.ids.map((id) => byId.get(String(id))).filter((r): r is CatalogRoute => Boolean(r));
    if (members.length === 0) continue;
    const label = group.arrival
      ? '<span class="popup-dir-end">fin de recorrido</span>'
      : group.sentido
        ? `<span class="popup-dir-arrow"></span>${escapeHTML(group.sentido)}`
        : 'sentido sin determinar';
    rows.push(
      `<div class="popup-dir"><div class="popup-dir-label">${label}</div>` +
        `<div class="popup-route-tags">${formatRouteTags(members)}</div></div>`
    );
  }

  // Every service filtered out (ids that don't match this platform's routes) —
  // better to fall back than to render a vagón with nothing under it.
  return rows.length > 0 ? rows.join('') : null;
}

export type StationPlanoLayout = NonNullable<
  import('../types/catalog').CatalogStation['planoLayout']
>;

/**
 * A station drawn from its own plano, where the catalog's lettered wagons
 * cannot describe it (`planoLayout`, §5.5.4).
 *
 * The bar below is built from those letters and assumes one segmented platform
 * carrying both directions along it. Two shapes break that, and both were
 * publishing a **wrong vagón number** rather than withholding one, because each
 * station's plate count happened to agree with its wagon count:
 *
 * - **La Castellana** is two platforms on opposite carriageways, offset, with
 *   something between them — four printed vagones filed as two wagons, each
 *   straddling both platforms. As a bar it read "Vagón 1: B28 y G12", two
 *   services that face opposite sides of the corridor.
 * - **Calle 85** is one straight platform of four vagones filed as three
 *   wagons, its `C` merging printed vagones 3 and 4 — so `C50`/`D10`/`H27` were
 *   labelled Vagón 3 when they board Vagón 4.
 *
 * So the sheet is drawn instead: rows of vagones in the order it draws them,
 * each row offset by the stagger it shows, and each vagón's services on the
 * edge it prints them. Sides are per **vagón**, never per platform — at Calle
 * 85 vagón 4 boards southbound only, vagón 3 northbound only, and vagones 2 and
 * 1 both, which no platform-wide side can express.
 *
 * The vagón numbers come straight off the plate and skip `vagonLabels`
 * entirely: that mapping exists to turn catalog letters into printed numbers,
 * and at these stations the letters are not the platforms.
 */
function buildStationLayoutHtml(
  layout: StationPlanoLayout,
  routesByCode: Map<string, CatalogRoute[]>,
  sentidoById: Map<string, string>,
  sentidos?: { positive: string; negative: string }
): string | null {
  // Each edge of a vagón boards one direction, so the catalog's two variants of
  // a código are separated by the side they are drawn on. Both `G12`s at La
  // Castellana are southbound, which is why `destinos` exists as well: this
  // narrows a código to a direction, that one narrows it to a service.
  const boardsOn = (route: CatalogRoute, side: 'a' | 'b'): boolean => {
    if (!sentidos) return true;
    const want = side === 'a' ? sentidos.positive : sentidos.negative;
    const sentido = sentidoById.get(String(route.id ?? ''));
    // No answer for this variant is not a reason to drop it: absence of a
    // direction is not evidence of the opposite one (§1).
    return sentido === undefined || sentido === want;
  };

  const rows = (layout.rows ?? []).map((row) => {
    const decks = row.vagones
      .map((vagon) => {
        // One chip per código, as the plate prints it. Where the catalog files
        // the same código twice on this edge, the sheet's chip names one of them
        // and `destinos` says which — two chips under one sign would claim two
        // boardable services where a rider sees one.
        const wanted = vagon.destinos ?? {};
        const membersFor = (codigos: string[] | undefined, side: 'a' | 'b'): CatalogRoute[] =>
          (codigos ?? []).flatMap((codigo) => {
            const all = routesByCode.get(codigo.toUpperCase()) ?? [];
            // Both filters below may only NARROW a código the sheet lists, never
            // erase it. The sheet is what says this service boards this edge;
            // the catalog's direction only helps choose between variants of it.
            // `D10` leaves the corridor westward at Calle 85, so it matches
            // neither `norte` nor `sur` and a strict filter dropped a service
            // printed on the plate — the drawing then contradicted the sign it
            // was copied from.
            const byDirection = all.filter((r) => boardsOn(r, side));
            const variants = byDirection.length > 0 ? byDirection : all;
            const destino = wanted[codigo] ?? wanted[codigo.toUpperCase()];
            if (!destino) return variants;
            const picked = variants.filter(
              (r) => normalizeStationName(r.nombre) === normalizeStationName(destino)
            );
            return picked.length > 0 ? picked : variants;
          });

        const above = membersFor(vagon.arriba, 'a');
        const below = membersFor(vagon.abajo, 'b');
        if (above.length === 0 && below.length === 0) return '';
        const count =
          groupCatalogRoutesByDirection(above).length + groupCatalogRoutesByDirection(below).length;
        const tags = (members: CatalogRoute[]): string =>
          members.length
            ? `<div class="pvg-group"><div class="popup-route-tags">${formatRouteTags(members)}</div></div>`
            : '';
        const deck =
          `<div class="pvg-deck">` +
          `<span class="pvg-doors" aria-hidden="true"></span>` +
          `<div class="pvg-plate"><span class="pvg-name">Vagón ${escapeHTML(vagon.vagon)}</span>` +
          `<span class="pvg-sub">${count}</span></div>` +
          `<span class="pvg-doors" aria-hidden="true"></span>` +
          `</div>`;
        return (
          `<section class="pvg" aria-label="Vagón ${escapeHTML(vagon.vagon)}">` +
          `<div class="pvg-side pvg-side-a">${tags(above)}</div>` +
          deck +
          `<div class="pvg-side pvg-side-b">${tags(below)}</div>` +
          `</section>`
        );
      })
      .filter(Boolean);
    if (decks.length === 0) return '';
    // The stagger, in vagón columns. Drawing the two platforms flush would say
    // they face each other across the road, which at a staggered station is the
    // one thing they do not do.
    const offset = Number(row.offset) || 0;
    const style = offset > 0 ? ` style="--pvg-offset:${offset}"` : '';
    return `<div class="pvg-row"${style}><div class="popup-plano-cols">${decks.join('')}</div></div>`;
  });

  const drawn = rows.filter(Boolean);
  if (drawn.length === 0) return null;

  // The corridor, named once at each long edge, exactly as the bar does it and
  // as the sheet does it. A layout's sides ARE the corridor's two directions —
  // that is what `arriba`/`abajo` mean and what `boardsOn` filters on — so the
  // labels are the same two words, and drawn only where a side carries chips.
  const used = (side: 'a' | 'b'): boolean =>
    (layout.rows ?? []).some((r) =>
      (r.vagones ?? []).some((v) => ((side === 'a' ? v.arriba : v.abajo) ?? []).length > 0)
    );
  const axis = (name: string | undefined, side: 'a' | 'b'): string =>
    name && used(side)
      ? `<div class="pvg-axis pvg-axis-${side}"><span class="pvg-axis-name">${escapeHTML(name)}</span></div>`
      : '';

  // What lies between the platforms is named only where someone has checked it.
  // This drawing called every divider a busway on no evidence at all:
  // El Tiempo, AV. Rojas and Tygua are split by a ciclorruta and Guatoque by a
  // caño — an open water channel. Sending a rider across the wrong one is a
  // confident wrong answer, so an unchecked station gets a plain separator with
  // no claim attached.
  const DIVIDERS: Record<string, string> = {
    busway: 'calzada',
    ciclorruta: 'ciclorruta',
    cano: 'caño',
  };
  const label = layout.divider ? DIVIDERS[layout.divider] : '';
  const divider =
    `<div class="pvg-divider pvg-divider-${escapeHTML(layout.divider ?? 'plain')}">` +
    (label ? `<span class="pvg-divider-name">${escapeHTML(label)}</span>` : '') +
    `</div>`;

  return (
    `<div class="popup-plano popup-plano-split" role="group" aria-label="Plano de la estación" tabindex="0">` +
    `<div class="popup-plano-inner">` +
    axis(sentidos?.positive, 'a') +
    drawn.join(divider) +
    axis(sentidos?.negative, 'b') +
    `</div></div>`
  );
}

/**
 * The station drawn as a plan — the same view the prerendered `/estacion/` page
 * carries (spec §5.5.4): one continuous platform bar segmented per vagón, the
 * services that board each side above and below it.
 *
 * A list can say which routes serve a station; only a plan says which side to
 * stand on, which is the question a rider on the platform actually has. The
 * three parts of each vagón are laid out on shared grid rows so every plate
 * lands on one line and the bar reads as one platform — with a flex fallback
 * where `subgrid` is unsupported, since a bar that steps up and down mid-station
 * reads as a rendering fault rather than as a station.
 *
 * ── Drawn in the operator's own grammar ───────────────────────────────────
 *
 * The layout is not invented: it is TRANSMILENIO's `Plano de ubicación`, the
 * sheet posted inside every station and the thing a rider is looking at when
 * they ask which vagón. That sheet draws a light platform deck, a plate reading
 * `Vagón N` centred in each segment, door marks along both edges,
 * the services that board each side stacked above and below, a crossing block
 * between adjacent vagones, and the corridor named once at each long edge
 * rather than repeated per segment. Every one of those is reproduced here, at
 * whatever scale the surface asks for, so the page and the sheet on the wall
 * read as the same object.
 *
 * The structure is copied; the palette is not. The sheet sets the vagón number
 * on a yellow plate, which is one accent among several on its white ground —
 * repeated down the middle of a dark page it became a row of bright strips that
 * pulled the eye off the services, which are what the reader came for.
 *
 * What is NOT reproduced is everything the catalog cannot answer: exits and
 * their street names, taquillas, turnstiles, ramps, pedestrian bridges, floors,
 * and the real length or spacing of anything. The sheet has them; we would be
 * drawing them from nothing (§1 Certainty). The door marks are the one
 * deliberate exception and are decoration — a fixed three per side, not a door
 * count — because a deck without them reads as a table rather than a platform.
 *
 * The corridor is hoisted to the edges only when every vagón agrees on it. Where
 * they disagree the sentido stays printed per group, which is longer and true,
 * and `fin de recorrido` always stays with its own group because it belongs to
 * one vagón rather than to the station.
 *
 * Wide stations scroll sideways inside the plan rather than stretching the
 * popup: a portal has six vagones and the popup is 320 px.
 */
function buildStationPlanoHtml(
  lettered: Array<{ key: string; routes: CatalogRoute[] }>,
  vagonLabels: Record<string, string>,
  wagonPlan: Record<string, CatalogPlanGroup[]>,
  sentidos?: { positive: string; negative: string }
): string | null {
  type Resolved = { group: CatalogPlanGroup; members: CatalogRoute[] };
  const vagones: Array<{ name: string; count: number; a: Resolved[]; b: Resolved[] }> = [];

  // Which side of the platform a group is drawn on is the whole point of a plan,
  // so it is answered by the corridor and not by the order the catalog happened
  // to list the groups in: everything running the corridor's positive direction
  // goes above, everything running its negative goes below, at every vagón in
  // the station. Anything else — a service that leaves the corridor, or one that
  // terminates here — keeps its own label and falls below, because forcing it
  // onto a side would state a direction the data does not.
  const sideOf = (group: CatalogPlanGroup): 'a' | 'b' => {
    if (!sentidos || group.arrival || !group.sentido) return 'b';
    return group.sentido === sentidos.positive ? 'a' : 'b';
  };
  const isAxisGroup = (group: CatalogPlanGroup): boolean =>
    Boolean(sentidos && !group.arrival && group.sentido) &&
    (group.sentido === sentidos!.positive || group.sentido === sentidos!.negative);

  lettered.forEach(({ key, routes }, index) => {
    const groups = wagonPlan[key] ?? [];
    const byId = new Map(routes.map((r) => [String(r.id ?? ''), r]));
    const resolved: Resolved[] = groups
      .map((g) => ({
        group: g,
        members: g.ids.map((id) => byId.get(String(id))).filter((r): r is CatalogRoute => Boolean(r)),
      }))
      .filter((g) => g.members.length > 0);
    if (resolved.length === 0) return;

    // No number where the plate count doesn't back the catalog's grouping —
    // "Plataforma N" is vague but true, a wrong vagón number sends a rider to
    // the wrong side of the station.
    const name = vagonLabels[key] ? `Vagón ${escapeHTML(vagonLabels[key])}` : `Plataforma ${index + 1}`;
    const count = resolved.reduce((n, g) => n + groupCatalogRoutesByDirection(g.members).length, 0);

    if (sentidos) {
      vagones.push({
        name,
        count,
        a: resolved.filter((r) => sideOf(r.group) === 'a'),
        b: resolved.filter((r) => sideOf(r.group) === 'b'),
      });
    } else {
      const [first, ...rest] = resolved;
      vagones.push({ name, count, a: first ? [first] : [], b: rest });
    }
  });

  if (vagones.length === 0) return null;

  // The corridor is named once per edge, as the sheet names it — but only where
  // the drawing actually earns it: the side has to carry that direction at some
  // vagón and carry nothing that contradicts it.
  const edgeLabel = (side: 'a' | 'b'): string | null => {
    if (!sentidos) return null;
    const want = side === 'a' ? sentidos.positive : sentidos.negative;
    let seen = false;
    for (const v of vagones) {
      for (const { group } of v[side]) {
        if (!isAxisGroup(group)) continue;
        if (group.sentido !== want) return null;
        seen = true;
      }
    }
    return seen ? want : null;
  };
  const axisA = edgeLabel('a');
  const axisB = edgeLabel('b');
  const hoisted = Boolean(axisA && axisB);

  const groupBlock = (entry: Resolved, which: 'a' | 'b'): string => {
    const { group, members } = entry;
    // Hoisted to the edge — printing it again on every segment is the clutter
    // the sheet itself avoids. Only the two corridor directions are hoisted, so
    // a terminus, or a service that turns off the corridor, still says so where
    // it stands: those are the ones a rider would otherwise read off the wrong
    // edge label.
    const label = group.arrival
      ? '<span class="popup-dir-end">fin de recorrido</span>'
      : hoisted && isAxisGroup(group)
        ? ''
        : group.sentido
          ? `<span class="popup-dir-arrow popup-dir-arrow-${which === 'a' ? 'up' : 'down'}"></span>${escapeHTML(group.sentido)}`
          : 'sin determinar';
    return (
      `<div class="pvg-group">${label ? `<div class="popup-dir-label">${label}</div>` : ''}` +
      `<div class="popup-route-tags">${formatRouteTags(members)}</div></div>`
    );
  };

  const crossing =
    '<div class="pvg-gap" aria-hidden="true"><div class="pvg-gap-deck"><span class="pvg-gap-mark"></span></div></div>';

  const columns = vagones.map(({ name, count, a, b }) => {
    // The deck is the platform itself: door marks along both long edges and the
    // vagón's plate, centred between them.
    const deck =
      `<div class="pvg-deck">` +
      `<span class="pvg-doors" aria-hidden="true"></span>` +
      `<div class="pvg-plate"><span class="pvg-name">${name}</span><span class="pvg-sub">${count}</span></div>` +
      `<span class="pvg-doors" aria-hidden="true"></span>` +
      `</div>`;
    return (
      `<section class="pvg" aria-label="${name}">` +
      `<div class="pvg-side pvg-side-a">${a.map((entry) => groupBlock(entry, 'a')).join('')}</div>` +
      deck +
      `<div class="pvg-side pvg-side-b">${b.map((entry) => groupBlock(entry, 'b')).join('')}</div>` +
      `</section>`
    );
  });

  const axis = (name: string | null, side: 'a' | 'b'): string =>
    name
      ? `<div class="pvg-axis pvg-axis-${side}"><span class="pvg-axis-name">${escapeHTML(name)}</span></div>`
      : '';

  // The axes belong to the drawing, not to the viewport: they are as wide as the
  // platform is, so they ride inside the scroller with it rather than being
  // pinned to whatever slice of a six-vagón station happens to be on screen.
  return (
    `<div class="popup-plano" role="group" aria-label="Plano de la estación" tabindex="0">` +
    `<div class="popup-plano-inner">` +
    axis(axisA, 'a') +
    `<div class="popup-plano-cols">${columns.join(crossing)}</div>` +
    axis(axisB, 'b') +
    `</div></div>`
  );
}

/**
 * The station's services, as the popup and the estación page both show them: the
 * platform plan, then the labelled sections under it, then the count.
 *
 * Returned in parts rather than as one string because the two surfaces frame
 * them differently — the popup stacks them inside one card, the page gives the
 * plan and the service list a section each (spec §5.5.6) — while the *content*
 * is built once here. Two renderers would be two answers to which vagón a
 * service boards from (spec §1.1 R2).
 *
 * Sections are keyed on what each route IS, never on the wagon key it is filed
 * under (spec §5.5.4):
 *
 * - **Lettered wagons** are troncal platforms, headed by the number printed on
 *   the station's own signs (`vagonLabels`, resolved server-side against the
 *   plano plate counts) and by a neutral "Plataforma N" where that evidence is
 *   missing. The catalog's raw `A`/`B` keys are never shown: they appear on no
 *   sign in any station, so a rider sent to "Vagón A" has nothing to look for.
 *   When the TransMi data mismaps a zonal route onto one (e.g. A537 "Palermo",
 *   which merely parallels the corridor) it is a phantom stop, and it is
 *   dropped rather than repooled — the route does not board there at all.
 * - **Wagon "0"** is the pool the catalog files without a platform letter, and
 *   it is *mixed*: real feeders/zonales (Banderas F423/F424, San Mateo CSM) sit
 *   beside 61 troncal services across 22 stations (P85/M85 at Centro Memoria,
 *   L81/D81 along Avenida 68). Labelling the whole key from its dominant
 *   content printed "Vagón único" next to a Vagón A and a Vagón B, so each half
 *   gets its own true heading.
 *
 * Sections left empty are omitted.
 */
export interface StationWagonView {
  /** The drawn platform plan, or null where the catalog ships no plan for it. */
  plano: string | null;
  /** The labelled service sections (the lettered platforms only appear here when
   *  there is no plan to draw them in). */
  sections: string;
  /** Distinct services at the station, counted the way the tags are grouped
   *  (código + destino) — the number the hero chip carries. */
  serviceCount: number;
  /** Distinct services inside {@link sections} alone. Counted separately because
   *  a station whose lettered platforms are drawn in the plan leaves only the
   *  unassigned pool below it, and heading that block with the station's total
   *  says thirteen services over a list of five. */
  sectionCount: number;
}

export function buildStationWagonView(
  wagons: ResolvedCatalogWagons,
  vagonLabels: Record<string, string> = {},
  wagonPlan: Record<string, CatalogPlanGroup[]> = {},
  sentidos?: { positive: string; negative: string },
  layout?: StationPlanoLayout
): StationWagonView {
  const lettered: Array<{ key: string; routes: CatalogRoute[] }> = [];
  const unlettered: CatalogRoute[] = [];
  const feeders: CatalogRoute[] = [];

  for (const [wagonKey, entries] of Object.entries(wagons)) {
    const routes = entries as CatalogRoute[];
    if (wagonKey === '0') {
      for (const route of routes) {
        (isZonalService(route.sistema, route.tipoServicio) ? feeders : unlettered).push(route);
      }
      continue;
    }
    const troncal = routes.filter((r) => !isZonalService(r.sistema, r.tipoServicio));
    if (troncal.length) lettered.push({ key: wagonKey, routes: troncal });
  }

  lettered.sort((a, b) => a.key.localeCompare(b.key, undefined, { numeric: true }));

  // The lettered platforms are drawn as the station's plan — the same view the
  // /estacion/ page carries. Where the catalog ships no plan for them, they fall
  // back to the labelled sections below, so a station is never left blank.
  // A station whose shape has been read off its plano is drawn from that and
  // not from the letters — the letters are what cannot describe it.
  // Every service at the station, wagon "0" included — a layout's whole job is
  // to place services the catalog left without a platform, so building this
  // from the lettered wagons alone silently dropped them: El Tiempo's sheet
  // puts K86 on Vagón 2 and M86 on Vagón 3, and both disappeared from the
  // drawing that named them.
  const byCode = new Map<string, CatalogRoute[]>();
  for (const { routes } of [...lettered, { routes: unlettered }, { routes: feeders }]) {
    for (const route of routes) {
      const key = String(route.codigo || '').trim().toUpperCase();
      if (!key) continue;
      const bucket = byCode.get(key);
      if (bucket) bucket.push(route);
      else byCode.set(key, [route]);
    }
  }
  const sentidoById = new Map<string, string>();
  for (const groups of Object.values(wagonPlan)) {
    for (const group of groups) {
      if (!group.sentido) continue;
      for (const id of group.ids) sentidoById.set(String(id), group.sentido);
    }
  }
  const drawn = layout ? buildStationLayoutHtml(layout, byCode, sentidoById, sentidos) : null;
  const plano = drawn ?? buildStationPlanoHtml(lettered, vagonLabels, wagonPlan, sentidos);

  // A layout places services by código, and it places them from a sheet that is
  // older than the catalog — CAN's is stamped November 2025 and the catalog has
  // gained `K53` and `G53` since. So "what the drawing shows" and "what the
  // catalog files under a letter" are two different sets, and the list below has
  // to be the difference between them rather than either one:
  //
  //   • a lettered service the sheet does not draw would otherwise VANISH, since
  //     the lettered sections are suppressed whenever a plan is drawn;
  //   • a wagon "0" service the sheet DOES draw would otherwise appear twice —
  //     El Tiempo printed K86 and M86 once in the drawing and again below it.
  //
  // The bar drawing needs none of this: it is built from the letters, so it
  // already shows every lettered service and nothing else.
  const placed = new Set<string>();
  if (drawn) {
    for (const row of layout?.rows ?? []) {
      for (const vagon of row.vagones ?? []) {
        for (const codigo of [...(vagon.arriba ?? []), ...(vagon.abajo ?? [])]) {
          placed.add(String(codigo).trim().toUpperCase());
        }
      }
    }
  }
  const others = drawn
    ? [...lettered.flatMap(({ routes }) => routes), ...unlettered].filter(
        (r) => !placed.has(String(r.codigo || '').trim().toUpperCase())
      )
    : unlettered;

  const sections = [
    ...(plano
      ? []
      : lettered.map(({ key, routes }, i) => ({
          label: vagonLabels[key] ? `Vagón ${escapeHTML(vagonLabels[key])}` : `Plataforma ${i + 1}`,
          routes,
          plan: wagonPlan[key],
        }))),
    // "Vagón único" is only true where there is no lettered platform to sit
    // beside; otherwise these are simply the services the catalog gives no
    // platform for, and only the station's signage can say which.
    ...(others.length
      ? [{
          label: lettered.length || drawn ? 'Otros servicios troncales' : 'Vagón único',
          // No single wagon's plan describes this list once a layout has mixed
          // lettered and unlettered leftovers into it, so it goes out flat
          // rather than under a direction it cannot vouch for.
          routes: others,
          plan: drawn ? undefined : wagonPlan['0'],
        }]
      : []),
    // Feeders stay one flat list: the plan gives them no direction (they are
    // excluded from it upstream), and the estación page lists them the same way.
    ...(feeders.length ? [{ label: 'Alimentadores y zonales', routes: feeders, plan: undefined }] : []),
  ];

  const html = sections
    .map(({ label, routes, plan }) => {
      const count = groupCatalogRoutesByDirection(routes).length;
      const body =
        buildDirectionRowsHtml(routes, plan) ?? `<div class="popup-route-tags">${formatRouteTags(routes)}</div>`;
      return `
          <div class="popup-wagon-section">
            <div class="popup-wagon-label">${label}<span class="popup-count">${count}</span></div>
            ${body}
          </div>
        `;
    })
    .join('');

  const serviceCount = groupCatalogRoutesByDirection([
    ...lettered.flatMap(({ routes }) => routes),
    ...unlettered,
    ...feeders,
  ]).length;
  const sectionCount = groupCatalogRoutesByDirection(
    sections.flatMap(({ routes }) => routes)
  ).length;

  return { plano, sections: html, serviceCount, sectionCount };
}

/**
 * The corridor directions for a resolved station, for the drawn plan's two edges.
 *
 * Read off the catalog stop the station resolved to, and only when it resolved
 * to exactly ONE — the same condition `vagonLabels` and `wagonPlan` are carried
 * under. A cluster assembled from several stops can straddle two corridors, and
 * labelling both its edges from one of them would name a direction the other
 * half does not run.
 */
function stationPlanSentidos(
  resolved: ResolvedCatalogStation | undefined
): { positive: string; negative: string } | undefined {
  if (!resolved || resolved.sourceStops.length !== 1) return undefined;
  const code = resolved.sourceStops[0]?.codigo;
  return code ? _catalog.stations[code]?.corridor?.sentidos : undefined;
}

/** The read-off shape for a resolved station, under the same single-stop
 *  condition: a layout describes one station's platforms, and a cluster
 *  assembled from several stops is not that station. */
function stationPlanLayout(
  resolved: ResolvedCatalogStation | undefined
): StationPlanoLayout | undefined {
  if (!resolved || resolved.sourceStops.length !== 1) return undefined;
  const code = resolved.sourceStops[0]?.codigo;
  return code ? _catalog.stations[code]?.planoLayout : undefined;
}

/** The popup's flavour of {@link buildStationWagonView}: one stacked block. */
function buildWagonSectionsHtml(
  wagons: ResolvedCatalogWagons,
  vagonLabels: Record<string, string> = {},
  wagonPlan: Record<string, CatalogPlanGroup[]> = {},
  sentidos?: { positive: string; negative: string },
  layout?: StationPlanoLayout
): string {
  const view = buildStationWagonView(wagons, vagonLabels, wagonPlan, sentidos, layout);
  return (view.plano ?? '') + view.sections || '<div class="popup-empty">Sin rutas disponibles</div>';
}

// ─── Catalog Lookup ─────────────────────────────────────

let _catalog: MasterCatalog = { stations: {}, routes: {} };
let _resolvedStations: Record<string, ResolvedCatalogStation> = {};
let _stationAudit: StationCatalogAudit[] = [];

export function setCatalog(catalog: MasterCatalog): void {
  _catalog = catalog;
  _resolvedStations = {};
  _stationAudit = [];
}

function publishStationAudit(): void {
  const total = _stationAudit.length;
  const unmatched = _stationAudit.filter((entry) => entry.matchMethod === 'unmatched').length;
  const verified = _stationAudit.filter((entry) => entry.matchMethod.startsWith('verified-split')).length;
  const platformClusters = _stationAudit.filter((entry) => entry.matchMethod.startsWith('platform-cluster')).length;

  if (typeof window !== 'undefined') {
    (window as Window & { __tmStationAudit?: StationCatalogAudit[] }).__tmStationAudit = _stationAudit;
  }

  console.info(
    `[Stations] Catalog audit: ${total - unmatched}/${total} matched, ` +
      `${verified} verified splits, ${platformClusters} platform clusters, ${unmatched} unmatched.`,
    _stationAudit
  );
}

// ─── Station Popup ──────────────────────────────────────

/**
 * The popup's link to the estación's own page (spec §5.5.6).
 *
 * A popup is a card over a map: it is 340 px wide, it sits on top of the thing
 * the reader is looking at, and it closes when they click away — so it shows the
 * plan small and the services abbreviated. The page is the same station with
 * room for it, plus the live arrivals board and the ridership figures, at a URL
 * that can be sent to somebody. This is how a rider gets there from the map.
 *
 * Built from the **catalog** stop, never from the rendered station: the URL is
 * the one the prerender publishes (`/estacion/<slug>-<codigo>/`, §5.5.4), and
 * that slug is the catalog's own name and code. A verified-split platform
 * (Av. Jiménez, Ricaurte) therefore links to the page for the stop both of its
 * platforms belong to, which is the page that exists.
 *
 * A real `<a href>` so it middle-clicks, copies and crawls; `pageShell.ts`
 * intercepts the plain left click into a `pushState` navigation.
 */
function stationPageLinkHtml(resolved: ResolvedCatalogStation | undefined): string {
  const stop = resolved?.sourceStops?.[0];
  const href = stop ? stationPageHref({ nombre: stop.nombre, codigo: stop.codigo }) : null;
  if (!href) return '';
  return `
    <a class="popup-page-link" href="${href}">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18"/><path d="M7 13h7"/><path d="M7 16.5h4"/></svg>
      <span>Ver página de la estación</span>
    </a>
  `;
}

/**
 * Everything the estación page needs about one station (spec §5.5.6).
 *
 * Assembled **catalog-first**, exactly like the prerendered page: the wagons,
 * the plan and the plate numbers all come from the catalog stop, so the page a
 * crawler reads and the page the bundle draws describe the same platform. The
 * rendered ArcGIS station only *enriches* it (corridor name, WiFi, biciestación)
 * and cannot subtract from it — a station whose ArcGIS point failed to load
 * still has a complete page (spec §4.2).
 */
export interface StationPageData {
  /** Catalog code (`TM0025`) — the id every other surface here files it under. */
  code: string;
  name: string;
  direccion: string;
  /** The troncal this station sits on ("Autonorte"), as the official station
   *  maps name it, falling back to ArcGIS's own station label. */
  corridor: string;
  /** That corridor's troncal letter, when it has one — the key its colour is
   *  drawn from (`TRONCAL_COLORS`, §5.4.3). */
  corridorLetter: string;
  /** What riders call that corridor's two directions — the pair the drawn plan
   *  puts along its two edges (§5.5.4). Absent where the corridor has no
   *  answered axis, and the plan then falls back to labelling each group. */
  corridorSentidos?: { positive: string; negative: string };
  /** The station's drawn shape, where the catalog's wagons cannot express it. */
  planoLayout?: StationPlanoLayout;
  coordinate: [number, number];
  wagons: ResolvedCatalogWagons;
  vagonLabels: Record<string, string>;
  wagonPlan: Record<string, CatalogPlanGroup[]>;
  /** Lettered platforms the catalog files for this stop. */
  platformCount: number;
  /** Station node ids (`codigo_nodo_estacion`) of the rendered platforms — the
   *  only id the open ridership dataset shares with this app (spec §5.8). */
  nodes: string[];
  wifi: boolean;
  bikeCapacity: number | null;
}

export function getStationPageData(code: string): StationPageData | null {
  const wanted = String(code || '').trim().toUpperCase();
  if (!wanted) return null;

  const station =
    _catalog.stations[wanted] ??
    Object.values(_catalog.stations).find((s) => String(s.codigo).toUpperCase() === wanted);
  if (!station) return null;

  const [lat, lng] = String(station.coordenada || '').split(',').map((n) => Number(n.trim()));
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

  // The catalog's TM code and ArcGIS's `numero_estacion` are different id spaces
  // (spec §5.4.1); the resolver is the only bridge between them.
  const platforms = Object.values(_resolvedStations).filter((resolved) =>
    resolved.sourceStops.some((stop) => stop.codigo.toUpperCase() === wanted)
  );
  const feature = platforms.length
    ? globalStations.find((s) => s.attributes.numero_estacion === platforms[0].stationCode)
    : undefined;

  const wagons = (station.wagons ?? {}) as ResolvedCatalogWagons;

  return {
    code: String(station.codigo || wanted).toUpperCase(),
    name: station.nombre,
    direccion: station.direccion || '',
    // The catalog's corridor is the answered one and names exactly one troncal;
    // ArcGIS's `troncal_estacion` is the fallback for a station the station-maps
    // source doesn't cover, where a label is still better than a blank line.
    corridor: station.corridor?.nombre || feature?.attributes.troncal_estacion || '',
    corridorLetter: station.corridor?.letra || '',
    corridorSentidos: station.corridor?.sentidos,
    planoLayout: station.planoLayout,
    coordinate: [lng, lat],
    wagons,
    vagonLabels: station.vagonLabels ?? {},
    wagonPlan: station.wagonPlan ?? {},
    // The catalog's lettered wagons, unless a sheet has been read — then it is
    // the vagones that sheet draws. The two differ at exactly the stations this
    // count matters most: CAN and Gobernación each file FOUR printed vagones
    // under two catalog wagons, and the header chip read "2 vagones" directly
    // above a drawing of four. A page must not contradict itself about the
    // station it is describing, and between the catalog's grouping and the sign
    // on the platform, the sign is what the rider is standing in front of.
    platformCount: station.planoLayout
      ? (station.planoLayout.rows ?? []).reduce((n, row) => n + (row.vagones?.length ?? 0), 0)
      : Object.keys(wagons).filter((key) => key !== '0').length,
    nodes: platforms.map((p) => p.stationNode).filter(Boolean),
    wifi: feature?.attributes.componente_wifi === 'SI',
    bikeCapacity:
      feature?.attributes.biciestacion_estacion === '1'
        ? Number(feature.attributes.capacidad_biciestacion_estacion) || null
        : null,
  };
}

function hasRenderedFeatureAtPoint(
  map: maplibregl.Map,
  e: maplibregl.MapLayerMouseEvent,
  layerIds: string[]
): boolean {
  const existingLayers = layerIds.filter((id) => map.getLayer(id));
  return existingLayers.length > 0 && map.queryRenderedFeatures(e.point, { layers: existingLayers }).length > 0;
}

function showStationPopup(
  map: maplibregl.Map,
  e: maplibregl.MapLayerMouseEvent
): void {
  if (hasRenderedFeatureAtPoint(map, e, ['stops-hitbox'])) return;
  if (!markClickHandled(e)) return;
  const feature = e.features?.[0];
  if (!feature || !feature.properties) return;

  const p = feature.properties;
  const coords = (feature.geometry as GeoJSON.Point).coordinates;
  const stationCode = p.stationCode || '';
  const stationName = p.name || '';
  const stationKey = String(p.stationKey || stationCode);

  const resolvedStation = _resolvedStations[stationKey];

  const wagonSections =
    resolvedStation && Object.keys(resolvedStation.wagons).length > 0
      ? buildWagonSectionsHtml(resolvedStation.wagons, resolvedStation.vagonLabels, resolvedStation.wagonPlan, stationPlanSentidos(resolvedStation), stationPlanLayout(resolvedStation))
      // Not "no routes serve this station" — the catalog simply files no wagon
      // assignment for it, and saying which is the difference between a data gap
      // and a claim about the network (spec §1).
      : '<div class="popup-empty">El catálogo oficial no asigna vagones a esta estación. Busca la estación por nombre para ver sus rutas.</div>';

  // Station meta
  const meta = [
    p.location,
    p.wagons ? `${p.wagons} vagones` : '',
    p.bike ? `Biciparqueo (${p.bikeCapacity})` : '',
    p.wifi === 'SI' ? 'WiFi' : '',
  ].filter(Boolean);

  const html = `
    <div class="popup-card">
      <div class="popup-eyebrow">${escapeHTML(p.corridor)}</div>
      <div class="popup-title">${escapeHTML(stationName)}</div>
      ${meta.length ? `<div class="popup-meta">${meta.map((item) => `<span>${escapeHTML(item)}</span>`).join('')}</div>` : ''}
      <div class="popup-wagon-container">
        ${wagonSections}
      </div>
      ${arrivalsSectionHtml(stationArrivalsCode(resolvedStation, stationCode))}
      ${planActionsHtml(stationName, coords as [number, number], stationCode, {
        lead: stationPageLinkHtml(resolvedStation),
      })}
    </div>
  `;

  showPopup(map, coords as [number, number], html, { offset: 12, maxWidth: '340px' });
  wirePlanoScroll();
  const arrCode = stationArrivalsCode(resolvedStation, stationCode);
  if (arrCode) void renderStopArrivals(arrCode, platformAllowedCodes(resolvedStation));
}

/**
 * Gives the plan inside the open popup the app's horizontal-row affordance —
 * wheel, mouse drag and the edge fades (`initChipRowScroll`, §5.4.2b).
 *
 * The popup's markup is a string handed to MapLibre, so there is no element to
 * wire until it is on the page; this runs straight after `showPopup`, where the
 * popup content is already in the DOM. A plan narrower than its box wires the
 * same way and simply never shows a fade.
 */
export function wirePlanoScroll(root: ParentNode = document): void {
  root.querySelectorAll<HTMLElement>('.popup-plano').forEach((plano) => {
    if (plano.classList.contains('chip-scroll')) return;
    initChipRowScroll(plano);
  });
}

// ─── Layer Setup ────────────────────────────────────────

/** One entry per rendered station, carrying the RESOLVED display name (verified
 *  splits included) so list UIs (Cerca, search) match the map labels instead of
 *  echoing raw ArcGIS names — e.g. both Av. Jiménez platforms arrive named
 *  "Temporal AV. Jiménez - Inter Eléctricas" upstream. Filled by addStationsLayer. */
export interface StationDisplayPoint {
  codigo: string;
  name: string;
  coordinate: [number, number];
  direccion: string;
}

let stationDisplayPoints: StationDisplayPoint[] = [];

export function getStationDisplayPoints(): StationDisplayPoint[] {
  return stationDisplayPoints;
}

/**
 * Resolves the station set against the catalog and turns it into the layer's
 * GeoJSON, refreshing the resolved-station index, the audit and the display
 * points. Shared by the initial render and by {@link updateStationsLayer}, so a
 * recovered ArcGIS payload lands on exactly the same pipeline (spec §1.1 R2).
 */
function prepareStations(stations: TroncalStationFeature[]): GeoJSON.FeatureCollection {
  globalStations = stations;
  const resolution = resolveStationCatalog(stations, _catalog);
  _resolvedStations = resolution.stationsByKey;
  _stationAudit = resolution.audit;
  publishStationAudit();

  // A station with no service filed at it is not drawn.
  //
  // This used to be a hard-coded list of three names (ISLANDIA, LOSLAURELES,
  // TIBANICAPRIMAVERA — ArcGIS files a station while it is still a building
  // site, and a pin whose popup has no services is worse than no pin). That list
  // could not know when they opened, so it kept the three newest estaciones in
  // Bogotá off the map for the whole month they were running.
  //
  // The catalog knows. Nine stations resolve to nothing today — Tercer Milenio,
  // Calle 19, Calle 45, Calle 63, Calle 76, Hospital and Temporal Calle 34, all
  // closed for the Metro Línea 1 works on Caracas, plus Patio Bonito
  // (remodelling) and SENA — and upstream files no service at any of them, which
  // is the same fact as "closed". They are still in the register, so they stay in
  // the audit; they simply stop being offered to a rider as somewhere a bus stops.
  //
  // The list moves, which is the point of not having one: Calle 72 was on it
  // until 2026-08-25, when the works swapped — it reopened as TM0002 with 18
  // services and Calle 76 (TM0001) took its place with none. Nothing here
  // changed for that; the catalog did.
  const visibleStations = stations.filter((station) => {
    const resolved = _resolvedStations[buildStationKey(station)];
    if (!resolved) return false;
    return Object.values(resolved.wagons).some((routes) => routes.length > 0);
  });
  const hidden = stations.length - visibleStations.length;
  if (hidden > 0) console.log(`🚧 ${hidden} estación(es) sin servicio en el catálogo — no se dibujan`);

  const geojson: GeoJSON.FeatureCollection = {
    type: 'FeatureCollection',
    features: visibleStations.map((s) => {
      const key = buildStationKey(s);
      const resolved = _resolvedStations[key];
      // Use resolved name from verified splits so split stations
      // (e.g. Av. Jiménez Caracas vs Av. Jiménez CL 13) show distinct labels.
      const displayName = resolved?.matchMethod.startsWith('verified-split')
        ? resolved.stationName
        : s.attributes.nombre_estacion;
      return {
        type: 'Feature',
        properties: {
          stationKey: key,
          name: displayName,
          stationCode: s.attributes.numero_estacion,
          stationNode: stationNode(s),
          corridor: s.attributes.troncal_estacion,
          location: s.attributes.ubicacion_estacion,
          wifi: s.attributes.componente_wifi,
          bike: s.attributes.biciestacion_estacion === '1',
          bikeCapacity: s.attributes.capacidad_biciestacion_estacion,
          wagons: s.attributes.numero_vagones_estacion,
          stationType: s.attributes.tipo_estacion,
        },
        geometry: {
          type: 'Point',
          coordinates: [s.geometry.x, s.geometry.y],
        },
      };
    }),
  };

  stationDisplayPoints = geojson.features
    .map((f) => ({
      codigo: String((f.properties as any)?.stationCode ?? ''),
      name: String((f.properties as any)?.name ?? ''),
      coordinate: (f.geometry as GeoJSON.Point).coordinates as [number, number],
      direccion: String((f.properties as any)?.location ?? ''),
    }))
    .filter((p) => p.name && Number.isFinite(p.coordinate[0]) && Number.isFinite(p.coordinate[1]));

  return geojson;
}

/**
 * Re-renders the station layer from a new station set — used when the recovery
 * pass finally gets the ArcGIS payload that failed at boot, so the catalog
 * fallback is upgraded in place (ArcGIS-only metadata included) instead of the
 * user having to reload. No-op before the layer exists.
 */
export function updateStationsLayer(
  map: maplibregl.Map,
  stations: TroncalStationFeature[]
): void {
  const source = map.getSource('stations') as maplibregl.GeoJSONSource | undefined;
  if (!source) return;
  source.setData(prepareStations(stations));
}

export function addStationsLayer(
  map: maplibregl.Map,
  stations: TroncalStationFeature[]
): void {
  // Idempotent: the recovery pass re-runs this once a degraded ArcGIS fetch
  // succeeds, and re-adding a live source throws.
  if (map.getSource('stations')) {
    updateStationsLayer(map, stations);
    return;
  }

  const geojson = prepareStations(stations);

  map.addSource('stations', { type: 'geojson', data: geojson });

  map.addLayer({
    id: 'stations-circle',
    type: 'symbol',
    source: 'stations',
    layout: {
      'icon-image': 'stop-red',
      'icon-size': ['interpolate', ['linear'], ['zoom'], 10, 0.5, 14, 0.65, 17, 0.85],
      'icon-allow-overlap': true,
      'icon-anchor': 'bottom',
    },
  });

  map.addLayer({
    id: 'stations-hitbox',
    type: 'circle',
    source: 'stations',
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 12, 14, 18, 17, 26],
      'circle-color': '#000000',
      'circle-opacity': 0,
    },
  });

  map.addLayer({
    id: 'stations-labels',
    type: 'symbol',
    source: 'stations',
    minzoom: 14,
    layout: {
      'text-field': ['get', 'name'],
      'text-font': ['Open Sans Bold'],
      'text-size': ['interpolate', ['linear'], ['zoom'], 14, 9, 17, 13],
      'text-offset': [0, 0.8],
      'text-anchor': 'top',
      'text-max-width': 10,
    },
    paint: {
      'text-color': '#FB2C17',
      'text-halo-color': '#0A0E17',
      'text-halo-width': 1.5,
      'text-opacity': ['interpolate', ['linear'], ['zoom'], 14, 0.6, 16, 1],
    },
  });

  map.on('click', 'stations-hitbox', (e) => showStationPopup(map, e));
  map.on('mouseenter', 'stations-hitbox', () => {
    map.getCanvas().style.cursor = 'pointer';
  });
  map.on('mouseleave', 'stations-hitbox', () => {
    map.getCanvas().style.cursor = '';
  });
}

/**
 * Catalog fallback for the base station layer (spec §4.2). ArcGIS is the
 * primary source of troncal stations, but when that fetch fails or comes back
 * empty (upstream flake, cold relay) the layer must not silently vanish — the
 * master catalog is required for the app to open at all and carries every
 * troncal station with coordinates and wagon data, so synthesize features
 * from it instead. ArcGIS-only metadata (wifi, biciestación) is simply absent.
 */
export function catalogStationsToFeatures(catalog: MasterCatalog): TroncalStationFeature[] {
  const features: TroncalStationFeature[] = [];
  let objectid = 1;

  for (const [key, station] of Object.entries(catalog.stations)) {
    // Classified by the server's own answer (`station.estacion`, stamped from
    // the official register) with the TM…-code shape as fallback — never from
    // sistema/tipoServicio, which the light catalog may omit on a real station
    // and would silently drop it exactly when ArcGIS already failed (§5.5.6;
    // same rule as the mobile twin).
    const isTroncal = isStationStopCode(String(station.codigo || key).trim());
    if (!isTroncal) continue;

    const [latRaw, lngRaw] = String(station.coordenada || '').split(',');
    const lat = Number(latRaw);
    const lng = Number(lngRaw);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;

    features.push({
      attributes: {
        objectid: objectid++,
        numero_estacion: station.codigo || key,
        nombre_estacion: station.nombre,
        ubicacion_estacion: station.direccion || '',
        troncal_estacion: 'TransMilenio',
        numero_vagones_estacion: Object.keys(station.wagons || {}).length,
        numero_accesos_estacion: 0,
        biciestacion_estacion: '0',
        capacidad_biciestacion_estacion: 0,
        tipo_estacion: 0,
        latitud_estacion: lat,
        longitud_estacion: lng,
        componente_wifi: '',
      },
      geometry: { x: lng, y: lat },
    });
  }
  return features;
}

export function toggleStationsLayer(map: maplibregl.Map, visible: boolean): void {
  const visibility = visible ? 'visible' : 'none';
  STATION_LAYERS.forEach((id) => {
    if (map.getLayer(id)) {
      map.setLayoutProperty(id, 'visibility', visibility);
    }
  });
}

export function bringStationsLayerToFront(map: maplibregl.Map): void {
  STATION_LAYERS.forEach((id) => {
    if (map.getLayer(id)) {
      map.moveLayer(id);
    }
  });
}

let globalStations: TroncalStationFeature[] = [];

export function showStationPopupByCode(map: maplibregl.Map, stationCode: string, coordinate: [number, number]): boolean {
  let resolvedStation: ResolvedCatalogStation | undefined;
  for (const station of Object.values(_resolvedStations)) {
    if (
      station.stationCode === stationCode ||
      station.stationKey === stationCode ||
      station.sourceStops.some(ss => ss.codigo === stationCode)
    ) {
      resolvedStation = station;
      break;
    }
  }

  if (!resolvedStation) return false;

  const wagonSections = buildWagonSectionsHtml(resolvedStation.wagons, resolvedStation.vagonLabels, resolvedStation.wagonPlan, stationPlanSentidos(resolvedStation), stationPlanLayout(resolvedStation));

  const stationFeature = globalStations.find(s =>
    s.attributes.numero_estacion === stationCode ||
    s.attributes.codigo_nodo_estacion === stationCode ||
    normalizeStationName(s.attributes.nombre_estacion) === normalizeStationName(resolvedStation!.stationName)
  );

  const corridor = stationFeature?.attributes.troncal_estacion || 'Estación troncal';

  const firstSource = resolvedStation.sourceStops[0];
  const location = firstSource ? firstSource.direccion : '';

  const html = `
    <div class="popup-card">
      <div class="popup-eyebrow">${escapeHTML(corridor)}</div>
      <div class="popup-title">${escapeHTML(resolvedStation.stationName)}</div>
      ${location ? `<div class="popup-meta"><span>${escapeHTML(location)}</span></div>` : ''}
      <div class="popup-wagon-container">
        ${wagonSections}
      </div>
      ${arrivalsSectionHtml(stationArrivalsCode(resolvedStation, stationCode))}
      ${planActionsHtml(resolvedStation.stationName, coordinate, stationCode, {
        lead: stationPageLinkHtml(resolvedStation),
      })}
    </div>
  `;

  showPopup(map, coordinate, html, { offset: 12, maxWidth: '340px' });
  wirePlanoScroll();
  const arrCode = stationArrivalsCode(resolvedStation, stationCode);
  if (arrCode) void renderStopArrivals(arrCode, platformAllowedCodes(resolvedStation));
  return true;
}
