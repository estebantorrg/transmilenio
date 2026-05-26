import https from 'https';
import zlib from 'zlib';

const postData = JSON.stringify({ ruta: "H15", Nombre: "Portal Tunal" });

const options = {
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
};

const req = https.request(options, (res) => {
  console.log('Status Code:', res.statusCode);
  console.log('Headers:', res.headers);
  const chunks = [];
  res.on('data', (chunk) => chunks.push(chunk));
  res.on('end', () => {
    const raw = Buffer.concat(chunks);
    const encoding = res.headers['content-encoding'];
    if (encoding === 'gzip') {
      zlib.gunzip(raw, (err, decompressed) => {
        if (err) {
          console.error('Gzip Error:', err);
          console.log('Raw text:', raw.toString());
        } else {
          console.log('Decompressed text:', decompressed.toString());
        }
      });
    } else {
      console.log('Text:', raw.toString());
    }
  });
});

req.on('error', (err) => console.error('Request Error:', err));
req.write(postData);
req.end();
