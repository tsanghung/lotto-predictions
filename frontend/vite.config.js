import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { resolve } from 'path'

// https://vitejs.dev/config/
export default defineConfig({
  base: '/lotto-predictions/',
  plugins: [vue()],
  // [Bug #7 修復] 將專案根目錄設為靜態資源目錄
  // Vite 會同時服務 frontend/public/ 與此 publicDir 下的靜態檔案
  // 這樣 /data/meta.json、/data/predictions.json 等請求在開發環境即可正常存取
  publicDir: resolve(__dirname, '../data'),
  server: {
    port: 5173,
    // 開發時提示：data 資料夾已透過 publicDir 掛載
    // 如需同時服務 frontend/public/，請將靜態資產放置於 frontend/public/ 下
  }
})
