import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  root: 'web',
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true },
  server: {
    port: 5173,
    // shared/ sits outside the Vite root, so it has to be allowed explicitly.
    fs: { allow: ['..'] },
    proxy: { '/api': 'http://127.0.0.1:8765' },
  },
})
