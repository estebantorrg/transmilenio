import http from 'http';

const postData = JSON.stringify({ ruta: "5", nombre: "Av. Jiménez" });

const options = {
  hostname: 'localhost',
  port: 3002,
  path: '/api/buses',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(postData),
  },
};

const req = http.request(options, (res) => {
  console.log('Status:', res.statusCode);
  const chunks = [];
  res.on('data', (chunk) => chunks.push(chunk));
  res.on('end', () => {
    const raw = Buffer.concat(chunks);
    console.log('Response body:', raw.toString());
  });
});

req.on('error', (err) => console.error('Error:', err));
req.write(postData);
req.end();
