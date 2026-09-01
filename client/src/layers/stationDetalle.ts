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
import type { CatalogStation } from '../types/catalog';

type Detalle = NonNullable<CatalogStation['planoDetalle']>;
type Columna = Detalle['columnas'][number];

/**
 * The legend every sheet prints down its left edge, as inline SVG.
 *
 * Drawn rather than lettered because these are the marks a rider matches
 * against the wall, and a word in place of a glyph is a different sign. Each is
 * a 16×16 viewBox so they sit on the same baseline whatever the drawing scale.
 */
const ICONOS: Record<string, { label: string; svg: string }> = {
  taquilla: {
    label: 'Taquilla',
    svg: '<path d="M2 5.5h12v7H2z"/><path d="M4.5 8.5h3M4.5 10.5h5"/>',
  },
  torniquete: {
    label: 'Torniquetes',
    svg: '<path d="M3 3v10M13 3v10"/><circle cx="5.6" cy="6" r="1.4"/><circle cx="10.4" cy="6" r="1.4"/><path d="M4.2 13V9.2h2.8V13M9 13V9.2h2.8V13"/>',
  },
  rampa: {
    label: 'Rampa peatonal',
    svg: '<path d="M2 12.5h12"/><path d="M3 12.5 11 5"/><circle cx="9" cy="3.6" r="1.2"/>',
  },
  escalera: {
    label: 'Escalera peatonal',
    svg: '<path d="M2 13h3v-2.5h3V8h3V5.5h3"/>',
  },
  ascensor: {
    label: 'Ascensor prioritario',
    svg: '<path d="M3 2.5h10v11H3z"/><path d="M8 5v6M6 7l2-2 2 2M6 9l2 2 2-2"/>',
  },
  emergencia: {
    label: 'Salida de emergencia',
    svg: '<path d="M3 2.5h6v11H3z"/><path d="M10 8h4M12 6l2 2-2 2"/>',
  },
  bici: {
    label: 'TransMiBici',
    svg: '<circle cx="4.5" cy="10.5" r="2.6"/><circle cx="11.5" cy="10.5" r="2.6"/><path d="M4.5 10.5 7 5h3"/>',
  },
  cable: {
    label: 'Conexión TransMiCable',
    svg: '<path d="M1.5 4.5h13"/><path d="M6 4.5v2.2h4V4.5"/><path d="M5.5 6.7h5v4.6h-5z"/>',
  },
  zonal: {
    label: 'Conexión con servicio zonal',
    svg: '<path d="M3 3.5h10v7H3z"/><path d="M3 7h10"/><circle cx="5" cy="12" r="1"/><circle cx="11" cy="12" r="1"/>',
  },
};

function iconHtml(name: string): string {
  const icon = ICONOS[name];
  if (!icon) return '';
  return (
    `<span class="pdt-icono" role="img" aria-label="${escapeHTML(icon.label)}" title="${escapeHTML(icon.label)}">` +
    `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" ` +
    `stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icon.svg}</svg>` +
    `</span>`
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
  return (
    `<span class="pdt-salida pdt-salida-${arrow}">` +
    `<span class="pdt-salida-arrow" aria-hidden="true"></span>` +
    `<span class="pdt-salida-txt"><span class="pdt-salida-tag">Salida</span>` +
    `<span class="pdt-salida-calle">${escapeHTML(salida.calle)}</span></span>` +
    `</span>`
  );
}

/**
 * One column, with the two platform cells the caller has already drawn for it.
 *
 * `arriba`/`abajo` come in as finished HTML because the vagones themselves are
 * the compact drawing's job — this module places them, it does not rebuild
 * them. That is what keeps the two drawings from disagreeing about a service.
 */
/**
 * The band between the platforms, for ONE column.
 *
 * The divider is drawn per column rather than as one bar across the drawing,
 * because it does not cross the whole drawing: at Guatoque the caño starts
 * where the platforms start and the vestibule before it is dry land. Drawn as
 * a single absolutely-positioned bar it needed to be told how far along to
 * begin, in pixels, which was a guess that happened to fit one station.
 */
function midBand(divider: string | undefined, label: string): string {
  if (!divider) return '<div class="pdt-band pdt-band-mid"></div>';
  return (
    `<div class="pdt-band pdt-band-mid pdt-divider pdt-divider-${escapeHTML(divider)}">` +
    (label ? `<span class="pdt-divider-name">${escapeHTML(label)}</span>` : '') +
    `</div>`
  );
}

function columnaHtml(
  col: Columna,
  cell: (vagon: string | undefined) => string,
  divider: string | undefined,
  label: string
): string {
  if (col.t === 'vestibulo') {
    const salidas = (col.salidas ?? []).map(salidaHtml).join('');
    return (
      `<div class="pdt-col pdt-vestibulo">` +
      `<div class="pdt-band pdt-band-a">${iconsHtml(col.arriba)}</div>` +
      `<div class="pdt-band pdt-band-mid">${salidas}${iconsHtml(col.centro)}</div>` +
      `<div class="pdt-band pdt-band-b">${iconsHtml(col.abajo)}</div>` +
      `</div>`
    );
  }
  if (col.t === 'puente') {
    return (
      `<div class="pdt-col pdt-puente">` +
      `<span class="pdt-puente-mark" aria-hidden="true"></span>` +
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
    `<div class="pdt-band pdt-band-a">${cell(col.arriba)}</div>` +
    midBand(divider, label) +
    `<div class="pdt-band pdt-band-b">${cell(col.abajo)}</div>` +
    `</div>`
  );
}


export interface DetalleInput {
  detalle: Detalle;
  divider?: string;
  dividerLabel?: string;
  /** Finished HTML for one vagón cell, by vagón number — the compact drawing's
   *  own output, placed rather than rebuilt. */
  cell: (vagon: string | undefined) => string;
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
        columnaHtml(
          c,
          input.cell,
          input.divider,
          i === firstPlatform ? input.dividerLabel ?? '' : ''
        )
      )
      .join('') +
    `</div>` +
    axis(input.ejeAbajo, 'b') +
    `</div></div>`
  );
}
