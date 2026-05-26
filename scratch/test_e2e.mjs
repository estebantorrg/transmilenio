// Simulate EXACTLY what the client does:
// 1. POST to our server's /api/buses
// 2. Parse the response the same way extractLiveBuses does

async function test() {
  const routes = [
    { code: '1', name: '' },
    { code: 'F23', name: '' },
    { code: '8', name: '' },
  ];

  for (const route of routes) {
    try {
      const res = await fetch('http://localhost:3002/api/buses', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ruta: route.code, Nombre: route.name }),
      });
      
      const json = await res.json();
      console.log(`\n=== Route ${route.code} ===`);
      console.log('Response keys:', Object.keys(json));
      console.log('success:', json.success);
      console.log('count:', json.count);
      console.log('data is array?', Array.isArray(json.data));
      console.log('data length:', json.data?.length);
      
      if (json.data && json.data.length > 0) {
        const bus = json.data[0];
        console.log('First bus keys:', Object.keys(bus));
        console.log('First bus lat:', bus.latitude, typeof bus.latitude);
        console.log('First bus lng:', bus.longitude, typeof bus.longitude);
        console.log('First bus:', JSON.stringify(bus).slice(0, 300));
      }

      // Now simulate extractLiveBuses
      const payloadArray = findBusPayloadArray(json);
      console.log('findBusPayloadArray result:', payloadArray ? `array of ${payloadArray.length}` : 'null');
      
      if (payloadArray) {
        const buses = payloadArray
          .map((bus, i) => normalizeLiveBus(bus, i, route.code))
          .filter(b => b !== null);
        console.log('After normalizeLiveBus:', buses.length, 'valid buses');
        
        // Check why some might be filtered
        const nullCount = payloadArray.filter((bus, i) => normalizeLiveBus(bus, i, route.code) === null).length;
        if (nullCount > 0) {
          console.log('FILTERED OUT:', nullCount, 'buses');
          const firstNull = payloadArray.find((bus, i) => normalizeLiveBus(bus, i, route.code) === null);
          console.log('Example filtered bus:', JSON.stringify(firstNull).slice(0, 300));
        }
      }
    } catch (err) {
      console.error(`Route ${route.code} error:`, err.message);
    }
  }
}

function toFiniteNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function isBusLike(value) {
  if (!value || typeof value !== 'object') return false;
  return toFiniteNumber(value.latitude ?? value.lat) !== null &&
    toFiniteNumber(value.longitude ?? value.lng ?? value.lon) !== null;
}

function busValuesFromObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const buses = Object.values(value).filter(isBusLike);
  return buses.length > 0 ? buses : null;
}

function findBusPayloadArray(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return null;
  const candidates = [payload.data, payload.buses, payload.result, payload.results, payload.vehiculos, payload.vehicles];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate;
  }
  for (const candidate of candidates) {
    const buses = busValuesFromObject(candidate);
    if (buses) return buses;
  }
  return busValuesFromObject(payload);
}

function normalizeLiveBus(rawBus, index, routeCode) {
  if (!rawBus || typeof rawBus !== 'object') return null;
  const raw = rawBus;
  const latitude = toFiniteNumber(raw.latitude ?? raw.lat);
  const longitude = toFiniteNumber(raw.longitude ?? raw.lng ?? raw.lon);
  if (latitude === null || longitude === null) return null;
  const fallbackId = `${routeCode}-${latitude.toFixed(6)}-${longitude.toFixed(6)}-${index}`;
  const rawId = raw.id ?? raw.vehicle_id ?? raw.vehiculo_id ?? raw.label ?? fallbackId;
  return { id: String(rawId), latitude, longitude, label: String(raw.label ?? rawId) };
}

test();
