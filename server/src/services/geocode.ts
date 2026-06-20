import * as tmApi from './tm_api.js';

export interface GeocodeCandidate {
  name: string;
  lat: number;
  lon: number;
  type: 'station' | 'stop' | 'address' | 'place';
  code?: string;
}

interface LocalCandidate extends GeocodeCandidate {
  score: number;
}

interface VerifiedLocalStation extends GeocodeCandidate {
  aliases: string[];
}

const BOGOTA_BOUNDS = {
  west: -74.25,
  south: 4.45,
  east: -73.98,
  north: 4.85,
};

const LOCAL_STRONG_MATCH_SCORE = 80;
const LOCAL_MIN_SCORE = 45;
const QUERY_STOP_WORDS = new Set(['estacion', 'tm', 'transmilenio', 'paradero', 'bogota']);

const VERIFIED_LOCAL_STATIONS: VerifiedLocalStation[] = [
  {
    name: 'AV. Jimenez - Caracas (Estacion TM)',
    lat: 4.60287397,
    lon: -74.08042807,
    type: 'station',
    code: '09110',
    aliases: ['Avenida Jimenez Caracas', 'Av Jimenez Caracas', 'Jimenez Caracas'],
  },
  {
    name: 'AV. Jimenez - CL 13 (Estacion TM)',
    lat: 4.60304793,
    lon: -74.07910861,
    type: 'station',
    code: '14003',
    aliases: ['Avenida Jimenez Calle 13', 'Av Jimenez Calle 13', 'Jimenez Calle 13', 'Jimenez CL 13'],
  },
  {
    name: 'Ricaurte - NQS (Estacion TM)',
    lat: 4.6116862,
    lon: -74.09386888,
    type: 'station',
    code: '07111',
    aliases: ['Ricaurte NQS'],
  },
  {
    name: 'Ricaurte - CL 13 (Estacion TM)',
    lat: 4.61301485,
    lon: -74.09048002,
    type: 'station',
    code: '12003',
    aliases: ['Ricaurte Calle 13', 'Ricaurte CL 13'],
  },
  {
    name: 'Las Aguas - Centro Colombo Americano (Estacion TM)',
    lat: 4.60257975,
    lon: -74.06840143,
    type: 'station',
    code: 'TM0121',
    aliases: ['Las Aguas Centro Colombo Americano', 'Las Aguas'],
  },
  {
    name: 'Universidades - CityU (Estacion TM)',
    lat: 4.60464286,
    lon: -74.06730954,
    type: 'station',
    code: 'TM0122',
    aliases: ['Universidades CityU', 'Universidades City U', 'Universidades'],
  },
];

function normalizeString(str: string): string {
  return str
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();
}

