<script setup>
import { onMounted } from 'vue'
import { useLottoData } from './composables/useLottoData'
import PredictionCard from './components/PredictionCard.vue'
import PerformanceChart from './components/PerformanceChart.vue'

const { meta, predictions, history, performance, loading, error, fetchData } = useLottoData()

onMounted(() => {
  fetchData()
})
</script>

<template>
  <div class="min-h-screen bg-slate-900 flex flex-col items-center py-10 px-4 selection:bg-teal-500/30">
    <!-- Header -->
    <header class="w-full max-w-5xl text-center mb-12 relative z-10">
      <div class="inline-flex items-center justify-center space-x-2 mb-4">
        <div class="w-3 h-3 rounded-full bg-teal-400 animate-pulse"></div>
        <h1 class="text-4xl md:text-6xl font-extrabold text-transparent bg-clip-text bg-gradient-to-r from-teal-400 via-blue-500 to-purple-500 tracking-tight drop-shadow-lg">
          Lotto predictions
        </h1>
      </div>
      <p class="text-slate-400 text-lg md:text-xl font-medium max-w-2xl mx-auto">
        全自動伺服器無感架構，結合統計機率與 Gemini AI 深度推理的終極開獎預測面板。
      </p>
      
      <!-- System Status / Meta -->
      <div class="mt-6 flex flex-wrap justify-center gap-4 text-sm">
        <div class="bg-slate-800/50 backdrop-blur-sm rounded-full px-4 py-1.5 ring-1 ring-white/10 flex items-center">
          <span class="text-slate-400 mr-2">系統狀態:</span>
          <span v-if="loading" class="text-amber-400 flex items-center">
            <svg class="animate-spin -ml-1 mr-2 h-4 w-4 text-amber-400" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg>
            資料同步中...
          </span>
          <span v-else-if="error" class="text-rose-400">連線失敗 ({{ error }})</span>
          <span v-else class="text-emerald-400 flex items-center">
            <span class="w-2 h-2 rounded-full bg-emerald-400 mr-2 shadow-[0_0_8px_rgba(52,211,153,0.8)]"></span>
            在線且最新
          </span>
        </div>
        
        <div v-if="meta && !loading" class="bg-slate-800/50 backdrop-blur-sm rounded-full px-4 py-1.5 ring-1 ring-white/10 flex items-center text-slate-300">
          最後更新: {{ new Date(meta.last_updated).toLocaleString() }}
        </div>
      </div>
    </header>

    <!-- Main Content Area -->
    <main class="w-full max-w-5xl relative z-10">
      
      <!-- Error State -->
      <div v-if="error" class="bg-rose-500/10 border border-rose-500/50 rounded-xl p-6 text-center mb-8 backdrop-blur-sm">
        <p class="text-rose-400 mb-4">無法載入預測資料，這可能是因為您在本地開發環境尚未建立 Proxy 或複製 data 資料夾。</p>
        <button @click="fetchData" class="px-6 py-2 bg-rose-500/20 text-rose-300 rounded-lg hover:bg-rose-500/30 transition-colors">
          重新試一次
        </button>
      </div>

      <div class="grid grid-cols-1 xl:grid-cols-2 gap-8">
        <!-- 大樂透 Card -->
        <PredictionCard 
          game-name="大樂透" 
          :prediction-data="predictions"
          :history-data="history['大樂透']"
        />
        
        <!-- 今彩 539 Card -->
        <PredictionCard 
          game-name="今彩539" 
          :prediction-data="predictions"
          :history-data="history['今彩539']"
        />
      </div>
      
      <!-- 總體成效看板 (Performance Dashboard) -->
      <div v-if="performance && Object.keys(performance.games).length > 0" class="mt-16 border-t border-white/10 pt-8">
        <div class="text-center mb-8">
          <h2 class="text-3xl font-bold text-transparent bg-clip-text bg-gradient-to-r from-amber-400 to-orange-500 inline-block drop-shadow-md">
            總體成效與歸因中心
          </h2>
          <p class="text-slate-400 mt-2">完全透明的歷史對獎紀錄與策略勝率追蹤</p>
        </div>
        
        <div class="space-y-12">
          <!-- 大樂透成效 -->
          <PerformanceChart 
            game-name="大樂透" 
            :performance-data="performance" 
          />
          
          <!-- 今彩539成效 -->
          <PerformanceChart 
            game-name="今彩539" 
            :performance-data="performance" 
          />
        </div>
      </div>
      
    </main>
    
    <!-- Background Decoration -->
    <div class="fixed inset-0 overflow-hidden pointer-events-none z-0">
      <div class="absolute -top-[20%] -left-[10%] w-[50%] h-[50%] rounded-full bg-teal-500/10 blur-[120px]"></div>
      <div class="absolute top-[60%] -right-[10%] w-[50%] h-[50%] rounded-full bg-purple-500/10 blur-[120px]"></div>
    </div>
  </div>
</template>

<style>
/* 可以在這裡加入額外的全域樣式微調 */
</style>
