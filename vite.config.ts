import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The viewer is served under https://tab.aabder.xyz/view, next to the API on the same origin.
// In development, API and hub calls are proxied to the backend running locally.
const backend = process.env.TAB_BACKEND ?? 'http://localhost:8080';

export default defineConfig({
  base: '/view/',
  plugins: [react()],
  // MapLibre alone is ~1 MB; one bundle is fine for a single-page viewer.
  build: { chunkSizeWarningLimit: 1600 },
  server: {
    proxy: {
      '/api': backend,
      '/hubs': { target: backend, ws: true },
    },
  },
});
