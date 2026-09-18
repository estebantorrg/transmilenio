/**
 * Operator notices on a drawn station — the estación page and the map popup
 * (spec §5.5.6).
 *
 * A notice is two things on screen, and both only while it is in force: the
 * notice itself, as the operator words it, above the plan; and the plan marked
 * to match — the closed vagón and access greyed out and labelled, the services
 * that skip the stop struck through. A drawing that still shows a closed vagón
 * as open sends a rider to a door that is shut, so the plan has to change with
 * the banner and not only sit under it.
 *
 * "In force" is Bogotá time and changes by the hour — Marly's vagón 2 closes
 * every weeknight at 22:00 — so a surface that stays open re-reads it every
 * minute ({@link watchAvisos}) rather than trusting the moment it was drawn.
 * Every mark is undone before the next pass, so a notice that ends mid-visit
 * leaves the plan exactly as it was drawn.
 */

import { estadoAvisos, type Aviso } from '../../../shared/avisos.js';
import { nombreVagon } from '../../../shared/plano.js';
import { escapeHTML } from '../utils/html';

/** Marks this module sets, so the next pass can take every one of them off. */
const MARCAS = ['aviso-cerrado', 'aviso-omite', 'aviso-traslado'];
/** Where a mark saved the attribute it changed: `attr` → its value before. */
const BASE = 'data-aviso-base';

/**
 * The slot a surface leaves for its notices. Only where the station has any on
 * file, and hidden until one is in force: a station with none gets no markup.
 */
export function avisosSlotHtml(avisos: Aviso[] | undefined, className = ''): string {
  return avisos?.length ? `<div class="avisos${className ? ` ${className}` : ''}" data-avisos hidden></div>` : '';
}

function avisoHtml(aviso: Aviso): string {
  return (
    `<div class="aviso">` +
    `<p class="aviso-eyebrow">Aviso de TransMilenio · vigente ahora</p>` +
    `<p class="aviso-titulo">${escapeHTML(aviso.titulo)}</p>` +
    (aviso.detalle ? `<p class="aviso-detalle">${escapeHTML(aviso.detalle)}</p>` : '') +
    `</div>`
  );
}

/** Adds `cls` and appends `nota` to `attr`, keeping what `attr` said before. */
function marcar(el: Element, cls: string, attr: string, nota: string): void {
  if (!el.hasAttribute(BASE)) el.setAttribute(BASE, JSON.stringify([attr, el.getAttribute(attr)]));
  const [, base] = JSON.parse(el.getAttribute(BASE) as string) as [string, string | null];
  el.classList.add(cls);
  el.setAttribute(attr, base ? `${base} — ${nota}` : nota);
}

function desmarcar(root: ParentNode): void {
  root.querySelectorAll('.aviso-nota').forEach((n) => n.remove());
  root.querySelectorAll(`[${BASE}]`).forEach((el) => {
    const [attr, base] = JSON.parse(el.getAttribute(BASE) as string) as [string, string | null];
    if (base == null) el.removeAttribute(attr);
    else el.setAttribute(attr, base);
    el.removeAttribute(BASE);
    el.classList.remove(...MARCAS);
  });
}

/**
 * A short visible label on a closed part of the drawing, placed by `poner`.
 * Hidden from assistive tech where the part's own label already says it.
 */
function nota(texto: string, poner: (span: HTMLElement) => void, oculta = false): void {
  const span = document.createElement('span');
  span.className = 'aviso-nota';
  if (oculta) span.setAttribute('aria-hidden', 'true');
  span.textContent = texto;
  poner(span);
}

/**
 * Shows the notices in force at `fecha` inside `root`, and marks its plan.
 * Safe to call again at any time: it starts by undoing the previous pass.
 */
