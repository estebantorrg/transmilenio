/** Stacked bottom sheets with a drag-to-dismiss grabber. Back-key aware. */

import { h } from '../lib/dom';

export interface SheetHandle {
  el: HTMLElement;
  body: HTMLElement;
  /** Dismiss the sheet. `immediate` removes it synchronously (no exit animation) —
   *  used when one detail sheet replaces another so panels never pile up mid-animation. */
  close: (immediate?: boolean) => void;
  setTitle: (t: string) => void;
}

interface SheetOptions {
  title?: string;
  accent?: string;
  onClose?: () => void;
  full?: boolean;
  /** Appear already-open (no slide-up). Used when swapping one detail sheet for
   *  another in place, so rapid taps read as a content swap, not a stack. */
  instant?: boolean;
}

const stack: SheetHandle[] = [];

function host(): HTMLElement {
  return document.getElementById('sheet-host') as HTMLElement;
}

export function sheetCount(): number {
  return stack.length;
}

export function closeTopSheet(): boolean {
  const top = stack[stack.length - 1];
  if (!top) return false;
  top.close();
  return true;
}

export function openSheet(options: SheetOptions = {}): SheetHandle {
  const hostEl = host();
  hostEl.setAttribute('aria-hidden', 'false');
  hostEl.classList.add('active');

  const backdrop = h('div', { class: 'sheet-backdrop' });
  const grabber = h('div', { class: 'sheet-grabber' }, [h('span', { class: 'sheet-grab-bar' })]);
  const titleEl = h('div', { class: 'sheet-title', text: options.title ?? '' });
  const body = h('div', { class: 'sheet-body' });
  const panel = h('div', { class: `sheet-panel${options.full ? ' sheet-full' : ''}` }, [grabber, titleEl, body]);
  if (options.accent) panel.style.setProperty('--sheet-accent', options.accent);

  const wrap = h('div', { class: 'sheet' }, [backdrop, panel]);
  hostEl.append(wrap);

  let closed = false;
  const finalize = (): void => {
    wrap.remove();
    if (stack.length === 0) {
      hostEl.classList.remove('active');
      hostEl.setAttribute('aria-hidden', 'true');
    }
    options.onClose?.();
  };
  const close = (immediate = false): void => {
    if (closed) return;
    closed = true;
    const idx = stack.indexOf(handle);
    if (idx >= 0) stack.splice(idx, 1);
    if (immediate) {
      finalize();
      return;
    }
    wrap.classList.add('closing');
    window.setTimeout(finalize, 300);
  };

  const handle: SheetHandle = { el: panel, body, close, setTitle: (t) => (titleEl.textContent = t) };
  stack.push(handle);

  backdrop.addEventListener('click', () => close());

  // Drag-to-dismiss on the grabber.
  let startY = 0;
  let dy = 0;
  let dragging = false;
  const onDown = (e: PointerEvent): void => {
    dragging = true;
    startY = e.clientY;
    dy = 0;
    panel.style.transition = 'none';
    grabber.setPointerCapture(e.pointerId);
  };
  const onMove = (e: PointerEvent): void => {
    if (!dragging) return;
    dy = Math.max(0, e.clientY - startY);
    panel.style.transform = `translateY(${dy}px)`;
    backdrop.style.opacity = String(Math.max(0, 1 - dy / 400));
  };
  const onUp = (): void => {
    if (!dragging) return;
    dragging = false;
    panel.style.transition = '';
    panel.style.transform = '';
    backdrop.style.opacity = '';
    if (dy > 120) close();
  };
  grabber.addEventListener('pointerdown', onDown);
  grabber.addEventListener('pointermove', onMove);
  grabber.addEventListener('pointerup', onUp);
  grabber.addEventListener('pointercancel', onUp);

  // Instant = swap in place (no paint of the off-screen state → no slide); fresh
  // open = slide up on the next frame.
  if (options.instant) wrap.classList.add('open');
  else requestAnimationFrame(() => wrap.classList.add('open'));
  return handle;
}
