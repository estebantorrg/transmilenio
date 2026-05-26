// Test both troncal and zonal endpoints
async function test() {
  const tests = [
    { ruta: 'K86', Nombre: 'Portal ElDorado', type: 'troncal', label: 'Troncal K86' },
    { ruta: 'H15', Nombre: 'Portal Tunal', type: 'troncal', label: 'Troncal H15' },
    { ruta: 'B11', Nombre: 'Terminal', type: 'troncal', label: 'Troncal B11' },
    { ruta: 'F408', Nombre: '', type: 'zonal', label: 'Zonal F408' },
    { ruta: '1', Nombre: 'Universidades', type: 'troncal', label: 'Troncal 1' },
  ];

  for (const t of tests) {
    try {
      const res = await fetch('http://localhost:3002/api/buses', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ruta: t.ruta, Nombre: t.Nombre, type: t.type }),
      });
      const json = await res.json();
      console.log(`${t.label}: ${json.count} buses (success=${json.success})`);
    } catch (e) {
      console.error(`${t.label}: ERROR - ${e.message}`);
    }
  }
}

// Wait for server
setTimeout(test, 2000);
