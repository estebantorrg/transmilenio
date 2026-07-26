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
  /** Accessible name when the sheet renders its own header instead of `title`. */
  ariaLabel?: string;
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

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** The app shell behind the sheets. Hidden from assistive tech + tab order while
 *  a sheet is open, so a screen-reader user can't wander into the tab bar that is
 *  visually covered by a modal panel. */
function shell(): HTMLElement | null {
  return document.getElementById('app');
}

function syncShellInert(): void {
  const el = shell();
  if (!el) return;
  const modal = stack.length > 0;
  el.toggleAttribute('inert', modal);
  el.setAttribute('aria-hidden', modal ? 'true' : 'false');
}

let sheetSeq = 0;

export function openSheet(options: SheetOptions = {}): SheetHandle {
  const hostEl = host();
  hostEl.setAttribute('aria-hidden', 'false');
  hostEl.classList.add('active');

  // Where focus goes back to when this sheet closes — otherwise a keyboard or
  // screen-reader user is dumped at the top of the document every time.
  const restoreFocusTo = document.activeElement as HTMLElement | null;

  const backdrop = h('div', { class: 'sheet-backdrop' });
  const grabber = h('div', { class: 'sheet-grabber' }, [h('span', { class: 'sheet-grab-bar' })]);
  const titleId = `sheet-title-${++sheetSeq}`;
  const titleEl = h('div', { class: 'sheet-title', id: titleId, text: options.title ?? '' });
  const body = h('div', { class: 'sheet-body' });
  const panel = h('div', { class: `sheet-panel${options.full ? ' sheet-full' : ''}` }, [grabber, titleEl, body]);
  // A sheet is a modal dialog: name it, mark it modal, and make the panel itself
  // focusable so focus can land inside it on open.
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'true');
  panel.setAttribute('tabindex', '-1');
  if (options.title) panel.setAttribute('aria-labelledby', titleId);
  else panel.setAttribute('aria-label', options.ariaLabel ?? 'Detalle');
  if (options.accent) panel.style.setProperty('--sheet-accent', options.accent);

  const wrap = h('div', { class: 'sheet' }, [backdrop, panel]);
  hostEl.append(wrap);

  let closed = false;
  const finalize = (): void => {
    wrap.remove();
    document.removeEventListener('keydown', onKeydown, true);
    if (stack.length === 0) {
      hostEl.classList.remove('active');
      hostEl.setAttribute('aria-hidden', 'true');
    }
    syncShellInert();
    // Only pull focus back if it is still somewhere inside the sheet host —
    // if the user already tapped elsewhere, stealing it would be worse.
    if (restoreFocusTo?.isConnected && hostEl.contains(document.activeElement)) {
      restoreFocusTo.focus({ preventScroll: true });
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

  // Escape closes, Tab is trapped inside the panel — only for the TOP sheet, so
  // a stacked planner-over-detail doesn't fight for the keyboard.
  const onKeydown = (e: KeyboardEvent): void => {
    if (closed || stack[stack.length - 1] !== handle) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
      return;
    }
    if (e.key !== 'Tab') return;
    const focusable = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
      (el) => el.offsetParent !== null || el === document.activeElement
    );
    if (focusable.length === 0) {
      e.preventDefault();
      panel.focus({ preventScroll: true });
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement as HTMLElement | null;
    if (e.shiftKey && (active === first || active === panel)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  };
  document.addEventListener('keydown', onKeydown, true);

  const handle: SheetHandle = { el: panel, body, close, setTitle: (t) => (titleEl.textContent = t) };
  stack.push(handle);
  syncShellInert();

  backdrop.addEventListener('click', () => close());

  // Drag-to-dismiss. The grabber is the affordance, but the whole non-scrolling
  // header (grabber + title row) accepts the gesture — a 42×5 px bar is a
  // smaller target than a thumb, so the sheet used to feel stuck. The scrolling
  // body is deliberately NOT a drag surface: capturing the pointer there would
  // fight the list scroll.
  let startY = 0;
  let dy = 0;
  let dragging = false;
  const onDown = (e: PointerEvent): void => {
    dragging = true;
    startY = e.clientY;
    dy = 0;
    panel.style.transition = 'none';
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
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
  for (const surface of [grabber, titleEl]) {
    surface.addEventListener('pointerdown', onDown);
    surface.addEventListener('pointermove', onMove);
    surface.addEventListener('pointerup', onUp);
    surface.addEventListener('pointercancel', onUp);
  }

  // Instant = swap in place (no paint of the off-screen state → no slide); fresh
  // open = slide up on the next frame.
  if (options.instant) wrap.classList.add('open');
  else requestAnimationFrame(() => wrap.classList.add('open'));
  // Move focus into the sheet so the next Tab (or a screen reader's next swipe)
  // starts here rather than behind the panel. Deferred past the current task:
  // marking the shell `inert` blurs whatever was focused there and hands focus
  // back to <body>, which lands AFTER a same-frame focus call and undoes it.
  window.setTimeout(() => {
    if (!closed) panel.focus({ preventScroll: true });
  }, 0);
  return handle;
}
