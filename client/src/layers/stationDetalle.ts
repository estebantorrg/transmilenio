/**
 * The station drawn the way its own *plano de ubicación* draws it — platforms
 * AND the furniture around them.
 *
 * The compact drawing next door answers "which vagón, which side". This one
 * answers the rest of what a rider actually asks a plano: where do I come in,
 * where does that exit put me on the street, is there a bridge, and — the
 * question that made this necessary — can I get to the other platform at all.
 *
 * GUATOQUE IS WHY THIS EXISTS. A caño separates its two platforms, and the
 * compact drawing says exactly that and stops. The sheet says more: the caño
 * starts AFTER a vestibule that spans both rows, and that vestibule, with its
 * torniquetes and its Carrera 27 exit, is how you cross. Drawing the caño
 * without it does not simplify the station, it makes the drawing say something
 * false.
 *
 * Which is why this is COLUMNS and not rows. Only a column can span both
 * platforms while the thing between them does not.
 *
 * It is drawn on the estación page alone. The popup keeps the compact plan: a
 * popup is a glance on a map, a page is what you read before you travel.
 */

import { escapeHTML } from '../utils/html';
import { ICONOS } from './planoIconos';
import type { CatalogStation } from '../types/catalog';

type Detalle = NonNullable<CatalogStation['planoDetalle']>;
type Columna = Detalle['columnas'][number];

// Each mark carries its own colour, because on these sheets the colour IS
// part of the mark: the emergency exit is green and the priority lift is
// blue by law, and everything else is a black tile with a white glyph.
function iconHtml(name: string): string {
  const icon = ICONOS[name];
  if (!icon) return '';
  return (
    `<span class="pdt-icono" role="img" aria-label="${escapeHTML(icon.label)}" title="${escapeHTML(icon.label)}" style="background:${icon.bg}">` +
    `<svg viewBox="0 0 24 24" aria-hidden="true">${icon.svg}</svg></span>`
  );
}

function iconsHtml(names: string[] | undefined): string {
  const drawn = (names ?? []).map(iconHtml).filter(Boolean).join('');
  return drawn ? `<span class="pdt-iconos">${drawn}</span>` : '';
}

/**
 * A way out, with the street it comes out on.
 *
 * The street is the whole value of it. "Salida" alone is what every station
 * has; "Salida — Carrera 27" is the one that tells a rider whether this is the
 * end of the platform they want.
 */
function salidaHtml(salida: { calle: string; hacia?: 'izq' | 'der' }): string {
  const arrow = salida.hacia === 'der' ? 'der' : 'izq';
  // Two stacked bars, as printed: yellow "◀ Salida / Exit" over a black bar
  // carrying the street. Squeezed into one chip the street read as a
  // subtitle; on the sheet it is its own sign under the arrow.
  return (
    `<span class="pdt-salida pdt-salida-${arrow}">` +
    `<span class="pdt-salida-top">` +
    `<span class="pdt-salida-arrow" aria-hidden="true"></span>` +
    `<span class="pdt-salida-tag">Salida</span>` +
    `</span>` +
    `<span class="pdt-salida-calle">${escapeHTML(salida.calle)}</span>` +
    `</span>`
  );
}

/**
 * The band between the platforms, for ONE column.
 *
 * The divider is drawn per column rather than as one bar across the drawing,
 * because it does not cross the whole drawing: at Guatoque the caño starts
 * where the platforms start and the vestibule before it is dry land. Drawn as
 * a single absolutely-positioned bar it needed to be told how far along to
 * begin, in pixels, which was a guess that happened to fit one station.
 */
function midBand(divider: string | undefined, label: string, extra = ''): string {
  const cls = divider ? ` pdt-divider pdt-divider-${escapeHTML(divider)}` : '';
  return (
    `<div class="pdt-band pdt-band-mid${cls}">` +
    extra +
    (divider && label ? `<span class="pdt-divider-name">${escapeHTML(label)}</span>` : '') +
    `</div>`
  );
}

/**
 * The salidas drawn on one band of a vestibule.
 *
 * A salida sits in the MIDDLE band whenever the middle band is otherwise
 * empty — it is the widest, quietest place in the block and the sign reads
 * best there. Where something already occupies the middle, as at Av. Chile
 * whose torniquetes are between the platforms, it falls back to the band the
 * sheet puts it on and never displaces what is already there.
 */
function salidasFor(
  col: Extract<Columna, { t: 'vestibulo' }>,
  fila: 'arriba' | 'abajo' | 'centro'
): string {
  const centroLibre = (col.centro ?? []).length === 0;
  return (col.salidas ?? [])
    .filter((s) => {
      const suya = centroLibre ? 'centro' : s.fila ?? 'abajo';
      return suya === fila || (suya === 'ambas' && fila !== 'centro');
    })
    .map(salidaHtml)
    .join('');
}

