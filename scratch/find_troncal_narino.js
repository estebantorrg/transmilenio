const fs = require('fs');
const catalogPath = 'c:/Users/Esteban/Desktop/transmilenio/server/src/data/master_catalog.json';
const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));

const stations = catalog.stations || {};
for (const [code, s] of Object.entries(stations)) {
  if (s.nombre.toLowerCase().includes('nariño') || s.nombre.toLowerCase().includes('narino')) {
    console.log(`Station code: ${code}, name: ${s.nombre}, type: ${s.sistema}`);
    console.log('Wagons:', Object.keys(s.wagons));
    for (const [wName, routes] of Object.entries(s.wagons)) {
      console.log(`  Wagon ${wName} routes:`, routes.map(r => `${r.codigo} (${r.nombre})`));
    }
  }
}