function canonicalSearchText(str: string): string {
  return normalizeString(str)
    .replace(/\bavenida\b/g, 'av')
    .replace(/\bcalle\b/g, 'cl')
    .replace(/\bcarrera\b/g, 'kr')
    .replace(/\btransmilenio\b/g, 'tm')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function compactSearchText(str: string): string {
  return canonicalSearchText(str).replace(/\s+/g, '');
}

function queryTokens(query: string): string[] {
  return canonicalSearchText(query)
    .split(' ')
    .filter((token) => token.length > 1 && !QUERY_STOP_WORDS.has(token));
}

function uniqueSearchTexts(candidate: GeocodeCandidate, aliases: string[] = []): string[] {
  return Array.from(new Set([candidate.name, candidate.code || '', ...aliases].filter(Boolean)));
}

function scoreCandidate(query: string, candidate: GeocodeCandidate, aliases: string[] = []): number {
  const canonicalQuery = canonicalSearchText(query);
  const compactQuery = compactSearchText(query);
  const tokens = queryTokens(query);
  const code = canonicalSearchText(candidate.code || '');

  if (code && code === canonicalQuery) return 100;

  let best = 0;
  for (const text of uniqueSearchTexts(candidate, aliases)) {
    const canonicalText = canonicalSearchText(text);
    const compactText = compactSearchText(text);
    const textTokens = new Set(canonicalText.split(' ').filter(Boolean));

    if (compactText === compactQuery) best = Math.max(best, 96);
    else if (compactText.startsWith(compactQuery)) best = Math.max(best, 90);
    else if (compactText.includes(compactQuery)) best = Math.max(best, 84);

    if (tokens.length > 0) {
      const matched = tokens.filter((token) => textTokens.has(token) || canonicalText.includes(token)).length;
      if (matched === tokens.length) {
        best = Math.max(best, 80 + Math.min(tokens.length, 8));
      } else if (matched >= 2) {
        best = Math.max(best, 45 + Math.round((matched / tokens.length) * 20));
      }
    }
  }

  return best;
}

function inBogota(candidate: GeocodeCandidate): boolean {
  return Number.isFinite(candidate.lat) &&
    Number.isFinite(candidate.lon) &&
    candidate.lon >= BOGOTA_BOUNDS.west &&
    candidate.lon <= BOGOTA_BOUNDS.east &&
    candidate.lat >= BOGOTA_BOUNDS.south &&
    candidate.lat <= BOGOTA_BOUNDS.north;
}

function finiteNumber(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function stripLocalScore(candidate: LocalCandidate): GeocodeCandidate {
  const { score: _score, ...rest } = candidate;
  return rest;
}

function searchLocalCatalog(query: string): LocalCandidate[] {
  if (!canonicalSearchText(query)) return [];

  const catalog = tmApi.getCatalog();
  const candidates: LocalCandidate[] = [];

  for (const station of VERIFIED_LOCAL_STATIONS) {
    const score = scoreCandidate(query, station, station.aliases);
    if (score >= LOCAL_MIN_SCORE) candidates.push({ ...station, score });
  }

  for (const [fallbackCode, station] of Object.entries(catalog.stations || {})) {
    if (!station.coordenada || !station.coordenada.includes(',')) continue;
    const [latText, lonText] = station.coordenada.split(',');
    const lat = finiteNumber(latText);
    const lon = finiteNumber(lonText);
    if (lat === null || lon === null) continue;

    // Skip generic stations that have verified split stations
    if (station.codigo === 'TM0013' || station.codigo === 'TM0069') continue;

    const isTroncal = /^TM\d+$/i.test(station.codigo);
    const candidate: GeocodeCandidate = {
      name: `${station.nombre} ${isTroncal ? '(Estacion TM)' : '(Paradero)'}`,
      lat,
      lon,
      type: isTroncal ? 'station' : 'stop',
      code: station.codigo || fallbackCode,
    };
    const score = scoreCandidate(query, candidate, [station.nombre, station.direccion, station.codigo]);
    if (score >= LOCAL_MIN_SCORE) candidates.push({ ...candidate, score });
  }

  const uniqueByCode = new Map<string, LocalCandidate>();
  for (const candidate of candidates) {
    const key = candidate.code || `${candidate.lat.toFixed(6)},${candidate.lon.toFixed(6)}`;
    const existing = uniqueByCode.get(key);
    if (!existing || candidate.score > existing.score) uniqueByCode.set(key, candidate);
  }

  return Array.from(uniqueByCode.values())
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (a.type !== b.type) return a.type === 'station' ? -1 : 1;
      return a.name.localeCompare(b.name, 'es-CO', { numeric: true });
    })
    .slice(0, 8);
}

