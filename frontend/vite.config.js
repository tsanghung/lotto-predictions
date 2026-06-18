import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { resolve } from 'path'
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from 'fs'

function copyDataFiles() {
  return {
    name: 'copy-data-files',
    closeBundle() {
      const dataDir = resolve(__dirname, '../data')
      const outDir = resolve(__dirname, 'dist')
      const outDataDir = resolve(outDir, 'data')

      if (!existsSync(dataDir)) {
        throw new Error(`Missing data directory: ${dataDir}`)
      }

      rmSync(outDataDir, { recursive: true, force: true })
      mkdirSync(outDataDir, { recursive: true })

      for (const entry of readdirSync(dataDir, { withFileTypes: true })) {
        if (!entry.isFile()) {
          continue
        }

        const source = resolve(dataDir, entry.name)
        if (entry.name.endsWith('.json')) {
          copyFileSync(source, resolve(outDataDir, entry.name))
        }

        if (entry.name === 'ads.txt') {
          copyFileSync(source, resolve(outDir, entry.name))
        }
      }
    }
  }
}

// https://vitejs.dev/config/
export default defineConfig({
  base: process.env.VITE_BASE_PATH || '/lotto-predictions/',
  plugins: [vue(), copyDataFiles()],
  // Keep frontend/public for normal static assets.
  // The copyDataFiles plugin writes repo-level data files to dist/data at build time.
  publicDir: resolve(__dirname, 'public'),
  server: {
    port: 5173,
    proxy: {
      // 在開發環境中，將 /data/... 請求對應到 publicDir (../data) 的根目錄
      // 這樣開發環境的 fetch('/data/meta.json') 就會等同於存取 ../data/meta.json
      '/data': {
        target: 'http://localhost:5173',
        rewrite: (path) => path.replace(/^\/data/, '')
      }
    }
  }
})
