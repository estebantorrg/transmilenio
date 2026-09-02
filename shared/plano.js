/**
 * The station plan, drawn once for every surface that draws it.
 *
 * There were two implementations, and they disagreed. The browser drew the
 * station from its sheet — four vagones at Guatoque, the caño, the Carrera 27
 * exit — while `prerender_seo.ts` drew its own from the catalog alone, so the
 * page a search result opens said "Plataforma 1 / Plataforma 2" and "2 vagones"
 * until the whole app had booted and replaced it. Same URL, two answers, and
 * the wrong one was the one strangers saw first.
 *
 * So this is the drawing, in the one place both can import it: the browser for
 * the estación page, and the prerenderer for the HTML that ships before any
 * script runs. Neither owns it, and neither can drift.
 *
 * It draws only the stations whose sheet has been READ — those with a
 * `planoLayout`, and the fuller `planoDetalle` where the furniture has been
 * read too. It returns null for the rest, and each caller keeps its existing
 * fallback for them: there is nothing to reconcile where nothing was read.
 *
 * Colour and links come in from the caller, because the two surfaces answer
 * them differently and neither answer belongs here. The prerenderer passes
 * `routeHref` so its chips are real anchors a crawler can follow; the browser
 * passes none and keeps the click handler it already has.
 */

/** @typedef {{ id?: string, codigo: string, nombre: string, color?: string, tipoServicio?: string, sistema?: string }} Route */

const AMP = /&/g;
const LT = /</g;
const GT = />/g;
const QUOT = /"/g;

export function escapeHtml(value) {
  return String(value ?? '')
    .replace(AMP, '&amp;')
    .replace(LT, '&lt;')
    .replace(GT, '&gt;')
    .replace(QUOT, '&quot;');
}

