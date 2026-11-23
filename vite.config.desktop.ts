import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'path';
import { resolveServerPort } from './server.config.ts';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve('./src'),
    },
  },
  build: {
    outDir: 'dist-desktop',
    emptyOutDir: true,
  },
  server: {
    host: '0.0.0.0',
    port: resolveServerPort(),
    strictPort: true,
    allowedHosts: true,
    hmr: false,
  },
});