async function fetchNominatim(query: string): Promise<GeocodeCandidate[]> {
  const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&viewbox=-74.25,4.45,-73.98,4.85&bounded=1&limit=6`;

  const response = await fetch(url, {
    headers: {
      'User-Agent': 'TransMilenioExplorer/1.0 (contact: github.com/estebantorrg/transmilenio)',
      'Accept-Language': 'es-CO,es;q=0.9',
    },
    signal: AbortSignal.timeout(5000),
  });

  if (!response.ok) throw new Error(`Nominatim HTTP ${response.status}`);

  const data = await response.json();
  if (!Array.isArray(data)) return [];

  return data
    .map((item: any): GeocodeCandidate | null => {
      if (typeof item?.display_name !== 'string') return null;
      const lat = finiteNumber(item.lat);
      const lon = finiteNumber(item.lon);
      if (lat === null || lon === null) return null;
      return {
        name: item.display_name.split(',').slice(0, 3).join(',').trim(),
        lat,
        lon,
        type: item.class === 'railway' || item.type === 'station' ? 'station' : 'place',
      };
    })
    .filter((candidate): candidate is GeocodeCandidate => candidate !== null)
    .filter(inBogota);
}

async function fetchArcGIS(query: string): Promise<GeocodeCandidate[]> {
  const queryWithCity = query.toLowerCase().includes('bogota') ? query : `${query}, Bogota`;
  const url = `https://geocode.arcgis.com/arcgis/rest/services/World/GeocodeServer/findAddressCandidates?f=json&singleLine=${encodeURIComponent(queryWithCity)}&location=-74.07,4.60&distance=50000&maxLocations=6`;

  const response = await fetch(url, {
    signal: AbortSignal.timeout(5000),
  });

  if (!response.ok) throw new Error(`ArcGIS Geocode HTTP ${response.status}`);

  const data = await response.json();
  const candidates = data?.candidates ?? [];
  if (!Array.isArray(candidates)) return [];

  return candidates
    .map((c: any): GeocodeCandidate | null => {
      const score = finiteNumber(c?.score);
      const lat = finiteNumber(c?.location?.y);
      const lon = finiteNumber(c?.location?.x);
      if (score === null || score < 75 || lat === null || lon === null || typeof c?.address !== 'string') {
        return null;
      }
      return {
        name: c.address,
        lat,
        lon,
        type: 'place',
      };
    })
    .filter((candidate): candidate is GeocodeCandidate => candidate !== null)
    .filter(inBogota);
}

function getDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const radiusMeters = 6371e3;
  const toRad = (degrees: number) => (degrees * Math.PI) / 180;
  const phi1 = toRad(lat1);
  const phi2 = toRad(lat2);
  const deltaPhi = toRad(lat2 - lat1);
  const deltaLon = toRad(lon2 - lon1);

  const a =
    Math.sin(deltaPhi / 2) ** 2 +
    Math.cos(phi1) * Math.cos(phi2) * Math.sin(deltaLon / 2) ** 2;
  return 2 * radiusMeters * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function dedupeCandidates(candidates: GeocodeCandidate[]): GeocodeCandidate[] {
  const uniqueCandidates: GeocodeCandidate[] = [];

  for (const item of candidates) {
    if (!inBogota(item)) continue;
    const isDuplicate = uniqueCandidates.some(
      (existing) =>
        Boolean(existing.code && item.code && existing.code === item.code) ||
        getDistance(existing.lat, existing.lon, item.lat, item.lon) < 50
    );
    if (!isDuplicate) uniqueCandidates.push(item);
  }

  return uniqueCandidates;
}

function remoteLooksRelevant(query: string, candidate: GeocodeCandidate): boolean {
  const tokens = queryTokens(query);
  if (tokens.length === 0) return true;
  const text = canonicalSearchText(candidate.name);
  const matched = tokens.filter((token) => text.includes(token)).length;
  return matched >= Math.min(tokens.length, 2);
}

export async function geocodeAddress(query: string): Promise<GeocodeCandidate[]> {
  const trimmed = query.trim();
  if (trimmed.length < 3) return [];

  const localCandidates = searchLocalCatalog(trimmed);
  if (localCandidates[0]?.score >= LOCAL_STRONG_MATCH_SCORE) {
    return dedupeCandidates(localCandidates.map(stripLocalScore)).slice(0, 8);
  }

  let remoteCandidates: GeocodeCandidate[] = [];
  try {
    console.log(`[Geocode] Querying Nominatim; queryLength=${trimmed.length}`);
    remoteCandidates = await fetchNominatim(trimmed);
  } catch (error) {
    console.warn('[Geocode] Nominatim failed, falling back to ArcGIS:', error);
    try {
      console.log(`[Geocode] Querying ArcGIS Geocoder; queryLength=${trimmed.length}`);
      remoteCandidates = await fetchArcGIS(trimmed);
    } catch (arcgisError) {
      console.error('[Geocode] ArcGIS geocoding failed as well:', arcgisError);
    }
  }

  const relevantRemote = remoteCandidates.filter((candidate) => remoteLooksRelevant(trimmed, candidate));
  return dedupeCandidates([
    ...localCandidates.map(stripLocalScore),
    ...relevantRemote,
  ]).slice(0, 8);
}
