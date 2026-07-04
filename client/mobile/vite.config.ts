import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// This is a *separate* front-end from the website (../index.html + ../src).
// It ships only inside the Capacitor Android shell (see mobile/scripts/build-web.mjs)
// and deliberately looks nothing like the website — but it reuses the website's
// data/service layer (`@shared`) so the two clients never drift (spec §1.1 R2).
const here = path.dirname(fileURLToPath(import.meta.url));
const clientRoot = path.resolve(here, '..');

export default defineConfig({
  root: here,
  // Reuse the website's public assets (models/, draco/, logo, icons) verbatim.
  publicDir: path.resolve(clientRoot, 'public'),
  resolve: {
    alias: {
      '@shared': path.resolve(clientRoot, 'src'),
      '@': path.resolve(here, 'src'),
    },
  },
  server: {
    host: '127.0.0.1',
    port: 5273,
    strictPort: true,
    proxy: {
      '/api': { target: 'http://localhost:3002', changeOrigin: true },
    },
  },
  build: {
    outDir: path.resolve(here, 'dist'),
    emptyOutDir: true,
  },
});
