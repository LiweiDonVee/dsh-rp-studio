import react from '@vitejs/plugin-react'
import { readFileSync } from 'node:fs'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react(), {
    name: 'distribution-notices',
    generateBundle() {
      for (const name of ['LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES.md']) {
        this.emitFile({ type: 'asset', fileName: name, source: readFileSync(new URL(`../../${name}`, import.meta.url), 'utf8') })
      }
    },
  }],
  server: {
    proxy: {
      '/api': 'http://127.0.0.1:4317',
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test-setup.ts'],
  },
})
