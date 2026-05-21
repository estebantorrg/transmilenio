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
  map.easeTo({
    center: lngLat,
    padding: {
      left: window.innerWidth > 768 ? 380 : 0,
      bottom: window.innerWidth <= 768 ? window.innerHeight * 0.5 : 0
    },
    duration: 400
  });

  activePopup = popup;

  popup.on('close', () => {
    if (activePopup === popup) activePopup = null;
  });
}
