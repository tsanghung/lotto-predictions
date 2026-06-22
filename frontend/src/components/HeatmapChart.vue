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

const maxNum = computed(() => {
  if (props.gameName === '大樂透') return 49
  if (props.gameName === '威力彩') return 38
  return 39
})
// 大樂透與威力彩近 100 期、今彩539 近 300 期
const periods = computed(() => (props.gameName === '今彩539' ? 300 : 100))

// 計算近 N 期各號碼出現頻率
const frequencies = computed(() => {
  const m = maxNum.value
  const freqs = Array.from({ length: m }, (_, i) => ({ number: i + 1, count: 0 }))
  if (!props.historyData || props.historyData.length === 0) return freqs

  const recentData = props.historyData.slice(-periods.value)
  recentData.forEach(draw => {
    draw.numbers.forEach(n => {
      if (n > 0 && n <= m) freqs[n - 1].count += 1
    })
  })
  return freqs
})

const counts = computed(() => frequencies.value.map(f => f.count))
const maxFreq = computed(() => Math.max(...counts.value, 1))
const minFreq = computed(() => Math.min(...counts.value, 0))

// 主題色階（由冷到熱，刻意拉大明度對比，確保肉眼可辨）
const palette = computed(() => {
  if (props.gameName === '大樂透') {
    return ['#0c1f22', '#0f3f3b', '#0d9488', '#2dd4bf', '#5eead4', '#a7f3e4']
  }
  if (props.gameName === '威力彩') {
    return ['#21130b', '#5b2a12', '#b45309', '#f59e0b', '#fbbf24', '#fde68a']
  }
  return ['#1c1233', '#4c1d95', '#a21caf', '#d946ef', '#e879f9', '#f7c8fd']
})

// min-max 正規化：把實際出現範圍（最冷~最熱）攤平到 0~1，避免顏色擠在同一段
const bandIndex = (count) => {
  const spread = (maxFreq.value - minFreq.value) || 1
  const r = (count - minFreq.value) / spread
  return r >= 0.999 ? 5 : Math.floor(r * 6) // 0~5 共 6 段
}

const cellStyle = (count) => {
  const idx = bandIndex(count)
  const pal = palette.value
  return {
    background: pal[idx],
    color: idx >= 4 ? '#0f172a' : '#e2e8f0',          // 亮色用深字、暗色用淺字
    fontWeight: idx >= 4 ? 800 : 600,
    boxShadow: idx === 5 ? `0 0 12px ${pal[5]}aa` : 'none'
  }
}
</script>

<template>
  <div class="rounded-2xl border border-white/[0.07] bg-white/[0.03] p-6">
    <div class="flex items-center justify-between flex-wrap gap-2 mb-5">
      <h3 class="text-base font-semibold text-slate-200 flex items-center">
        <span class="mr-2">🔥</span> 近 {{ periods }} 期熱力圖
      </h3>
      <!-- 冷熱色階圖例 -->
      <div class="flex items-center gap-1.5 text-xs text-slate-500">
        <span>冷</span>
        <span v-for="(c, i) in palette" :key="i"
              :style="{ width: '15px', height: '15px', borderRadius: '3px', background: c, display: 'inline-block' }"></span>
        <span>熱</span>
      </div>
    </div>

    <div class="grid gap-1.5 sm:gap-2"
         :style="{ gridTemplateColumns: `repeat(${maxNum <= 39 ? 8 : 10}, minmax(0, 1fr))` }">
      <div v-for="item in frequencies" :key="item.number"
           :title="`號碼 ${item.number}：近 ${periods} 期開出 ${item.count} 次`"
           :style="{
             ...cellStyle(item.count),
             aspectRatio: '1', borderRadius: '10px',
             display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
             transition: 'transform 0.15s', cursor: 'default'
           }"
           @mouseenter="e => e.currentTarget.style.transform = 'scale(1.12)'"
           @mouseleave="e => e.currentTarget.style.transform = 'scale(1)'">
        <span style="font-size:30px;font-family:monospace;line-height:1;">{{ item.number }}</span>
        <span :style="{ fontSize: '20px', opacity: 0.75, lineHeight: 1, marginTop: '4px' }">{{ item.count }}</span>
      </div>
    </div>
  </div>
</template>
