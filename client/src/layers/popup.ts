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
    offset: options.offset ?? 10,
  })
    .setLngLat(lngLat)
    .setHTML(html)
    .addTo(map);

  activePopup = popup;

  popup.on('close', () => {
    if (activePopup === popup) activePopup = null;
  });
}
