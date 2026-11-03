import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Saat development, request API & WebSocket diteruskan ke server middleware.
const target = process.env.MIDDLEWARE_URL || 'http://localhost:8080';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': target,
      '/ready': target,
      '/health': target,
      '/ws': { target: target.replace(/^http/, 'ws'), ws: true },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
});
