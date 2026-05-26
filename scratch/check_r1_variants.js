const fs = require('fs');
const catalogPath = 'c:/Users/Esteban/Desktop/transmilenio/server/src/data/master_catalog.json';
const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));

const routes = catalog.routes || {};
const r1 = routes['1'] || [];
console.log('Route 1 variants count:', r1.length);
r1.forEach((v, i) => {
  console.log(`Variant ${i}:`, {
    id: v.id,
    codigo: v.codigo,
    nombre: v.nombre,
    sistema: v.sistema,
    tipoServicio: v.tipoServicio,
    stops_count: v.stops ? v.stops.length : 0
  });
});
