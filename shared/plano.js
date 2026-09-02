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
 * The station furniture.
 *
 * The taquilla is the operator's own artwork — its shape is specific and every
 * attempt at redrawing it by eye came out a blob. Everything else here is
 * MATERIAL SYMBOLS ROUNDED, vendored as path data (Apache-2.0) rather than
 * loaded from a font, so the drawing needs no network and cannot render as
 * empty boxes while a webfont arrives. The walking figure in a crossing is
 * custom too, and lives with the marks rather than here.
 *
 * Each is chosen for what is ACTUALLY at that spot rather than for the word: a
 * torniquete is a barrier you pass through, so it is `toll`, the gate.
 *
 * Colour is part of the mark. The emergency exit is green and the priority
 * lift is blue by law; everything else is a black tile with the glyph knocked
 * out, which is how the sheets print them.
 */
export const ICONOS = {
  taquilla: {
    label: 'Taquilla',
    bg: '#0E0E10',
    svg:
      // The operator's own artwork, supplied by the maintainer rather than
      // traced: the ticket window as a filled slab with a hand reaching into
      // it. Three passes at redrawing this by eye all failed, because the
      // shape is specific and an approximation of it is just a blob.
      '<path d="M0 23.8C7.97333 15.88 15.84 7.85333 23.88 0C29.5467 5.14667 34.72 10.8133 40.2533 16.0933C36.4267 20.7733 31.8133 24.7333 27.64 29.1067C25.8267 26.4133 24.2267 23.5733 22.1867 21.04C19.44 17.7467 12.9333 20.5467 13.5333 24.8533C14.3467 29.6133 16.4933 34 17.8933 38.5867L17.2267 39.7333L15.8933 39.88C10.4533 34.68 5 29.44 0 23.8Z" fill="' + W + '"/>' +
      '<path d="M16.2799 22.84C17.7732 21.3733 19.9865 21.8933 21.0399 23.56C23.1999 26.64 25.1465 29.88 27.0399 33.1333C31.3332 30.5333 33.7599 25.7466 38.1999 23.36C40.2399 31.32 37.6132 39.9066 40.3599 47.68C36.0799 49.7866 31.9599 52.2533 27.5332 54.0533C23.2665 46 20.3865 37.3333 16.9465 28.9066C16.3332 26.9733 14.9065 24.8 16.2799 22.84Z" fill="' + W + '"/>',
    vb: '0 0 41 55',
  },
  torniquete: {
    label: 'Torniquetes',
    bg: '#0E0E10',
    // Hand-drawn, and staying that way: two pillars notched at the top with
    // the arm between them, traced from the Convenciones block. Material
    // Symbols has no turnstile at all, and its nearest stand-in — `toll`, a
    // toll gate — did not read as one. This is the mark on the wall.
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
    // Hand-drawn, and staying that way: the slope with an arrow up one way and
    // down the other, off the Convenciones block. Material Symbols has no
    // pedestrian ramp, and its nearest stand-in — `accessible`, the wheelchair
    // — is a different statement: it says step-free access, where the sheet
    // says which way the slope runs.
    svg:
      '<path d="M4.4 19.2 19.6 5.6" stroke="' + W + '" stroke-width="2.1" stroke-linecap="round"/>' +
      '<path d="M4.2 8.6 8.4 4.6M8.4 4.6H5.3M8.4 4.6v3.1" stroke="' + W + '" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" fill="none"/>' +
      '<path d="M19.8 16.2 15.6 20.2M15.6 20.2h3.1M15.6 20.2v-3.1" stroke="' + W + '" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" fill="none"/>',
  },
  escalera: {
    label: 'Escalera peatonal',
    bg: '#0E0E10',
    material: 'stairs',
    svg:
      '<path d="M417-373h63q17 0 28.5-11.5T520-413v-93h63q17 0 28.5-11.5T623-546v-94h57q17 0 28.5-11.5T720-680q0-17-11.5-28.5T680-720h-97q-17 0-28.5 11.5T543-680v93h-63q-17 0-28.5 11.5T440-547v93h-63q-17 0-28.5 11.5T337-414v94h-57q-17 0-28.5 11.5T240-280q0 17 11.5 28.5T280-240h97q17 0 28.5-11.5T417-280v-93ZM200-120q-33 0-56.5-23.5T120-200v-560q0-33 23.5-56.5T200-840h560q33 0 56.5 23.5T840-760v560q0 33-23.5 56.5T760-120H200Zm0-80h560v-560H200v560Zm0-560v560-560Z" fill="' + W + '"/>',
    vb: '0 -960 960 960',
  },
  emergencia: {
    label: 'Salida de emergencia',
    bg: '#2E9E4F',
    material: 'directions_run',
    svg:
      '<path d="M520-80v-200l-84-80-31 138q-4 16-17.5 24.5T358-192l-198-40q-17-3-26-17t-6-31q3-17 17-26.5t31-5.5l152 32 64-324-72 28v96q0 17-11.5 28.5T280-440q-17 0-28.5-11.5T240-480v-122q0-12 6.5-21.5T264-638l134-58q35-15 51.5-19.5T480-720q21 0 39 11t29 29l40 64q21 34 54.5 59t77.5 33q17 3 28.5 15t11.5 29q0 17-11.5 28t-27.5 9q-54-8-101-33.5T540-540l-24 120 72 68q6 6 9 13.5t3 15.5v243q0 17-11.5 28.5T560-40q-17 0-28.5-11.5T520-80Zm-36.5-683.5Q460-787 460-820t23.5-56.5Q507-900 540-900t56.5 23.5Q620-853 620-820t-23.5 56.5Q573-740 540-740t-56.5-23.5Z" fill="' + W + '"/>',
    vb: '0 -960 960 960',
  },
  ascensor: {
    label: 'Ascensor prioritario',
    bg: '#1B5FA8',
    material: 'elevator',
    svg:
      '<path d="M280-400v120q0 17 11.5 28.5T320-240h40q17 0 28.5-11.5T400-280v-120q11-11 25.5-17.5T440-440v-60q0-33-23.5-56.5T360-580h-40q-33 0-56.5 23.5T240-500v60q0 16 14.5 22.5T280-400Zm95.5-234.5Q390-649 390-670t-14.5-35.5Q361-720 340-720t-35.5 14.5Q290-691 290-670t14.5 35.5Q319-620 340-620t35.5-14.5ZM556-520h128q12 0 17.5-10.5T701-551l-64-102q-6-10-17-10t-17 10l-64 102q-6 10-.5 20.5T556-520Zm81 213 64-102q6-10 .5-20.5T684-440H556q-12 0-17.5 10.5t.5 20.5l64 102q6 10 17 10t17-10ZM200-120q-33 0-56.5-23.5T120-200v-560q0-33 23.5-56.5T200-840h560q33 0 56.5 23.5T840-760v560q0 33-23.5 56.5T760-120H200Zm0-80h560v-560H200v560Zm0 0v-560 560Z" fill="' + W + '"/>',
    vb: '0 -960 960 960',
  },
  bici: {
    label: 'TransMiBici',
    bg: '#0E0E10',
    material: 'pedal_bike',
    svg:
      '<path d="M200-160q-85 0-142.5-57.5T0-360q0-85 58.5-142.5T200-560q77 0 129.5 46T396-400h26l-72-200h-30q-17 0-28.5-11.5T280-640q0-17 11.5-28.5T320-680h120q17 0 28.5 11.5T480-640q0 17-11.5 28.5T440-600h-4l14 40h192l-58-160h-64q-17 0-28.5-11.5T480-760q0-17 11.5-28.5T520-800h64q26 0 46.5 14t29.5 38l68 186h32q83 0 141.5 58.5T960-362q0 84-58 143t-142 59q-72 0-126.5-45T564-320H396q-14 69-68 114.5T200-160Zm0-80q41 0 70.5-22.5T312-320h-72q-17 0-28.5-11.5T200-360q0-17 11.5-28.5T240-400h72q-12-36-41.5-58T200-480q-51 0-85.5 34.5T80-360q0 50 34.5 85t85.5 35Zm308-160h56q5-23 13.5-43t22.5-37H478l30 80Zm252 160q51 0 85.5-35t34.5-85q0-51-34.5-85.5T760-480h-4l26 69q6 16-1 30.5T758-360q-16 6-31-1t-21-23l-24-68q-20 17-31 40t-11 52q0 50 34.5 85t85.5 35ZM196-360Zm564 0Z" fill="' + W + '"/>',
    vb: '0 -960 960 960',
  },
  cable: {
    label: 'Conexión con TransMiCable',
    bg: '#0E0E10',
    material: 'cable_car',
    svg:
      '<path d="M160-160q-17 0-28.5-11.5T120-200q0-17 11.5-28.5T160-240v-480q-17 0-28.5-11.5T120-760q0-17 11.5-28.5T160-800h93l18-53q4-12 14.5-19.5T309-880h342q13 0 23.5 7.5T689-853l18 53h93q17 0 28.5 11.5T840-760q0 17-11.5 28.5T800-720v480q17 0 28.5 11.5T840-200q0 17-11.5 28.5T800-160H680q0 17-11.5 28.5T640-120H320q-17 0-28.5-11.5T280-160H160Zm80-360h120v-140q0-25-17.5-42.5T300-720q-25 0-42.5 17.5T240-660v140Zm180 0h120v-140q0-25-17.5-42.5T480-720q-25 0-42.5 17.5T420-660v140Zm180 0h120v-140q0-25-17.5-42.5T660-720q-25 0-42.5 17.5T600-660v140ZM240-240h480v-200H240v200Zm282.5-57.5Q540-315 540-340t-17.5-42.5Q505-400 480-400t-42.5 17.5Q420-365 420-340t17.5 42.5Q455-280 480-280t42.5-17.5ZM240-440h480-480Z" fill="' + W + '"/>',
    vb: '0 -960 960 960',
  },
  zonal: {
    label: 'Conexión con servicio zonal',
    bg: '#0E0E10',
    material: 'directions_bus',
    svg:
      '<path d="M320-200v20q0 25-17.5 42.5T260-120q-25 0-42.5-17.5T200-180v-62q-18-20-29-44.5T160-340v-380q0-83 77-121.5T480-880q172 0 246 37t74 123v380q0 29-11 53.5T760-242v62q0 25-17.5 42.5T700-120q-25 0-42.5-17.5T640-180v-20H320Zm162-560h224-448 224Zm158 280H240h480-80Zm-400-80h480v-120H240v120Zm142.5 222.5Q400-355 400-380t-17.5-42.5Q365-440 340-440t-42.5 17.5Q280-405 280-380t17.5 42.5Q315-320 340-320t42.5-17.5Zm280 0Q680-355 680-380t-17.5-42.5Q645-440 620-440t-42.5 17.5Q560-405 560-380t17.5 42.5Q595-320 620-320t42.5-17.5ZM258-760h448q-15-17-64.5-28.5T482-800q-107 0-156.5 12.5T258-760Zm62 480h320q33 0 56.5-23.5T720-360v-120H240v120q0 33 23.5 56.5T320-280Z" fill="' + W + '"/>',
    vb: '0 -960 960 960',
  },};

