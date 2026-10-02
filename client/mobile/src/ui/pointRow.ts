/**
 * One row renderer for a "place" (estación, paradero, recarga, bici, cable) and
 * one answer to "what happens when you tap it".
 *
 * Both lookup surfaces use these: Cerca (ranked by distance) and the Rutas
 * search (ranked by name). Before this, only Cerca could show a place at all,
 * and it did it with markup that lived inside that one view — so a place found
 * by name would have looked like a different thing from the same place found by
 * GPS (spec §5.4.2b: one kind vocabulary across every lookup surface).
 */

import { POINT_KIND_GLYPHS, POINT_KIND_META } from '@shared/data/pointKinds';
import { formatDistance, walkMinutes } from '../lib/format';
import { h, haptic } from '../lib/dom';
import type { StationRecord } from '../state';
import { openPoiSheet, openStationSheet } from './detailSheets';

/** Sub-line: the address, or the kind's own description when there is none.
 *  POIs put their hours/capacity next to the address — that IS the useful bit. */
export function pointSubtitle(point: StationRecord): string {
  const meta = POINT_KIND_META[point.kind];
  if (meta.carriesExtra) {
    return [point.direccion, point.hours].filter(Boolean).join(' · ') || meta.fallback;
  }
  return point.direccion || meta.fallback;
}

/**
 * A place row, wherever a place is listed: Cerca (ranked by distance) and the
 * Buscar results (ranked by name). Set as a route card is — a badge carrying the
 * kind's glyph on the kind's colour where a route's carries its código, the
 * name, and a sub-line of kind and address — so a place does not read as a
 * different kind of object from the routes around it. It used to be a card with
 * a dot and a pill. `meters` puts the distance and the walk where the card's
 * chevron sits; the name search, which has no fix, keeps the chevron.
 */
export function pointRow(point: StationRecord, meters?: number): HTMLElement {
  const meta = POINT_KIND_META[point.kind];
  const card = h('button', { class: 'route-card place-card', type: 'button' });
  const lejos = typeof meters === 'number' && Number.isFinite(meters);
  card.setAttribute(
    'aria-label',
    [point.name, meta.label, pointSubtitle(point), lejos ? `a ${formatDistance(meters)}, ${walkMinutes(meters)} min a pie` : '']
      .filter(Boolean)
      .join(', ')
  );
  card.append(
    h('span', {
      class: `route-badge route-badge-md place-badge ${meta.cls}`,
      html: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${POINT_KIND_GLYPHS[point.kind]}</svg>`,
    }),
    h('div', { class: 'route-card-meta' }, [
      h('div', { class: 'route-card-name', text: point.name }),
      h('div', { class: 'route-card-sub' }, [
        h('span', { class: 'route-chip', text: meta.label }),
        document.createTextNode(` ${pointSubtitle(point)}`),
      ]),
    ]),
    lejos
      ? h('div', { class: 'place-far' }, [
          h('div', { class: 'place-dist', text: formatDistance(meters) }),
          h('div', { class: 'place-walk', text: `${walkMinutes(meters)} min` }),
        ])
      : h('span', { class: 'route-card-chev', html: '›' })
  );
  card.addEventListener('click', () => {
    haptic('light');
    openPointDetail(point);
  });
  return card;
}

/** A place in the Buscar results: the same row, with no distance to give. */
export function placeCard(point: StationRecord): HTMLElement {
  return pointRow(point);
}

/**
 * Tapping a place opens its detail sheet — in place, without leaving the tab.
 * POIs used to be the exception: they yanked the rider to the Map tab and threw
 * a toast, so the address, the hours and the "cómo llego" were all gone in 2.6
 * seconds and the rider had lost their list.
 */
export function openPointDetail(point: StationRecord): void {
  if (point.kind === 'station' || point.kind === 'stop') openStationSheet(point);
  else openPoiSheet(point);
}
