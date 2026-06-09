import * as tmApi from './tm_api.js';

export interface GeocodeCandidate {
  name: string;
  lat: number;
  lon: number;
  type: 'station' | 'stop' | 'address' | 'place';
  code?: string;
}

/**
 * Normalizes strings by stripping accents and converting to lowercase.
 */
function normalizeString(str: string): string {
  return str
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();
}

/**
 * Searches local stations in the catalog matching the query.
 */
function searchLocalCatalog(query: string): GeocodeCandidate[] {
  const normQuery = normalizeString(query);
  if (!normQuery) return [];

  const catalog = tmApi.getCatalog();
  const candidates: GeocodeCandidate[] = [];

  for (const [code, station] of Object.entries(catalog.stations || {})) {
    const normName = normalizeString(station.nombre);
    const normCode = normalizeString(station.codigo);

    if (normName.includes(normQuery) || normCode === normQuery) {
      if (station.coordenada && station.coordenada.includes(',')) {
        const [lat, lon] = station.coordenada.split(',').map(Number);
        if (Number.isFinite(lat) && Number.isFinite(lon)) {
          const isTroncal = /^TM\d+$/i.test(station.codigo);
          candidates.push({
            name: `${station.nombre} ${isTroncal ? '(Estación TM)' : '(Paradero)'}`,
            lat,
            lon,
            type: isTroncal ? 'station' : 'stop',
            code: station.codigo,
          });
        }
      }
    }
  }

  // Sort: exact code matches first, then exact start-of-name matches, then others
  return candidates.sort((a, b) => {
    const aCode = a.code ? normalizeString(a.code) : '';
    const bCode = b.code ? normalizeString(b.code) : '';
    if (aCode === normQuery) return -1;
    if (bCode === normQuery) return 1;

    const aName = normalizeString(a.name);
    const bName = normalizeString(b.name);
    const aStarts = aName.startsWith(normQuery);
    const bStarts = bName.startsWith(normQuery);
    if (aStarts && !bStarts) return -1;
    if (!aStarts && bStarts) return 1;

    return a.name.localeCompare(b.name);
  }).slice(0, 5); // Limit local hits to 5
}

/**
 * Fetch candidates from OpenStreetMap Nominatim.
 */
async function fetchNominatim(query: string): Promise<GeocodeCandidate[]> {
  // Bogotá bounding box limits geocoding to relevant area
  const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&viewbox=-74.25,4.45,-73.98,4.85&bounded=1&limit=6`;
  
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'TransMilenioExplorer/1.0 (contact: github.com/estebantorrg/transmilenio)',
      'Accept-Language': 'es-CO,es;q=0.9',
    },
    signal: AbortSignal.timeout(5000), // 5s timeout
  });

  if (!response.ok) {
    throw new Error(`Nominatim HTTP ${response.status}`);
  }

  const data = await response.json();
  if (!Array.isArray(data)) return [];

  return data.map((item: any) => ({
    name: item.display_name.split(',').slice(0, 3).join(',').trim(), // Shorter, cleaner address
    lat: Number(item.lat),
    lon: Number(item.lon),
    type: item.class === 'railway' || item.type === 'station' ? 'station' : 'place',
  }));
}

/**
 * Fetch candidates from ArcGIS World Geocoder as a fallback.
 */
async function fetchArcGIS(query: string): Promise<GeocodeCandidate[]> {
  const queryWithCity = query.toLowerCase().includes('bogota') ? query : `${query}, Bogotá`;
  const url = `https://geocode.arcgis.com/arcgis/rest/services/World/GeocodeServer/findAddressCandidates?f=json&singleLine=${encodeURIComponent(queryWithCity)}&location=-74.07,4.60&distance=50000&maxLocations=6`;

  const response = await fetch(url, {
    signal: AbortSignal.timeout(5000), // 5s timeout
  });

  if (!response.ok) {
    throw new Error(`ArcGIS Geocode HTTP ${response.status}`);
  }

  const data = await response.json();
  const candidates = data?.candidates ?? [];
  if (!Array.isArray(candidates)) return [];

  return candidates
    .filter((c: any) => c.score > 50)
    .map((c: any) => ({
      name: c.address,
      lat: c.location.y,
      lon: c.location.x,
      type: 'place',
    }));
}

/**
 * Calculates geographic distance in meters between two coordinates.
 */
function getDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371e3; // Earth radius in meters
  const phi1 = (lat1 * Math.PI) / 180;
  const phi2 = (lat2 * Math.PI) / 180;
  const deltaPhi = ((lat2 - lat1) * Math.PI) / 180;
  const deltaLon = ((lon2 - lon1) * Math.PI) / 180;

  const a =
    Math.sin(deltaPhi / 2) * Math.sin(deltaPhi / 2) +
    Math.cos(phi1) * Math.cos(phi2) * Math.sin(deltaLon / 2) * Math.sin(deltaLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return R * c;
}

/**
 * Main geocode function. Attempts local lookup first, then Nominatim, falling back to ArcGIS.
 */
export async function geocodeAddress(query: string): Promise<GeocodeCandidate[]> {
  const trimmed = query.trim();
  if (trimmed.length < 3) return [];

  // 1. Local Database Search (Instant and offline)
  const localCandidates = searchLocalCatalog(trimmed);

  let remoteCandidates: GeocodeCandidate[] = [];
  
  // 2. Query Remote APIs
  try {
    console.log(`[Geocode] Querying Nominatim for: "${trimmed}"`);
    remoteCandidates = await fetchNominatim(trimmed);
  } catch (error) {
    console.warn('[Geocode] Nominatim failed, falling back to ArcGIS:', error);
    try {
      console.log(`[Geocode] Querying ArcGIS Geocoder for: "${trimmed}"`);
      remoteCandidates = await fetchArcGIS(trimmed);
    } catch (arcgisError) {
      console.error('[Geocode] ArcGIS geocoding failed as well:', arcgisError);
    }
  }

  // 3. Merge and Deduplicate candidates (within 50 meters of each other)
  const merged = [...localCandidates, ...remoteCandidates];
  const uniqueCandidates: GeocodeCandidate[] = [];

  for (const item of merged) {
    const isDuplicate = uniqueCandidates.some(
      (existing) => getDistance(existing.lat, existing.lon, item.lat, item.lon) < 50
    );
    if (!isDuplicate) {
      uniqueCandidates.push(item);
    }
  }

  return uniqueCandidates.slice(0, 8);
}
