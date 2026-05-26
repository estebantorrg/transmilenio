import https from 'https';
import zlib from 'zlib';

// Test multiple variations of route "1" to find what works
const tests = [
  { ruta: "1", Nombre: "Universidades" },
  { ruta: "1", Nombre: "Portal Eldorado" },
  { ruta: "1", Nombre: "" },
  { ruta: "001", Nombre: "Universidades" },
  { ruta: "8", Nombre: "Terminal" },
  { ruta: "8", Nombre: "Guatoque" },
  { ruta: "8", Nombre: "" },
  { ruta: "F23", Nombre: "P. Américas" },  // Known working
];

async function testBuses(body) {
  const postData = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'tmsa-transmiapp-shvpc.uc.r.appspot.com',
      path: '/buses',
      method: 'POST',
      headers: {
        'Accept-Encoding': 'gzip',
        'Appid': '9a2c3b48f0c24ae9bfba38e94f27c3ea',
        'Connection': 'Keep-Alive',
        'Content-Type': 'application/json; charset=UTF-8',
        'Content-Length': Buffer.byteLength(postData),
        'User-Agent': 'okhttp/4.12.0',
        'uuid': 'fd1be953-d85e-4c63-8c23-234f143f445d',
        'version': '2.9.5',
      },
      timeout: 10000,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks);
        const enc = res.headers['content-encoding'];
        if (enc === 'gzip') {
          zlib.gunzip(raw, (err, dec) => {
            if (err) resolve({ status: res.statusCode, body: raw.toString() });
            else resolve({ status: res.statusCode, body: dec.toString() });
          });
        } else {
          resolve({ status: res.statusCode, body: raw.toString() });
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.write(postData);
    req.end();
  });
}

for (const test of tests) {
  try {
    const res = await testBuses(test);
    let parsed;
    try { parsed = JSON.parse(res.body); } catch { parsed = res.body; }
    const count = Array.isArray(parsed) ? parsed.length : '?';
    console.log(`ruta="${test.ruta}" Nombre="${test.Nombre}" => ${count} buses (status ${res.status})`);
    if (Array.isArray(parsed) && parsed.length > 0) {
      console.log(`  First bus: ${JSON.stringify(parsed[0])}`);
    }
  } catch (err) {
    console.log(`ruta="${test.ruta}" Nombre="${test.Nombre}" => ERROR: ${err.message}`);
  }
}
