import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const daemon = `http://127.0.0.1:${process.env.NUONUO_PORT || 7420}`

export default defineConfig({
  base: './',
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/v1': { target: daemon, changeOrigin: false },
      '/plugin': { target: daemon, changeOrigin: false },
      '/plugin-window': { target: daemon, changeOrigin: false },
    },
  },
  build: { outDir: 'dist', emptyOutDir: true, chunkSizeWarningLimit: 1500 },
})