function iconHtml(name) {
  const icon = ICONOS[name];
  if (!icon) return '';
  return (
    '<span class="pdt-icono" role="img" aria-label="' + escapeHtml(icon.label) + '" title="' +
    escapeHtml(icon.label) + '" style="background:' + icon.bg + '">' +
    '<svg viewBox="' + (icon.vb || '0 0 24 24') + '" aria-hidden="true">' + icon.svg + '</svg></span>'
  );
}

/**
 * The marks a plano draws ON the plan, as opposed to in its legend.
 *
 * The sheets use two registers and they are not interchangeable. Equipment —
 * a taquilla, a torniquete — is a BLACK TILE with the glyph knocked out.
 * Wayfinding — which way the ramp runs, where the emergency exit is — is a
 * plain WHITE MARK straight on the grey: a triangle for the ramp, a running
 * figure for the exit. The legend explains them with the fuller glyph; the
 * plan itself uses the mark. Drawing a ramp as a black tile put a piece of
 * equipment where the station has only an arrow.
 */
/**
 * The figure in a crossing is a PERSON WALKING, and nothing more.
 *
 * It was drawn with the emergency-exit glyph and labelled as one, which was
 * wrong twice over: the mark between two vagones is a pedestrian crossing —
 * the way through — and an emergency exit is a different thing these sheets
 * mark in green somewhere else. It earns no entry in the key either: a person
 * walking across a gap needs no explaining.
 */
