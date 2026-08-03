/**
 * Desktop affordance for the horizontal chip rows (layer / zone / line / search
 * scope / Cerca kind chips).
 *
 * The touch swipe has no mouse equivalent — the scrollbar is hidden, wheel
 * scrolls the page and drag does nothing — so: wheel scrolls the row, a mouse
 * drag pans it 1:1 (a real pan suppresses the chip click), and `can-scroll-*`
 * classes drive CSS edge fades that show there is more to reach.
 *
 * Lives in its own module because BOTH the Explore panel (`sidebar.ts`) and the
 * Cerca panel (`cerca.ts`) need it — one implementation, no drift (spec §1.1 R2).
 */
export function initChipRowScroll(row: HTMLElement): void {
  // Marks the row for the shared edge-fade / grab-cursor styling, so a new chip
  // row gets the affordance by being wired here — not by being added to three
  // selector lists in the stylesheet (spec §1.1 R2).
  row.classList.add('chip-scroll');

  const syncEdges = (): void => {
    const max = row.scrollWidth - row.clientWidth;
    row.classList.toggle('can-scroll-left', row.scrollLeft > 2);
    row.classList.toggle('can-scroll-right', row.scrollLeft < max - 2);
  };

  row.addEventListener(
    'wheel',
    (e) => {
      if (row.scrollWidth <= row.clientWidth) return;
      const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      if (!delta) return;
      row.scrollLeft += delta;
      e.preventDefault();
    },
    { passive: false }
  );

  let pointerId: number | null = null;
  let startX = 0;
  let startScroll = 0;
  let dragged = false;

  row.addEventListener('pointerdown', (e) => {
    // Touch pans natively via overflow scrolling; this path is mouse-only.
    if (e.pointerType !== 'mouse' || e.button !== 0) return;
    pointerId = e.pointerId;
    startX = e.clientX;
    startScroll = row.scrollLeft;
    dragged = false;
  });
  row.addEventListener('pointermove', (e) => {
    if (pointerId !== e.pointerId) return;
    const dx = e.clientX - startX;
    if (!dragged && Math.abs(dx) > 4) {
      dragged = true;
      row.setPointerCapture(e.pointerId);
      row.classList.add('chip-row-dragging');
    }
    if (dragged) row.scrollLeft = startScroll - dx;
  });
  const endDrag = (e: PointerEvent): void => {
    if (pointerId !== e.pointerId) return;
    pointerId = null;
    row.classList.remove('chip-row-dragging');
  };
  row.addEventListener('pointerup', endDrag);
  row.addEventListener('pointercancel', endDrag);
  // A pan must not also activate the chip the pointer was released over.
  row.addEventListener(
    'click',
    (e) => {
      if (!dragged) return;
      dragged = false;
      e.stopPropagation();
      e.preventDefault();
    },
    true
  );

  row.addEventListener('scroll', syncEdges, { passive: true });
  new ResizeObserver(syncEdges).observe(row);
  // Chip re-renders and count updates change scrollWidth without resizing the row.
  new MutationObserver(syncEdges).observe(row, { childList: true, subtree: true, characterData: true });
  syncEdges();
}
