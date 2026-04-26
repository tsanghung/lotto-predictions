<script setup>
import { computed } from 'vue'

const props = defineProps({
  gameName: {
    type: String,
    required: true
  },
  historyData: {
    type: Array,
    required: true
  }
})

// 計算號碼出現頻率
const frequencies = computed(() => {
  const maxNum = props.gameName === '大樂透' ? 49 : 39
  const freqs = Array.from({ length: maxNum }, (_, i) => ({ number: i + 1, count: 0 }))
  
  if (!props.historyData || props.historyData.length === 0) return freqs

  // 只取最近 100 期計算熱力
  const recentData = props.historyData.slice(-100)
  
  recentData.forEach(draw => {
    draw.numbers.forEach(n => {
      if (n > 0 && n <= maxNum) {
        freqs[n - 1].count += 1
      }
    })
  })

  return freqs
})

const maxFrequency = computed(() => {
  if (frequencies.value.length === 0) return 1
  return Math.max(...frequencies.value.map(f => f.count))
})

// 根據頻率決定背景顏色亮度
const getHeatmapColor = (count) => {
  const ratio = count / (maxFrequency.value || 1)
  
  if (ratio === 0) return 'bg-slate-800 text-slate-500' // 未出現
  if (ratio < 0.25) return props.gameName === '大樂透' ? 'bg-teal-900/40 text-teal-300/60' : 'bg-purple-900/40 text-purple-300/60'
  if (ratio < 0.5) return props.gameName === '大樂透' ? 'bg-teal-700/60 text-teal-200' : 'bg-purple-700/60 text-purple-200'
  if (ratio < 0.75) return props.gameName === '大樂透' ? 'bg-teal-500 text-white' : 'bg-purple-500 text-white'
  
  // 最熱門
  return props.gameName === '大樂透' ? 'bg-teal-400 text-slate-900 font-bold shadow-[0_0_10px_rgba(45,212,191,0.6)]' : 'bg-pink-400 text-slate-900 font-bold shadow-[0_0_10px_rgba(244,114,182,0.6)]'
}
</script>

<template>
  <div class="mt-6 pt-6 border-t border-white/10">
    <h3 class="text-sm font-semibold text-slate-300 mb-4 flex items-center">
      <span class="mr-2">🔥</span> 近 100 期熱力圖
    </h3>
    
    <div class="grid grid-cols-7 sm:grid-cols-10 gap-1.5 sm:gap-2">
      <div v-for="item in frequencies" :key="item.number"
           class="relative flex items-center justify-center aspect-square rounded-md sm:rounded-lg text-xs sm:text-sm transition-all duration-300 hover:scale-110 cursor-pointer group"
           :class="getHeatmapColor(item.count)">
        {{ item.number }}
        
        <!-- Tooltip -->
        <div class="absolute bottom-full mb-2 left-1/2 -translate-x-1/2 px-2 py-1 bg-slate-900 text-slate-200 text-xs rounded opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap pointer-events-none z-10 shadow-xl ring-1 ring-white/20">
          出 {{ item.count }} 次
        </div>
      </div>
    </div>
  </div>
</template>
