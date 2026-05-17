import express from 'express';
import cors from 'cors';
import apiRoutes from './routes/api.js';

const app = express();
const PORT = process.env.PORT || 3001;

// Enable CORS for the Vite dev server
app.use(cors({
  origin: ['http://localhost:5173', 'http://localhost:4173'],
  methods: ['GET'],
}));

app.use(express.json());

// Mount API routes
app.use('/api', apiRoutes);

// Root
app.get('/', (_req, res) => {
  res.json({
    name: 'Transmilenio API Proxy',
    version: '1.0.0',
    endpoints: [
      'GET /api/troncal/routes',
      'GET /api/troncal/stations',
      'GET /api/troncal/wagons',
      'GET /api/troncal/corridors',
      'GET /api/zonal/routes',
      'GET /api/zonal/stops',
      'GET /api/zonal/stop-routes',
      'GET /api/health',
    ],
  });
});

app.listen(PORT, () => {
  console.log(`\n🚌 Transmilenio API Proxy running on http://localhost:${PORT}\n`);
});
