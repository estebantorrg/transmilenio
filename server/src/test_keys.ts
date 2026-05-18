import https from 'https';

const API_HOST = 'api.buscador-rutas.transmilenio.gov.co';
const HEADERS = {
  'Connection': 'Keep-Alive',
  'Host': 'api.buscador-rutas.transmilenio.gov.co',
  'User-Agent': 'okhttp/4.12.0',
  'uuid': 'fd1be953-d85e-4c63-8c23-234f143f445d',
  'version': '2.9.5'
};

async function fetchJson() {
  return new Promise((resolve, reject) => {
    https.get({
      hostname: API_HOST,
      path: '/loader.php?lServicio=Rutas&lTipo=api&lFuncion=infoRuta&idRuta=281&nombre=P.USME&codigo=H75',
      headers: HEADERS
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch(e) { resolve(null); }
      });
    }).on('error', reject);
  });
}

fetchJson().then((data: any) => {
  if (data) {
    console.log('Main keys:', Object.keys(data));
    if (data.recorrido) {
      console.log('recorrido keys:', Object.keys(data.recorrido));
      const first = Object.keys(data.recorrido)[0];
      if (first) {
        console.log(`recorrido["${first}"] content keys:`, Object.keys(data.recorrido[first]));
        console.log(`recorrido["${first}"] sample:`, JSON.stringify(data.recorrido[first], null, 2).slice(0, 500));
      }
    }
  } else {
    console.log('data was null');
  }
});
