import https from 'https';

const API_HOST = 'api.buscador-rutas.transmilenio.gov.co';
const HEADERS = {
  'Accept-Encoding': 'gzip',
  'Connection': 'Keep-Alive',
  'Host': 'api.buscador-rutas.transmilenio.gov.co',
  'User-Agent': 'okhttp/4.12.0',
  'uuid': 'fd1be953-d85e-4c63-8c23-234f143f445d',
  'version': '2.9.5'
};

async function fetchJson(path: string) {
  return new Promise((resolve, reject) => {
    https.get({
      hostname: API_HOST,
      path,
      headers: HEADERS
    }, (res) => {
      // API uses gzip, so we might need zlib to decompress? 
      // Actually, if we don't send Accept-Encoding: gzip, maybe it sends plain text?
      // Let's remove Accept-Encoding to save effort, see if it works.
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { resolve(data); }
      });
    }).on('error', reject);
  });
}

// Without Accept-Encoding
async function test() {
  const url = `/loader.php?lServicio=Rutas&lTipo=api&lFuncion=searchRutaByTipo&tipo_ruta=TIPORUTA&search=`;
  console.log(`Fetching ${url}`);
  const result: any = await fetchJson(url);
  console.log(result.lista_rutas ? `Found ${result.lista_rutas.length} routes` : result);
}

test();
