import maplibregl from 'maplibre-gl';

let activePopup: maplibregl.Popup | null = null;

export function showPopup(
  map: maplibregl.Map,
  lngLat: maplibregl.LngLatLike,
  html: string,
  options: {
    maxWidth?: string;
    offset?: number;
  } = {}
): void {
  activePopup?.remove();
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
  const sidebarWidth = sidebarCollapsed ? 48 : Math.min(360, window.innerWidth - 24);
  const leftPadding = sidebarCollapsed ? 72 : Math.min(sidebarWidth + 20, window.innerWidth - 60);

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
    if (activePopup === popup) activePopup = null;
  });
}