/** Material Symbols Rounded `directions_walk`, on its own 960 grid. */
const PEATON_VB = '0 -960 960 960';
const PEATON =
  '<path d="M436-364 371-72q-3 14-14.5 23T330-40q-20 0-32-15t-8-34l102-515-72 28v96q0 17-11.5 28.5T280-440q-17 0-28.5-11.5T240-480v-122q0-12 6.5-21.5T264-638l178-76q14-6 29.5-7t29.5 4q14 5 26.5 14t20.5 23l40 64q13 20 30.5 38t39.5 31q14 8 31 14.5t34 9.5q16 3 26.5 14.5T760-480q0 17-12 28t-29 9q-56-8-100.5-35T541-543l-25 123 72 68q6 6 9 13.5t3 15.5v243q0 17-11.5 28.5T560-40q-17 0-28.5-11.5T520-80v-220l-84-64Zm47.5-399.5Q460-787 460-820t23.5-56.5Q507-900 540-900t56.5 23.5Q620-853 620-820t-23.5 56.5Q573-740 540-740t-56.5-23.5Z" fill="#FFFFFF"/>';

function marcasHtml() {
  return (
    '<span class="pdt-marca pdt-marca-der" aria-hidden="true"></span>' +
    '<span class="pdt-figura" role="img" aria-label="Paso peatonal">' +
    '<svg viewBox="' + PEATON_VB + '" aria-hidden="true">' + PEATON + '</svg></span>' +
    '<span class="pdt-marca pdt-marca-izq" aria-hidden="true"></span>'
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
    // The way through, drawn ON the vestibule at its platform edge — which is
    // where the sheet draws it. Given a column of its own it left a blank
    // band between the vestibule and the first vagón, and the sheet has no
    // such gap: the ramp arrows and the emergency figure sit inside the
    // access block, at the end nearest the platform.
    const paso = col.paso === false ? '' : '<span class="pdt-canal">' + marcasHtml() + '</span>';
    return (
      '<div class="pdt-col pdt-vestibulo">' +
      '<div class="pdt-band pdt-band-a">' + salidasFor(col, 'arriba') + iconsHtml(col.arriba) + paso + '</div>' +
      midBand(undefined, '', salidasFor(col, 'centro') + iconsHtml(col.centro)) +
      '<div class="pdt-band pdt-band-b">' + salidasFor(col, 'abajo') + iconsHtml(col.abajo) + paso + '</div>' +
      '</div>'
    );
  }
  if (col.t === 'puente') {
    // As the sheet draws it: a narrow DASHED column running the full height of
    // the drawing — taller than the platforms, because it crosses the road
    // they sit in — with a triangle up at the top and down at the bottom for
    // the ways onto it, and the name printed outside. An earlier version was
    // a small arch nobody could read as a bridge.
    return (
      '<div class="pdt-col pdt-puente" role="img" aria-label="' +
      escapeHtml(col.nombre || 'Puente peatonal') + '">' +
      '<span class="pdt-puente-sube" aria-hidden="true"></span>' +
      '<span class="pdt-puente-txt">' + escapeHtml(col.nombre || 'Puente peatonal') + '</span>' +
      '<span class="pdt-puente-baja" aria-hidden="true"></span>' +
      '</div>'
    );
  }
  if (col.t === 'paso' || col.t === 'acceso') {
    // The crossing between two vagones, and the strip between the vestibule
    // and the first of them: on the sheet they are the same thing, a grey
    // channel carrying the ramp arrows and the emergency figure. The caño
    // crosses the one between vagones and stops short of the one beside the
    // vestibule, which is why only `paso` takes the divider.
    const kind = col.t === 'paso' ? 'pdt-paso' : 'pdt-acceso';
    // The marks go in a box of their own rather than filling the band. Filling
    // it, the crossing ran the whole height of the column — up past the deck
    // and into the chips above it — so it read as taller than the vagones it
    // sits between, which on the sheet it never is.
    const caja = '<span class="pdt-canal-v">' + marcasHtml() + '</span>';
    return (
      '<div class="pdt-col ' + kind + '">' +
      '<div class="pdt-band pdt-band-a">' + caja + '</div>' +
      (col.t === 'paso' ? midBand(divider, label) : midBand(undefined, '')) +
      '<div class="pdt-band pdt-band-b">' + caja + '</div>' +
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
    // A bridge draws its own triangles, not the stairs glyph, so it adds
    // nothing to the key: a legend must name what the plan actually drew.
    } else if (col.t === 'puente') { /* no mark of its own */ }
    else if (col.t === 'paso' || col.t === 'acceso') add(['rampa']);
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
    // The name sits at the CENTRE of the run the divider actually crosses, not
    // on the first column of it: at Guatoque the caño spans three columns and
    // the word sat over the left-hand one, reading as a label for that vagón
    // rather than for the water.
    const cruza = columnas.map((c, i) => (c.t === 'vagones' || c.t === 'paso' ? i : -1)).filter((i) => i >= 0);
    const first = cruza.length ? cruza[Math.floor((cruza.length - 1) / 2)] : -1;
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
