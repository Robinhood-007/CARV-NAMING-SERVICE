import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
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
