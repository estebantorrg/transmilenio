const fs = require('fs');
const catalogPath = 'c:/Users/Esteban/Desktop/transmilenio/server/src/data/master_catalog.json';
const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));

const k86 = catalog.routes["K86"];
k86.forEach((v, idx) => {
  const origin = v.origin || (v.stops && v.stops[0]?.nombre) || '';
  const destination = v.destination || (v.stops && v.stops[v.stops.length - 1]?.nombre) || '';
  console.log(`Variant [${idx}]:`);
  console.log(`  id: "${v.id}"`);
  console.log(`  name: "${v.nombre}"`);
  console.log(`  origin: "${origin}"`);
  console.log(`  destination: "${destination}"`);
  console.log(`  stops[0]: "${v.stops?.[0]?.nombre}"`);
  console.log(`  stops[last]: "${v.stops?.[v.stops.length - 1]?.nombre}"`);
});