function columnaHtml(
  col: Columna,
  cellArriba: (vagon: string | undefined) => string,
  cellAbajo: (vagon: string | undefined) => string,
  divider: string | undefined,
  label: string
): string {
  if (col.t === 'vestibulo') {
    // The vestibule's own bands, so a taquilla on the upper platform sits level
    // with the vagón beside it and the torniquetes sit between the two — which
    // is where the sheet puts them, and the reason they are worth drawing.
    return (
      `<div class="pdt-col pdt-vestibulo">` +
      `<div class="pdt-band pdt-band-a">${salidasFor(col, 'arriba')}${iconsHtml(col.arriba)}</div>` +
      midBand(undefined, '', `${salidasFor(col, 'centro')}${iconsHtml(col.centro)}`) +
      `<div class="pdt-band pdt-band-b">${salidasFor(col, 'abajo')}${iconsHtml(col.abajo)}</div>` +
      `</div>`
    );
  }
  if (col.t === 'puente') {
    // A pedestrian bridge is a STRUCTURE, not a doorway, and Material Symbols
    // has no glyph for one. The sheets mark it the same way this does: a named
    // block carrying whatever gets you up to it — stairs, and a lift where
    // there is one. The first attempt drew an unlabelled arch and nobody could
    // tell it was a bridge.
    const subidas = iconsHtml(col.sube ?? ['escalera']);
    return (
      `<div class="pdt-col pdt-puente">` +
      `<span class="pdt-puente-deck" aria-hidden="true"></span>` +
      `<span class="pdt-puente-iconos">${subidas}</span>` +
      `<span class="pdt-puente-txt">${escapeHTML(col.nombre || 'Puente peatonal')}</span>` +
      `</div>`
    );
  }
  if (col.t === 'paso') {
    return (
      `<div class="pdt-col pdt-paso">` +
      `<div class="pdt-band pdt-band-a"><span class="pdt-paso-mark" aria-hidden="true"></span></div>` +
      midBand(divider, '') +
      `<div class="pdt-band pdt-band-b"><span class="pdt-paso-mark" aria-hidden="true"></span></div>` +
      `</div>`
    );
  }
  return (
    `<div class="pdt-col pdt-vagones">` +
    `<div class="pdt-band pdt-band-a">${cellArriba(col.arriba)}</div>` +
    midBand(divider, label) +
    `<div class="pdt-band pdt-band-b">${cellAbajo(col.abajo)}</div>` +
    `</div>`
  );
}

/**
 * The drawing's own *Convenciones*, listing only the marks it actually used.
 *
 * Every official plano carries one, and for the same reason: a glyph at plan
 * size is recognisable once you have been told what it is, and guessable
 * before. A tooltip does not help a reader on a phone, so the key is on the
 * page.
 */
function convencionesHtml(used: string[]): string {
  if (used.length === 0) return '';
  const items = used
    .map((name) => {
      const icon = ICONOS[name];
      if (!icon) return '';
      return (
        `<span class="pdt-conv">${iconHtml(name)}` +
        `<span class="pdt-conv-txt">${escapeHTML(icon.label)}</span></span>`
      );
    })
    .filter(Boolean)
    .join('');
  return `<div class="pdt-convenciones"><span class="pdt-conv-tag">Convenciones</span>${items}</div>`;
}

/** Every icon the drawing placed, in legend order, without repeats. */
function iconsUsed(columnas: Columna[]): string[] {
  const seen: string[] = [];
  const add = (names: string[] | undefined) => {
    for (const n of names ?? []) if (ICONOS[n] && !seen.includes(n)) seen.push(n);
  };
  for (const col of columnas) {
    if (col.t === 'vestibulo') {
      add(col.arriba);
      add(col.centro);
      add(col.abajo);
    } else if (col.t === 'puente') {
      add(col.sube ?? ['escalera']);
    }
  }
  return seen;
}

export interface DetalleInput {
  detalle: Detalle;
  divider?: string;
  dividerLabel?: string;
  /** Finished HTML for one vagón cell, by vagón number — the compact drawing's
   *  own output, placed rather than rebuilt. */
  cellArriba: (vagon: string | undefined) => string;
  cellAbajo: (vagon: string | undefined) => string;
  ejeArriba?: string;
  ejeAbajo?: string;
}

export function buildStationDetalleHtml(input: DetalleInput): string | null {
  const columnas = input.detalle?.columnas ?? [];
  if (columnas.length === 0) return null;
  // The label rides on the first column the divider actually crosses, so it
  // reads at the start of the water rather than over the vestibule beside it.
  const firstPlatform = columnas.findIndex((c) => c.t === 'vagones' || c.t === 'paso');

  const axis = (name: string | undefined, side: 'a' | 'b'): string =>
    name
      ? `<div class="pvg-axis pvg-axis-${side}"><span class="pvg-axis-name">${escapeHTML(name)}</span></div>`
      : '';

  return (
    `<div class="popup-plano popup-plano-detalle" role="group" aria-label="Plano de la estación" tabindex="0">` +
    `<div class="popup-plano-inner">` +
    axis(input.ejeArriba, 'a') +
    `<div class="pdt-grid">` +
    columnas
      .map((c, i) =>
        columnaHtml(c, input.cellArriba, input.cellAbajo, input.divider, i === firstPlatform ? input.dividerLabel ?? '' : '')
      )
      .join('') +
    `</div>` +
    axis(input.ejeAbajo, 'b') +
    `</div>` +
    convencionesHtml(iconsUsed(columnas)) +
    `</div>`
  );
}
