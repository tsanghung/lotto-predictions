import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { resolve } from 'path'

// https://vitejs.dev/config/
export default defineConfig({
  base: './',
  plugins: [vue()],
  server: {
    proxy: {
      // 在開發環境中，將 /data 請求代理到根目錄的 data 資料夾
      '/data': {
        target: 'http://localhost:5173',
        bypass: (req, res, options) => {
          if (req.url.startsWith('/data/')) {
            // 這個寫法較為進階，最簡單的做法是在 build 時或 dev 前
            // 把 root 的 data 複製到 frontend/public/data，
            // 或直接在 Vite 開發環境下指向相對路徑
          }
        }
      }
    }
  }
})
