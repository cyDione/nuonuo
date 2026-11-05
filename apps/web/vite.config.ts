import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const daemon = `http://127.0.0.1:${process.env.SUPER_ASSISTANT_PORT || 7420}`

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    strictPort: true,
    // Keep the browser's Host (localhost:5173) so the daemon's host guard sees an allowed dev origin.
    proxy: { '/api': { target: daemon, changeOrigin: false }, '/auth': { target: daemon, changeOrigin: false }, '/plugin': { target: daemon, changeOrigin: false } },
  },
  build: { outDir: 'dist', emptyOutDir: true, chunkSizeWarningLimit: 1500 },
})
