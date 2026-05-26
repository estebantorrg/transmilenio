const fs = require('fs');
const catalogPath = 'c:/Users/Esteban/Desktop/transmilenio/server/src/data/master_catalog.json';
const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));

console.log('Searching everywhere in master_catalog for MP85...');

let foundInStations = 0;
let foundInRoutes = 0;

for (const [stationCode, station] of Object.entries(catalog.stations || {})) {
  for (const [wagon, routes] of Object.entries(station.wagons || {})) {
    for (const r of routes) {
      if (r.codigo && r.codigo.includes('MP85')) {
        foundInStations++;
        if (foundInStations < 10) {
          console.log(`Station ${stationCode} (${station.nombre}), wagon ${wagon}:`, r);
        }
      }
    }
  }
}

for (const [routeCode, variants] of Object.entries(catalog.routes || {})) {
  if (routeCode.includes('MP85')) {
    foundInRoutes++;
    console.log(`Route code: ${routeCode} has variants:`, variants);
  }
  for (const r of variants) {
    if (r.codigo && r.codigo.includes('MP85')) {
      console.log(`Variant of code ${routeCode} matches MP85:`, r);
    }
  }
}

console.log(`Found in stations: ${foundInStations}, in routes: ${foundInRoutes}`);
