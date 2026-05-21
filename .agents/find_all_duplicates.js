const fs = require('fs');

const catalogPath = 'c:/Users/Esteban/Desktop/transmilenio/server/src/data/master_catalog.json';
const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));

function normalize(str) {
  if (!str) return '';
  return str.toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, '')
    .trim();
}

const routes = catalog.routes || {};
const seen = new Map();
const duplicatesList = [];

for (const [code, variants] of Object.entries(routes)) {
  for (const route of variants) {
    const service = `${route.sistema} ${route.tipoServicio}`.toUpperCase();
    const isAlimentador = service.includes('ALIMENTADOR');
    const type = service.includes('ZONAL') || service.includes('TRANSMIZONAL') || isAlimentador ? 'zonal' : 'troncal';
    
    const stops = route.stops || [];
    const origin = route.origin || stops[0]?.nombre || code;
    const destination = route.destination || stops[stops.length - 1]?.nombre || route.nombre;
    
    const normOrigin = normalize(origin);
    const normDest = normalize(destination);
    
    // We also check if the reversed direction is treated as same (normally they are separate directions, so keep direction distinct)
    const key = `${code}|${type}|${normOrigin}|${normDest}`;
    
    if (seen.has(key)) {
      duplicatesList.push({
        code,
        type,
        origin,
        destination,
        existing: seen.get(key),
        duplicate: { id: route.id, nombre: route.nombre }
      });
    } else {
      seen.set(key, { id: route.id, nombre: route.nombre });
    }
  }
}

console.log('Duplicates found by code + type + origin + destination:', duplicatesList.length);
duplicatesList.forEach((d, idx) => {
  if (idx < 30) {
    console.log(`[${idx}] Code: ${d.code} (${d.type})`);
    console.log(`    Origin: "${d.origin}" -> Destination: "${d.destination}"`);
    console.log(`    Existing: id=${d.existing.id}, name="${d.existing.nombre}"`);
    console.log(`    Duplicate: id=${d.duplicate.id}, name="${d.duplicate.nombre}"`);
  }
});
