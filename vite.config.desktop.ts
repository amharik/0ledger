import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
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
    port: 1420,
    strictPort: true,
  },
});
