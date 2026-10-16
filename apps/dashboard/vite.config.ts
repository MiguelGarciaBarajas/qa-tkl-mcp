import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/v1': {
        target: process.env.TKL_API_PROXY_TARGET ?? 'http://127.0.0.1:3000',
        changeOrigin: false,
      },
      '/health': {
        target: process.env.TKL_API_PROXY_TARGET ?? 'http://127.0.0.1:3000',
        changeOrigin: false,
      },
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/setupTests.ts'],
    globals: true,
  },
})