export function applyAvisos(root: ParentNode, avisos: Aviso[] | undefined, fecha: Date = new Date()): void {
  desmarcar(root);
  const estado = estadoAvisos(avisos, fecha);

  const slot = root.querySelector<HTMLElement>('[data-avisos]');
  if (slot) {
    slot.innerHTML = estado.vigentes.map(avisoHtml).join('');
    slot.hidden = estado.vigentes.length === 0;
    slot.setAttribute('role', 'status');
  }
  if (estado.vigentes.length === 0) return;

  const cerrados = new Set(estado.vagones);
  root.querySelectorAll<HTMLElement>('.pvg[data-vagon]').forEach((section) => {
    const vagon = section.dataset.vagon ?? '';
    if (!cerrados.has(vagon)) return;
    const destino = estado.traslados[vagon];
    const donde = destino ? `sus servicios paran en el ${nombreVagon(destino)}` : 'sus servicios no paran aquí';
    marcar(section, 'aviso-cerrado', 'aria-label', `cerrado: ${donde}`);
    // Under the plate, inside the deck: the label belongs to the platform, and
    // the chips above and below it stay where the sheet put them.
    const plate = section.querySelector('.pvg-plate');
    if (plate) nota(destino ? `Cerrado · use el ${nombreVagon(destino)}` : 'Cerrado', (span) => plate.after(span), true);
    section.querySelectorAll('[data-route-code]').forEach((chip) => {
      if (destino) marcar(chip, 'aviso-traslado', 'title', `mientras dure el cierre, para en el ${nombreVagon(destino)}`);
    });
  });

  const accesos = estado.accesos.map((a) => a.toLowerCase());
  root.querySelectorAll<HTMLElement>('.pdt-vestibulo[data-acceso]').forEach((block) => {
    const calles = (block.dataset.acceso ?? '').toLowerCase().split('|');
    if (!calles.some((c) => accesos.includes(c))) return;
    // A title and not an aria-label: the block is a plain box with no role
    // to carry one. The visible label is what a screen reader reads.
    marcar(block, 'aviso-cerrado', 'title', 'Acceso cerrado');
    nota('Acceso cerrado', (span) => block.append(span));
  });

  // The chips in the plan and in the service lists under it — not the live
  // board, whose buses are the ones actually coming.
  const omiten = new Set(estado.omiten);
  root
    .querySelectorAll('.popup-plano [data-route-code], .popup-wagon-section [data-route-code]')
    .forEach((chip) => {
      const code = String(chip.getAttribute('data-route-code') ?? '').trim().toUpperCase();
      if (!omiten.has(code)) return;
      // Skipping outranks moving: a service that does not stop is not waiting
      // at the other vagón either.
      chip.classList.remove('aviso-traslado');
      marcar(chip, 'aviso-omite', 'title', 'no para en esta estación mientras dure el cierre');
    });
}

/** Root → its minute timer and the notices it re-reads. */
const vigilados = new WeakMap<Element, { id: number; avisos: Aviso[] }>();

/**
 * {@link applyAvisos} now, and again every minute for as long as `root` is on
 * the page. A station with no notices on file costs nothing: no pass, no timer.
 *
 * The notices are looked up per tick rather than captured, because the page
 * shell draws each station into the SAME element: a timer holding the last
 * station's notices would go on marking the next station's plan with them.
 */
export function watchAvisos(root: HTMLElement, avisos: Aviso[] | undefined): void {
  const previo = vigilados.get(root);
  if (!avisos?.length) {
    if (previo) {
      window.clearInterval(previo.id);
      vigilados.delete(root);
    }
    return;
  }
  applyAvisos(root, avisos);
  if (previo) {
    previo.avisos = avisos;
    return;
  }
  const id = window.setInterval(() => {
    const actual = vigilados.get(root);
    if (!root.isConnected || !actual) {
      window.clearInterval(id);
      vigilados.delete(root);
      return;
    }
    applyAvisos(root, actual.avisos);
  }, 60_000);
  vigilados.set(root, { id, avisos });
}
