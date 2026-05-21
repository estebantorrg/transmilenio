import fs from 'fs';

const data = JSON.parse(fs.readFileSync('server/src/data/master_catalog.json', 'utf8'));

const cleanStations = {};
for (const [code, station] of Object.entries(data.stations)) {
  const isTroncal = /^TM\d+$/i.test(station.codigo);
  
  const cleanWagons = {};
  for (const [wagon, routes] of Object.entries(station.wagons)) {
    cleanWagons[wagon] = routes.map(r => {
      if (isTroncal) {
        // Troncal stations need more info for the premium popups
        return {
          id: r.id,
          codigo: r.codigo,
          nombre: r.nombre,
          color: r.color,
          sistema: r.sistema,
          tipoServicio: r.tipoServicio,
          horarios: r.horarios
        };
      } else {
        // Zonal stops only need route code/color for mapping
        return {
          codigo: r.codigo,
          color: r.color
        };
      }
    });
  }

  if (isTroncal) {
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
  } else {
    // Zonal stop - lightweight structure
    cleanStations[code] = {
      codigo: station.codigo,
      nombre: station.nombre,
      coordenada: station.coordenada,
      wagons: cleanWagons
    };
  }
}

console.log('Optimized Stations Size:', (JSON.stringify(cleanStations).length / 1024 / 1024).toFixed(2), 'MB');
