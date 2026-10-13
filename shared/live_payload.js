/**
 * How a live-host answer is unwrapped (spec §5.2.4).
 *
 * The live API — and the relay and server tiers that wrap it — return the
 * vehicle list under one of several keys, as a bare array, or as an object
 * keyed by vehicle id. Every unwrapper must behave identically: the copy that
 * lacked the keyed-object fallback returned empty for a payload every other
 * tier handled (spec §5.2.2a). So there is one, read by the server cascade, the
 * standalone relay, the website and the app.
 */

export function toFiniteNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

export function isBusLike(value) {
  if (!value || typeof value !== 'object') return false;
  return toFiniteNumber(value.latitude ?? value.lat) !== null &&
    toFiniteNumber(value.longitude ?? value.lng ?? value.lon) !== null;
}

function busValuesFromObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const buses = Object.values(value).filter(isBusLike);
  return buses.length > 0 ? buses : null;
}

/** Locate the bus array inside any known live payload shape, or `null`. */
export function findBusPayloadArray(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return null;

  const candidates = [
    payload.data,
    payload.buses,
    payload.result,
    payload.results,
    payload.vehiculos,
    payload.vehicles,
  ];

  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate;
  }
  for (const candidate of candidates) {
    const buses = busValuesFromObject(candidate);
    if (buses) return buses;
  }
  return busValuesFromObject(payload);
}

/** Normalize the `/paradero/buses` response to a stable arrivals array. */
export function normalizeArrivalsPayload(payload) {
  const list = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.data) ? payload.data
    : Array.isArray(payload?.buses) ? payload.buses
    : Array.isArray(payload?.llegadas) ? payload.llegadas
    : Array.isArray(payload?.vehiculos) ? payload.vehiculos
    : [];
  return list
    .filter((it) => it && typeof it === 'object')
    .map((it) => ({
      codigo: String(it.ruta_extraida ?? it.codigo ?? '').trim(),
      idRuta: String(it.ruta_sae ?? it.idRuta ?? '').trim(),
      destino: String(it.destino_limpio ?? it.destino ?? it.nombre ?? '').trim(),
      color: String(it.color_ruta ?? it.color ?? '').trim(),
      paradero: String(it.labelparadero ?? it.paradero ?? '').trim(),
      tiempo: String(it.labeltiempo ?? it.tiempo ?? it.time ?? '').trim(),
      distancia: String(it.distancia ?? '').trim(),
    }))
    .filter((it) => it.codigo || it.destino);
}
