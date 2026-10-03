import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dev server proxies the API and WebSocket so the app is same-origin in dev,
// exactly as it is behind nginx/Caddy in docker and production.
const api = process.env.API_URL ?? 'http://localhost:4000';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': { target: api, changeOrigin: false },
      '/ws': { target: api.replace(/^http/, 'ws'), ws: true },
      '/health': { target: api },
    },
  },
  build: { sourcemap: true },
});
