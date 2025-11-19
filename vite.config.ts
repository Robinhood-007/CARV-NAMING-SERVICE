import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import nodePolyfills from 'vite-plugin-node-polyfills';

export default defineConfig({
  plugins: [
    nodePolyfills({
      protocolImports: true,
    }),
    react(),
  ],
  resolve: {
    alias: {
      buffer: 'buffer',
      process: 'process/browser',
      stream: 'stream-browserify',
      crypto: 'crypto-browserify',
      util: 'util',
      events: 'events',
    },
  },
  define: { 'process.env': {}, global: 'globalThis' },
  optimizeDeps: {
    include: ['buffer', 'process', 'stream-browserify', 'crypto-browserify', 'util', 'events'],
    esbuildOptions: {
      define: { global: 'globalThis' },
    },
  },
});
