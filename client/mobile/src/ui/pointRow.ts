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

import { POINT_KIND_META } from '@shared/data/pointKinds';
import { formatDistance, walkMinutes } from '../lib/format';
import { h, haptic } from '../lib/dom';
import type { StationRecord } from '../state';
import { openPoiSheet, openStationSheet } from './detailSheets';

/** Sub-line: the address, or the kind's own description when there is none.
 *  POIs put their hours/capacity next to the address — that IS the useful bit. */
export function pointSubtitle(point: StationRecord): string {
  const meta = POINT_KIND_META[point.kind];
  if (point.kind === 'recharge' || point.kind === 'transmibici') {
    return [point.direccion, point.hours].filter(Boolean).join(' · ') || meta.fallback;
  }
  return point.direccion || meta.fallback;
}

/**
 * A place row. `meters` is optional so the name search reuses the exact same row
 * without inventing a distance it has no fix to compute.
 */
export function pointRow(point: StationRecord, meters?: number): HTMLElement {
  const meta = POINT_KIND_META[point.kind];
  const row = h('button', { class: 'near-row', type: 'button' });
  const dot = h('span', { class: `near-dot ${meta.cls}` });
  const nameRow = h('div', { class: 'near-name-row' }, [
    h('span', { class: 'near-name', text: point.name }),
    h('span', { class: `near-kind ${meta.cls}`, text: meta.label }),
  ]);
  const mid = h('div', { class: 'near-mid' }, [nameRow, h('div', { class: 'near-sub', text: pointSubtitle(point) })]);
  row.append(dot, mid);
  if (typeof meters === 'number' && Number.isFinite(meters)) {
    row.append(
      h('div', { class: 'near-right' }, [
        h('div', { class: 'near-dist', text: formatDistance(meters) }),
        h('div', { class: 'near-walk', text: `${walkMinutes(meters)} min` }),
      ])
    );
  }
  row.addEventListener('click', () => {
    haptic('light');
    openPointDetail(point);
  });
  return row;
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
