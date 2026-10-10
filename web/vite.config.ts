import path from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// Dev: /api is proxied to the Sparrow server (default 127.0.0.1:4040).
// Point at the mock with `VITE_API=http://127.0.0.1:4140 bun run dev` (or `bun run dev:mock`).
const target = process.env.VITE_API ?? 'http://127.0.0.1:4040'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, './src'),
      '@shared': path.resolve(import.meta.dirname, '../src/shared'),
    },
  },
  server: {
    port: 5173,
    proxy: { '/api': { target, changeOrigin: true } },
  },
  build: { outDir: 'dist', emptyOutDir: true, chunkSizeWarningLimit: 1500 },
})
