const fs = require('fs');
const catalogPath = 'c:/Users/Esteban/Desktop/transmilenio/server/src/data/master_catalog.json';
const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));

const routes = catalog.routes || {};

console.log('Searching for K86 variants:');
for (const [code, variants] of Object.entries(routes)) {
  if (code.includes('K86')) {
    console.log(`Code: "${code}" has ${variants.length} variants:`);
    variants.forEach((v, idx) => {
      console.log(`  [${idx}] id: "${v.id}", name: "${v.nombre}", stops count: ${v.stops ? v.stops.length : 0}, sistema: "${v.sistema}", tipoServicio: "${v.tipoServicio}"`);
    });
  }
}