/** Accent- and punctuation-insensitive, for comparing names the two sources spell differently. */
export function normalizeName(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

function normalizeCode(value) {
  return String(value ?? '').trim().toUpperCase();
}

/**
 * The destination a chip is keyed by, with the catalog's abbreviation expanded.
 *
 * The catalog writes one destination two ways — El Tiempo files `K43` as both
 * `P. ElDorado` and `Portal Eldorado` — and keyed on the raw name that plate
 * drew two K43 chips under a sign that prints one. Every abbreviated
 * destination in the catalog is a portal, so expanding `P.` is enough.
 */
function destinationKey(nombre) {
  return normalizeName(String(nombre ?? '').replace(/^\s*P\.\s*/i, 'PORTAL '));
}

/**
 * Chips, grouped.
 *
 * `byCodeOnly` is what a PLATE does: one edge of one plate prints one chip per
 * código whatever the catalog files behind it. Ricaurte's Vagón 5 carries F19
 * and F23 each in two variants, and keyed per destination that plate read
 * "F19 F19 F23 F23" — four chips under a sign that prints two.
 */
function groupRoutes(routes, byCodeOnly) {
  const groups = new Map();
  for (const route of routes) {
    const codeKey = normalizeCode(route.codigo).replace(/[^A-Z0-9]/g, '');
    if (!codeKey) continue;
    const key = byCodeOnly ? codeKey : codeKey + '|' + destinationKey(route.nombre);
    const found = groups.get(key);
    if (found) found.routes.push(route);
    else groups.set(key, { code: route.codigo, primary: route, routes: [route] });
  }
  return Array.from(groups.values()).sort(
    (a, b) =>
      String(a.code).localeCompare(String(b.code), undefined, { numeric: true }) ||
      String(a.primary.nombre || '').localeCompare(String(b.primary.nombre || ''), undefined, {
        numeric: true,
      })
  );
}

/**
 * One chip per group.
 *
 * With `routeHref` the chip is a real anchor — that is how the prerendered page
 * keeps a station linked to the routes that serve it, which is half of the
 * cross-linking that stops those pages being orphaned. Without it the chip is
 * the span the app already wires a click handler to.
 */
function formatTags(routes, opts, byCodeOnly) {
  const groups = groupRoutes(routes, byCodeOnly);
  const visible = groups.slice(0, opts.limit ?? 28);
  const hidden = groups.length - visible.length;
  const tags = visible
    .map((group) => {
      const route = group.primary;
      const color = opts.tagColor(route);
      const names = Array.from(new Set(group.routes.map((r) => r.nombre).filter(Boolean)));
      const title = names.join(' / ') || route.nombre || '';
      const href = opts.routeHref ? opts.routeHref(route) : null;
      const style = ' style="background:' + color + ';"';
      const attrs =
        ' title="' + escapeHtml(title) + '"' + style + ' data-route-code="' + escapeHtml(route.codigo) + '"';
      if (href) {
        return '<a class="route-tag" href="' + escapeHtml(href) + '"' + attrs + '>' + escapeHtml(route.codigo) + '</a>';
      }
      const routeId = group.routes.length === 1 && route.id ? 'catalog-' + route.id : '';
      return (
        '<span class="route-tag clickable" data-route-id="' +
        escapeHtml(routeId) +
        '"' +
        attrs +
        '>' +
        escapeHtml(route.codigo) +
        '</span>'
      );
    })
    .join('');
  return hidden > 0 ? tags + '<span class="route-tag muted">+' + hidden + '</span>' : tags;
}

/** What a divider is called. `tunel` is the only one that is a way through. */
export const DIVIDER_NAMES = {
  busway: 'calzada',
  ciclorruta: 'ciclorruta',
  cano: 'caño',
  tren: 'vía férrea',
  separador: 'separador verde',
  tunel: 'túnel peatonal',
};

const W = '#FFFFFF';

/**
 * The station furniture, traced from the *Convenciones* block every plano
 * prints down its left edge. Colour is part of the mark: the emergency exit is
 * green and the priority lift is blue by law, everything else is a black tile
 * with the glyph knocked out.
 */
export const ICONOS = {
  taquilla: {
    label: 'Taquilla',
    bg: '#0E0E10',
    svg:
      '<g transform="rotate(-20 12 11)"><rect x="5.6" y="4.4" width="12.8" height="12.8" rx="0.9" fill="none" stroke="' +
      W +
      '" stroke-width="2"/></g>' +
      '<path d="M11.6 11.1c0-.75.6-1.35 1.35-1.35s1.35.6 1.35 1.35v2.85l1.5-.85c.6-.34 1.36-.13 1.7.47.34.6.13 1.36-.47 1.7l-3.3 1.9c-.3.17-.63.26-.97.26h-2.2c-1.05 0-1.9-.85-1.9-1.9v-3.05c0-.75.6-1.35 1.35-1.35h1.59z" fill="' +
      W +
      '"/>',
  },
  torniquete: {
    label: 'Torniquetes',
    bg: '#0E0E10',
    svg:
      '<rect x="4.6" y="7.6" width="4.6" height="11.4" rx="1.3" fill="' + W + '"/>' +
      '<rect x="14.8" y="7.6" width="4.6" height="11.4" rx="1.3" fill="' + W + '"/>' +
      '<path d="M5.3 10.6 6.9 7.9 8.5 10.6z" fill="#0E0E10"/>' +
      '<path d="M15.5 10.6 17.1 7.9 18.7 10.6z" fill="#0E0E10"/>' +
      '<path d="M9.4 13.1 14.6 15.6" stroke="' + W + '" stroke-width="1.5" stroke-linecap="round"/>',
  },
  rampa: {
    label: 'Rampa peatonal',
    bg: '#0E0E10',
    svg:
      '<path d="M4.4 19.2 19.6 5.6" stroke="' + W + '" stroke-width="2.1" stroke-linecap="round"/>' +
      '<path d="M4.2 8.6 8.4 4.6M8.4 4.6H5.3M8.4 4.6v3.1" stroke="' + W + '" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" fill="none"/>' +
      '<path d="M19.8 16.2 15.6 20.2M15.6 20.2h3.1M15.6 20.2v-3.1" stroke="' + W + '" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" fill="none"/>',
  },
  escalera: {
    label: 'Escalera peatonal',
    bg: '#0E0E10',
    svg:
      '<path d="M4.4 19.4h3.6v-3.6h3.6v-3.6h3.6V8.6h3.6" stroke="' + W + '" stroke-width="2.1" fill="none" stroke-linejoin="round"/>' +
      '<path d="M4.2 8.6 8.4 4.6M8.4 4.6H5.3M8.4 4.6v3.1" stroke="' + W + '" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" fill="none"/>' +
      '<path d="M19.8 16.2 15.6 20.2M15.6 20.2h3.1M15.6 20.2v-3.1" stroke="' + W + '" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" fill="none"/>',
  },
  emergencia: {
    label: 'Salida de emergencia',
    bg: '#2E9E4F',
    svg:
      '<circle cx="13.6" cy="4.9" r="2" fill="' + W + '"/>' +
      '<path d="M12.9 8.1c-.5.15-.95.45-1.3.85l-2.5 2.9c-.35.4-.35 1 .05 1.35.4.35 1 .3 1.35-.1l1.5-1.7.75 2.4-2.6 2.9c-.2.25-.3.55-.25.85l.6 3.3c.1.55.6.9 1.15.8.55-.1.9-.6.8-1.15l-.5-2.75 2.35-2.6 1.15 3.05c.1.3.35.55.65.65l2.6.75c.55.15 1.1-.15 1.25-.7.15-.55-.15-1.1-.7-1.25l-2.1-.6-1.7-4.7c-.2-.6-.55-1.1-1-1.5l-1.55-1.35c-.4-.35-.9-.5-1.45-.4z" fill="' + W + '"/>' +
      '<path d="M8.2 8.6 5.1 9.8" stroke="' + W + '" stroke-width="1.7" stroke-linecap="round"/>',
  },
  ascensor: {
    label: 'Ascensor prioritario',
    bg: '#1B5FA8',
    svg:
      '<circle cx="11.4" cy="4.8" r="2" fill="' + W + '"/>' +
      '<path d="M9.6 8.2v5.1c0 .7.55 1.25 1.25 1.25h3.6l2.5 5.3" stroke="' + W + '" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>' +
      '<path d="M15.9 13.6a5.4 5.4 0 1 1-6.6-4.1" stroke="' + W + '" stroke-width="1.9" fill="none" stroke-linecap="round"/>',
  },
  bici: {
    label: 'TransMiBici',
    bg: '#0E0E10',
    svg:
      '<path d="M4.4 5.9h10.2M9.5 5.9v12.4" stroke="' + W + '" stroke-width="2.4" stroke-linecap="round"/>' +
      '<circle cx="14.6" cy="16.4" r="2.9" fill="none" stroke="' + W + '" stroke-width="1.5"/>' +
      '<circle cx="20.1" cy="16.4" r="2.9" fill="none" stroke="' + W + '" stroke-width="1.5"/>' +
      '<path d="M14.6 16.4 16.6 11.9h2.4" stroke="' + W + '" stroke-width="1.4" fill="none" stroke-linecap="round"/>',
  },
  cable: {
    label: 'Conexión con TransMiCable',
    bg: '#0E0E10',
    svg:
      '<path d="M8.2 4.8h7.6l3.4 3.4v7.6l-3.4 3.4H8.2L4.8 15.8V8.2z" fill="none" stroke="' + W + '" stroke-width="1.8" stroke-linejoin="round"/>' +
      '<path d="M12.4 5.2h3.4l3.4 3.4v7.2l-3.4 3.4h-3.4z" fill="' + W + '"/>',
  },
  zonal: {
    label: 'Conexión con servicio zonal',
    bg: '#0E0E10',
    svg:
      '<rect x="4.6" y="4.6" width="14.8" height="12.4" rx="1.6" fill="none" stroke="' + W + '" stroke-width="1.8"/>' +
      '<path d="M4.6 9.4h14.8" stroke="' + W + '" stroke-width="1.6"/>' +
      '<path d="M7.4 17.2v2.2M16.6 17.2v2.2" stroke="' + W + '" stroke-width="1.8" stroke-linecap="round"/>',
  },
};

function iconHtml(name) {
  const icon = ICONOS[name];
  if (!icon) return '';
  return (
    '<span class="pdt-icono" role="img" aria-label="' + escapeHtml(icon.label) + '" title="' +
    escapeHtml(icon.label) + '" style="background:' + icon.bg + '">' +
    '<svg viewBox="0 0 24 24" aria-hidden="true">' + icon.svg + '</svg></span>'
  );
}

function iconsHtml(names) {
  const drawn = (names ?? []).map(iconHtml).filter(Boolean).join('');
  return drawn ? '<span class="pdt-iconos">' + drawn + '</span>' : '';
}

/** Two stacked bars, as printed: yellow "Salida / Exit" over the street. */
function salidaHtml(salida) {
  const arrow = salida.hacia === 'der' ? 'der' : 'izq';
  return (
    '<span class="pdt-salida pdt-salida-' + arrow + '">' +
    '<span class="pdt-salida-top"><span class="pdt-salida-arrow" aria-hidden="true"></span>' +
    '<span class="pdt-salida-tag">Salida</span></span>' +
    '<span class="pdt-salida-calle">' + escapeHtml(salida.calle) + '</span></span>'
  );
}

/**
 * A salida sits in the MIDDLE band whenever the middle band is empty — the
 * widest, quietest place in the block. Where something already occupies the
 * middle, as at Av. Chile whose torniquetes are between the platforms, it falls
 * back to its own band and never displaces what is there.
 */
function salidasFor(col, fila) {
  const centroLibre = (col.centro ?? []).length === 0;
  return (col.salidas ?? [])
    .filter((s) => {
      const suya = centroLibre ? 'centro' : s.fila ?? 'abajo';
      return suya === fila || (suya === 'ambas' && fila !== 'centro');
    })
    .map(salidaHtml)
    .join('');
}

function midBand(divider, label, extra) {
  const cls = divider ? ' pdt-divider pdt-divider-' + escapeHtml(divider) : '';
  return (
    '<div class="pdt-band pdt-band-mid' + cls + '">' + (extra || '') +
    (divider && label ? '<span class="pdt-divider-name">' + escapeHtml(label) + '</span>' : '') +
    '</div>'
  );
}

function columnaHtml(col, cellArriba, cellAbajo, divider, label) {
  if (col.t === 'vestibulo') {
    return (
      '<div class="pdt-col pdt-vestibulo">' +
      '<div class="pdt-band pdt-band-a">' + salidasFor(col, 'arriba') + iconsHtml(col.arriba) + '</div>' +
      midBand(undefined, '', salidasFor(col, 'centro') + iconsHtml(col.centro)) +
      '<div class="pdt-band pdt-band-b">' + salidasFor(col, 'abajo') + iconsHtml(col.abajo) + '</div>' +
      '</div>'
    );
  }
  if (col.t === 'puente') {
    return (
      '<div class="pdt-col pdt-puente">' +
      '<span class="pdt-puente-deck" aria-hidden="true"></span>' +
      '<span class="pdt-puente-iconos">' + iconsHtml(col.sube ?? ['escalera']) + '</span>' +
      '<span class="pdt-puente-txt">' + escapeHtml(col.nombre || 'Puente peatonal') + '</span>' +
      '</div>'
    );
  }
  if (col.t === 'paso') {
    return (
      '<div class="pdt-col pdt-paso">' +
      '<div class="pdt-band pdt-band-a"><span class="pdt-paso-mark" aria-hidden="true"></span></div>' +
      midBand(divider, '') +
      '<div class="pdt-band pdt-band-b"><span class="pdt-paso-mark" aria-hidden="true"></span></div>' +
      '</div>'
    );
  }
  return (
    '<div class="pdt-col pdt-vagones">' +
    '<div class="pdt-band pdt-band-a">' + cellArriba(col.arriba) + '</div>' +
    midBand(divider, label) +
    '<div class="pdt-band pdt-band-b">' + cellAbajo(col.abajo) + '</div>' +
    '</div>'
  );
}

function convencionesHtml(columnas) {
  const seen = [];
  const add = (names) => {
    for (const n of names ?? []) if (ICONOS[n] && seen.indexOf(n) < 0) seen.push(n);
  };
  for (const col of columnas) {
    if (col.t === 'vestibulo') {
      add(col.arriba);
      add(col.centro);
      add(col.abajo);
    } else if (col.t === 'puente') add(col.sube ?? ['escalera']);
  }
  if (seen.length === 0) return '';
  const items = seen
    .map((n) => '<span class="pdt-conv">' + iconHtml(n) + '<span class="pdt-conv-txt">' + escapeHtml(ICONOS[n].label) + '</span></span>')
    .join('');
  return '<div class="pdt-convenciones"><span class="pdt-conv-tag">Convenciones</span>' + items + '</div>';
}

function axisHtml(name, side) {
  return name
    ? '<div class="pvg-axis pvg-axis-' + side + '"><span class="pvg-axis-name">' + escapeHtml(name) + '</span></div>'
    : '';
}

/**
 * The station drawn from its sheet, or null where no sheet has been read.
 *
 * @param {object} input
 * @param {Record<string, Route[]>} input.wagons
 * @param {any} [input.layout]        `planoLayout`
 * @param {any} [input.detalle]       `planoDetalle`
 * @param {Record<string, any[]>} [input.wagonPlan]
 * @param {{positive: string, negative: string}} [input.sentidos]
 * @param {Set<string>} [input.presentWagons]
 * @param {(route: Route) => string} input.tagColor
 * @param {(route: Route) => boolean} input.isZonal
 * @param {(route: Route) => (string|null)} [input.routeHref]
 * @returns {{ html: string, detallado: boolean, placed: Set<string> } | null}
 */
export function buildSheetPlano(input) {
  const layout = input.layout;
  if (!layout || !(layout.rows ?? []).length) return null;

  /** Every route at the station, wagon "0" included: a sheet places services
   *  the catalog left without a platform, which is half of why it is read. */
  const byCode = new Map();
  for (const routes of Object.values(input.wagons ?? {})) {
    for (const route of routes) {
      const key = normalizeCode(route.codigo);
      if (!key) continue;
      const bucket = byCode.get(key);
      if (bucket) bucket.push(route);
      else byCode.set(key, [route]);
    }
  }

  const sentidoById = new Map();
  for (const groups of Object.values(input.wagonPlan ?? {})) {
    for (const group of groups ?? []) {
      if (!group.sentido) continue;
      for (const id of group.ids ?? []) sentidoById.set(String(id), group.sentido);
    }
  }

  const sentidos = input.sentidos;
  const boardsOn = (route, side) => {
    if (!sentidos) return true;
    const want = side === 'a' ? sentidos.positive : sentidos.negative;
    const sentido = sentidoById.get(String(route.id ?? ''));
    // Absence of a direction is not evidence of the opposite one.
    return sentido === undefined || sentido === want;
  };

  const rowIsPresent = (row) =>
    !input.presentWagons || !(row.wagones ?? []).length
      ? true
      : row.wagones.some((w) => input.presentWagons.has(normalizeCode(w)));

  const cells = new Map();
  const placed = new Set();
  const tagOpts = { tagColor: input.tagColor, routeHref: input.routeHref };

  const rows = (layout.rows ?? []).map((row, rowIndex) => {
    if (!rowIsPresent(row)) return null;
    const decks = (row.vagones ?? [])
      .map((vagon) => {
        const wantedFor = (side) =>
          (side === 'b' ? vagon.destinosAbajo ?? vagon.destinos : vagon.destinos) ?? {};
        const membersFor = (codigos, side) =>
          (codigos ?? []).flatMap((codigo) => {
            const all = byCode.get(normalizeCode(codigo)) ?? [];
            // The filters may only NARROW a código the sheet lists, never erase
            // it: the sheet is what says this service boards this edge.
            const byDirection = all.filter((r) => boardsOn(r, side));
            const variants = byDirection.length > 0 ? byDirection : all;
            const wanted = wantedFor(side);
            const destino = wanted[codigo] ?? wanted[normalizeCode(codigo)];
            if (!destino) return variants;
            const picked = variants.filter((r) => normalizeName(r.nombre) === normalizeName(destino));
            return picked.length > 0 ? picked : variants;
          });

        for (const c of [...(vagon.arriba ?? []), ...(vagon.abajo ?? [])]) placed.add(normalizeCode(c));

        const above = membersFor(vagon.arriba, 'a');
        const below = membersFor(vagon.abajo, 'b');
        if (above.length === 0 && below.length === 0) return null;
        const count = groupRoutes(above, true).length + groupRoutes(below, true).length;
        const tags = (members) =>
          members.length
            ? '<div class="pvg-group"><div class="popup-route-tags">' + formatTags(members, tagOpts, true) + '</div></div>'
            : '';
        const cell =
          '<section class="pvg" aria-label="Vagón ' + escapeHtml(vagon.vagon) + '">' +
          '<div class="pvg-side pvg-side-a">' + tags(above) + '</div>' +
          '<div class="pvg-deck"><span class="pvg-doors" aria-hidden="true"></span>' +
          '<div class="pvg-plate"><span class="pvg-name">Vagón ' + escapeHtml(vagon.vagon) + '</span>' +
          '<span class="pvg-sub" data-n="' + count + '">' + count + '</span></div>' +
          '<span class="pvg-doors" aria-hidden="true"></span></div>' +
          '<div class="pvg-side pvg-side-b">' + tags(below) + '</div>' +
          '</section>';
        // Keyed by ROW and vagón, never by vagón alone: Av. Chile draws the same
        // three vagones once per carriageway, so both its rows are "3, 2, 1".
        cells.set(rowIndex + ':' + String(vagon.vagon), cell);
        return cell;
      })
      .filter(Boolean);
    if (decks.length === 0) return null;
    const crossing =
      '<div class="pvg-gap" aria-hidden="true"><div class="pvg-gap-deck"><span class="pvg-gap-mark"></span></div></div>';
    const offset = Number(row.offset) || 0;
    const style = offset > 0 ? ' style="--pvg-offset:' + offset + '"' : '';
    return {
      row,
      html: '<div class="pvg-row"' + style + '><div class="popup-plano-cols">' + decks.join(crossing) + '</div></div>',
      usesA: (row.vagones ?? []).some((v) => (v.arriba ?? []).length > 0),
      usesB: (row.vagones ?? []).some((v) => (v.abajo ?? []).length > 0),
    };
  });

  const drawn = rows.filter(Boolean);
  if (drawn.length === 0) return null;

  const label = layout.divider ? DIVIDER_NAMES[layout.divider] ?? '' : '';

  // The full station, where its furniture has been read too.
  const columnas = input.detalle?.columnas ?? [];
  if (columnas.length > 0) {
    const first = columnas.findIndex((c) => c.t === 'vagones' || c.t === 'paso');
    const cellArriba = (v) => (v ? cells.get('0:' + String(v)) ?? '' : '');
    const cellAbajo = (v) => (v ? cells.get('1:' + String(v)) ?? cells.get('0:' + String(v)) ?? '' : '');
    const html =
      '<div class="popup-plano popup-plano-detalle" role="group" aria-label="Plano de la estación" tabindex="0">' +
      '<div class="popup-plano-inner">' +
      axisHtml(sentidos?.positive, 'a') +
      '<div class="pdt-grid">' +
      columnas
        .map((c, i) => columnaHtml(c, cellArriba, cellAbajo, layout.divider, i === first ? label : ''))
        .join('') +
      '</div>' +
      axisHtml(sentidos?.negative, 'b') +
      '</div>' +
      convencionesHtml(columnas) +
      '</div>';
    return { html, detallado: true, placed };
  }

  // Otherwise the platforms alone, with each row naming its own corridor where
  // the two halves are on different troncals (Ricaurte, Av. Jiménez).
  const perRow = drawn.some((r) => r.row.eje);
  const divider =
    '<div class="pvg-divider pvg-divider-' + escapeHtml(layout.divider ?? 'plain') + '">' +
    (label ? '<span class="pvg-divider-name">' + escapeHtml(label) + '</span>' : '') +
    '</div>';
  const body = perRow
    ? drawn
        .map((r) => axisHtml(r.row.eje?.arriba, 'a') + r.html + axisHtml(r.row.eje?.abajo, 'b'))
        .join(divider)
    : axisHtml(drawn.some((r) => r.usesA) ? sentidos?.positive : undefined, 'a') +
      drawn.map((r) => r.html).join(divider) +
      axisHtml(drawn.some((r) => r.usesB) ? sentidos?.negative : undefined, 'b');

  return {
    html:
      '<div class="popup-plano popup-plano-split" role="group" aria-label="Plano de la estación" tabindex="0">' +
      '<div class="popup-plano-inner">' + body + '</div></div>',
    detallado: false,
    placed,
  };
}
