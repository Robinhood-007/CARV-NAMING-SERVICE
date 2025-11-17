import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { nodePolyfills } from 'vite-plugin-node-polyfills'

export default defineConfig({
  plugins: [
    react(),
    nodePolyfills({
      protocolImports: true,
      // you can also add `include: ['buffer', 'process', 'crypto']` if needed later
    }),
  ],
  resolve: {
    alias: {
      crypto: 'crypto-browserify',
    },
  },
  define: {
    // some node-based libs expect process.env to exist
    'process.env': {},
  },
  server: {
    proxy: {
      // proxy /rpc -> https://rpc.testnet.carv.io/
      '/rpc': {
        target: 'https://rpc.testnet.carv.io',
        changeOrigin: true,
        secure: true,
        // remove the leading /rpc so /rpc → /
        rewrite: (p) => p.replace(/^\/rpc/, ''),
      },
    },
  },
})
