import maplibregl from 'maplibre-gl';

let activePopup: maplibregl.Popup | null = null;
let activePin: maplibregl.Marker | null = null;

/**
 * Drops a pin under the popup for a place that has NO symbol of its own on the
 * map. The tullave counters and the cicloparqueaderos are catalog POIs with no
 * layer, so opening one from Cerca floated a card over blank street with nothing
 * marking the doorway it describes — the popup tip is 14 px of transparent CSS
 * triangle. The pin is owned here, next to the single-popup state, so it cannot
 * outlive or duplicate the card it belongs to.
 */
function dropPin(map: maplibregl.Map, lngLat: maplibregl.LngLatLike, color: string): maplibregl.Marker {
  const el = document.createElement('div');
  el.className = 'poi-pin';
  el.style.setProperty('--poi-pin-color', color);
  el.innerHTML =
    '<svg width="26" height="34" viewBox="0 0 26 34" aria-hidden="true">' +
    '<path d="M13 33.2C13 33.2 24.5 20.6 24.5 12.6A11.5 11.5 0 0 0 1.5 12.6C1.5 20.6 13 33.2 13 33.2Z" ' +
    'fill="var(--poi-pin-color)" stroke="#ffffff" stroke-width="2"/>' +
    '<circle cx="13" cy="12.4" r="4.2" fill="#ffffff"/></svg>';
  return new maplibregl.Marker({ element: el, anchor: 'bottom' }).setLngLat(lngLat).addTo(map);
}

export function showPopup(
  map: maplibregl.Map,
  lngLat: maplibregl.LngLatLike,
  html: string,
  options: {
    maxWidth?: string;
    offset?: number;
    /** Accent colour of a pin to show, at the popup's own coordinate, for as
     *  long as the popup is open. Omit for places the map already draws. */
    pinColor?: string;
  } = {}
): void {
  activePopup?.remove();
  activePin?.remove();
  activePin = options.pinColor ? dropPin(map, lngLat, options.pinColor) : null;
  const popup = new maplibregl.Popup({
    className: 'tm-popup',
    closeButton: true,
    closeOnClick: true,
    focusAfterOpen: false,
    maxWidth: options.maxWidth ?? '300px',
    anchor: 'bottom',
    offset: options.offset ?? 14,
  })
    .setLngLat(lngLat)
    .setHTML(html)
    .addTo(map);

  // Manually ensure the popup centers into the visible viewport, clearing the sidebar
  const sidebarCollapsed = document.body.classList.contains('sidebar-collapsed');
  const sidebarWidth = sidebarCollapsed ? 0 : Math.min(360, window.innerWidth - 24);
  const leftPadding = sidebarCollapsed ? 28 : Math.min(sidebarWidth + 20, window.innerWidth - 60);

  map.easeTo({
    center: lngLat,
    padding: {
      left: leftPadding,
      right: 28,
      top: 52,
      bottom: 28
    },
    duration: 400
  });

  activePopup = popup;

  // After the recenter settles, nudge the map so a tall popup (portales, big
  // interchanges) sits fully on screen instead of running off the top edge.
  const margin = 14;
  window.setTimeout(() => {
    if (activePopup !== popup) return;
    const content = popup.getElement()?.querySelector('.maplibregl-popup-content') as HTMLElement | null;
    if (!content) return;
    const rect = content.getBoundingClientRect();
    let dy = 0;
    if (rect.top < margin) dy = rect.top - margin;
    else if (rect.bottom > window.innerHeight - margin) dy = rect.bottom - (window.innerHeight - margin);
    if (Math.abs(dy) > 2) map.panBy([0, dy], { duration: 220 });
  }, 440);

  popup.on('close', () => {
    if (activePopup !== popup) return;
    activePopup = null;
    activePin?.remove();
    activePin = null;
  });
}
