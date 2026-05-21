import fs from 'fs';

const data = JSON.parse(fs.readFileSync('server/src/data/master_catalog.json', 'utf8'));

// Measure size of stations as is
console.log('Original Stations Size:', (JSON.stringify(data.stations).length / 1024 / 1024).toFixed(2), 'MB');
console.log('Original Routes Size:', (JSON.stringify(data.routes).length / 1024 / 1024).toFixed(2), 'MB');

// Try cleaning routes
const cleanRoutes = {};
for (const [code, variants] of Object.entries(data.routes)) {
  cleanRoutes[code] = variants.map(route => {
    const origin = route.stops?.[0]?.nombre || '';
    const destination = route.stops?.[route.stops.length - 1]?.nombre || '';
    return {
      id: route.id,
      codigo: route.codigo,
      nombre: route.nombre,
      color: route.color,
      sistema: route.sistema,
      tipoServicio: route.tipoServicio,
      horarios: route.horarios,
      origin,
      destination
    };
  });
}

console.log('Cleaned Routes (no geometries, no stops) Size:', (JSON.stringify(cleanRoutes).length / 1024 / 1024).toFixed(2), 'MB');

// What if we clean stations?
// Let's see what is inside a station
const sampleStationKey = Object.keys(data.stations)[0];
console.log('Sample station:', JSON.stringify(data.stations[sampleStationKey], null, 2));

// Clean stations by removing heavy duplicated route info in wagons if any
const cleanStations = {};
for (const [code, station] of Object.entries(data.stations)) {
  const cleanWagons = {};
  for (const [wagon, routes] of Object.entries(station.wagons)) {
    cleanWagons[wagon] = routes.map(r => ({
      codigo: r.codigo,
      nombre: r.nombre,
      color: r.color,
      sistema: r.sistema,
      tipoServicio: r.tipoServicio
    }));
  }
  cleanStations[code] = {
    id: station.id,
    codigo: station.codigo,
    nombre: station.nombre,
    direccion: station.direccion,
    coordenada: station.coordenada,
    sistema: station.sistema,
    tipoServicio: station.tipoServicio,
    wagons: cleanWagons
  };
}

console.log('Cleaned Stations Size:', (JSON.stringify(cleanStations).length / 1024 / 1024).toFixed(2), 'MB');
console.log('Total Cleaned Catalog Size:', ((JSON.stringify({ stations: cleanStations, routes: cleanRoutes }).length) / 1024 / 1024).toFixed(2), 'MB');
