const fs = require('fs');
const catalogPath = 'c:/Users/Esteban/Desktop/transmilenio/server/src/data/master_catalog.json';
const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));

const stations = catalog.stations || {};
let narino = null;
for (const [code, s] of Object.entries(stations)) {
  if (s.nombre.toLowerCase().includes('nariño')) {
    narino = s;
    break;
  }
}

console.log('Nariño station catalog data:', JSON.stringify(narino, null, 2));
