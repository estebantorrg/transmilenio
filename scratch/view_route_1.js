const fs = require('fs');
const catalogPath = 'c:/Users/Esteban/Desktop/transmilenio/server/src/data/master_catalog.json';
const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));

const routes = catalog.routes || {};
const r1 = routes['1'];
console.log('Route 1 info:', JSON.stringify(r1, null, 2));
