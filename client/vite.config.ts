import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react-swc'
import path from 'path'
import { readFileSync } from 'fs'

// The app version lives in the root package.json — the same field electron-builder
// stamps on the installer — so the UI can't drift from the release.
const version = JSON.parse(
  readFileSync(path.resolve(__dirname, '../package.json'), 'utf-8')
).version as string

export default defineConfig({
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(version),
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  // No manualChunks: grouping vendors by package pins shared transitive
  // modules into those groups, which then get pulled into the entry chunk —
  // exactly what we're trying to avoid. Rollup's automatic splitting, driven
  // by the lazy() boundaries around the editor, terminal and markdown views,
  // already keeps them off the boot path.
  server: {
    // No browser tab on start: Vite listens before the backend does, so an auto-opened tab would fire
    // /api into ECONNREFUSED. Open http://localhost:5421 once the backend is up; the UI waits for it
    // (components/BackendGate.tsx), so the tab is safe to open at any time after that.
    open: false,
    proxy: {
      '/api': {
        target: 'http://localhost:5420',
        changeOrigin: true,
      },
      '/ws': {
        target: 'ws://localhost:5420',
        ws: true,
      },
    },
  },
})
