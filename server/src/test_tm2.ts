import https from 'https';

const API_HOST = 'api.buscador-rutas.transmilenio.gov.co';
const HEADERS = {
  'Connection': 'Keep-Alive',
  'Host': 'api.buscador-rutas.transmilenio.gov.co',
  'User-Agent': 'okhttp/4.12.0',
  'uuid': 'fd1be953-d85e-4c63-8c23-234f143f445d',
  'version': '2.9.5'
};

async function fetchJson(apiPath: string): Promise<any> {
  return new Promise((resolve, reject) => {
    https.get({
      hostname: API_HOST,
      path: apiPath,
      headers: HEADERS
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch(e) {
          console.error("JSON Parse failed. Raw response:");
          console.error(data.slice(0, 1000));
          reject(e);
        }
      });
    }).on('error', reject);
  });
}

async function test() {
  const url = `/loader.php?lServicio=Rutas&lTipo=api&lFuncion=infoRuta&idRuta=281&nombre=P.USME&codigo=H75`;
  const result = await fetchJson(url);
  console.log(JSON.stringify(result.estaciones, null, 2).slice(0, 500));
}

test();
