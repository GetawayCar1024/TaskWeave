import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

// The API server listens on a fixed port in dev (see packages/server/src/index.ts).
const API = 'http://127.0.0.1:4523';

export default defineConfig({
  plugins: [vue()],
  resolve: { alias: { 'decode-named-character-reference': require.resolve('decode-named-character-reference') } },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': { target: API, changeOrigin: false },
      '/ws': { target: API.replace('http', 'ws'), ws: true },
    },
  },
  build: {
    chunkSizeWarningLimit: 6000,
  },
});
