<script setup>
import { computed } from 'vue'

import HeatmapChart from './HeatmapChart.vue'
import DistributionChart from './DistributionChart.vue'
import AttributionReport from './AttributionReport.vue'

const props = defineProps({
  gameName: {
    type: String,
    required: true
  },
  predictionData: {
    type: Object,
    default: null
  },
  historyData: {
    type: Array,
    default: () => []
  }
})

// 從 predictionData 中提取最新預測
const latestPrediction = computed(() => {
  if (!props.predictionData || props.predictionData.length === 0) return null
  // 找出符合 gameName 的最後一筆
  const filtered = props.predictionData.filter(p => p.game_name === props.gameName)
  if (filtered.length === 0) return null
  return filtered[filtered.length - 1]
})

const getCombinationColor = (strategy) => {
  if (strategy.includes('激進')) return 'text-rose-400 bg-rose-400/10 ring-rose-400/50'
  if (strategy.includes('穩健')) return 'text-emerald-400 bg-emerald-400/10 ring-emerald-400/50'
  return 'text-amber-400 bg-amber-400/10 ring-amber-400/50'
}
</script>

<template>
  <div class="relative group h-full">
    <!-- Glow Effect -->
    <div class="absolute -inset-0.5 rounded-2xl blur opacity-25 group-hover:opacity-50 transition duration-1000 group-hover:duration-200"
         :class="gameName === '大樂透' ? 'bg-gradient-to-r from-teal-500 to-blue-500' : 'bg-gradient-to-r from-purple-500 to-pink-500'">
    </div>
    
    <!-- Glassmorphism Card -->
    <div class="relative bg-slate-800/80 backdrop-blur-xl ring-1 ring-white/10 rounded-2xl p-6 h-full shadow-2xl flex flex-col justify-between">
      <div>
        <h2 class="text-2xl font-bold text-white mb-2 flex items-center justify-between">
          <span class="flex items-center">
            <span class="mr-2">{{ gameName === '大樂透' ? '🎯' : '⚡' }}</span> {{ gameName }}
          </span>
          <span v-if="latestPrediction" class="text-xs font-normal text-slate-400 bg-slate-900/50 px-2 py-1 rounded-full ring-1 ring-white/5">
            {{ new Date(latestPrediction.timestamp).toLocaleDateString() }}
          </span>
        </h2>
        
        <template v-if="latestPrediction">
          <div class="mb-6 space-y-4">
            <!-- 洞察與推理 -->
            <div class="bg-slate-900/50 rounded-xl p-4 ring-1 ring-white/5">
              <h3 class="text-sm font-semibold text-slate-300 mb-1 flex items-center">
                <span class="mr-1">📊</span> AI 洞察
              </h3>
              <p class="text-slate-400 text-sm leading-relaxed">
                {{ latestPrediction.prediction.reasoning }}
              </p>
            </div>
            
            <!-- 推薦組合 -->
            <div class="space-y-3">
              <h3 class="text-sm font-semibold text-slate-300 flex items-center">
                <span class="mr-1">💡</span> 推薦組合
              </h3>
              <div v-for="(nums, strategy) in latestPrediction.prediction.combinations" :key="strategy" 
                   class="flex flex-col sm:flex-row sm:items-center justify-between p-3 rounded-xl ring-1"
                   :class="getCombinationColor(strategy)">
                <span class="text-sm font-bold mb-2 sm:mb-0">{{ strategy }}</span>
                <div class="flex gap-2 flex-wrap">
                  <span v-for="n in nums" :key="n" 
                        class="w-8 h-8 flex items-center justify-center rounded-full bg-slate-900/50 text-white font-mono text-sm shadow-inner ring-1 ring-white/10">
                    {{ n.toString().padStart(2, '0') }}
                  </span>
                </div>
              </div>
            </div>
            
            <!-- 風險提示 -->
            <div v-if="latestPrediction.prediction.risk_warning" class="mt-4 flex items-start gap-2 text-xs text-slate-500 italic">
              <span>⚠️</span>
              <p>{{ latestPrediction.prediction.risk_warning }}</p>
            </div>
            
            <!-- 科學歸因報告 -->
            <AttributionReport :prediction="latestPrediction" />
          </div>
        </template>
        
        <template v-else>
          <div class="py-10 text-center flex flex-col items-center justify-center h-full">
            <div class="animate-pulse flex space-x-4 mb-4">
              <div class="rounded-full bg-slate-700 h-10 w-10"></div>
              <div class="flex-1 space-y-6 py-1">
                <div class="h-2 bg-slate-700 rounded"></div>
                <div class="space-y-3">
                  <div class="grid grid-cols-3 gap-4">
                    <div class="h-2 bg-slate-700 rounded col-span-2"></div>
                    <div class="h-2 bg-slate-700 rounded col-span-1"></div>
                  </div>
                  <div class="h-2 bg-slate-700 rounded"></div>
                </div>
              </div>
            </div>
            <p class="text-slate-500">尚無預測資料，或正在載入中...</p>
          </div>
        </template>
        
        <!-- 歷史統計圖表區塊 -->
        <div v-if="historyData && historyData.length > 0" class="mt-8 border-t border-white/5 pt-6">
          <DistributionChart :game-name="gameName" :history-data="historyData" />
          <HeatmapChart :game-name="gameName" :history-data="historyData" />
        </div>
      </div>
    </div>
  </div>
</template>
