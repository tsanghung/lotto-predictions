<script setup>
import { computed } from 'vue'
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  BarElement,
  Title,
  Tooltip,
  Legend
} from 'chart.js'
import { Line, Bar } from 'vue-chartjs'

ChartJS.register(
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  BarElement,
  Title,
  Tooltip,
  Legend
)

const props = defineProps({
  gameName: {
    type: String,
    required: true
  },
  performanceData: {
    type: Object,
    default: null
  }
})

// 從 performanceData 提取當前遊戲的數據
const gamePerf = computed(() => {
  if (!props.performanceData || !props.performanceData.games) return null
  return props.performanceData.games[props.gameName]
})

// 共用的 Chart.js 設定
const commonOptions = {
  responsive: true,
  maintainAspectRatio: false,
  plugins: {
    legend: {
      labels: {
        color: '#94a3b8',
        font: { family: "'Inter', sans-serif" }
      }
    },
    tooltip: {
      backgroundColor: 'rgba(15, 23, 42, 0.9)',
      titleColor: '#f1f5f9',
      bodyColor: '#cbd5e1',
      borderColor: 'rgba(255, 255, 255, 0.1)',
      borderWidth: 1,
      padding: 10
    }
  },
  scales: {
    x: {
      ticks: { color: '#64748b' },
      grid: { color: 'rgba(255, 255, 255, 0.05)' }
    },
    y: {
      ticks: { color: '#64748b', stepSize: 1 },
      grid: { color: 'rgba(255, 255, 255, 0.05)' },
      beginAtZero: true
    }
  }
}

// 趨勢折線圖資料 (各期命中數)
const trendChartData = computed(() => {
  if (!gamePerf.value || !gamePerf.value.trend) return { labels: [], datasets: [] }
  
  const trend = gamePerf.value.trend
  const labels = trend.map(t => t.date)
  
  // 動態取得所有策略
  const strategies = Object.keys(gamePerf.value.strategies || {})
  const colors = ['#2dd4bf', '#d946ef', '#3b82f6', '#f59e0b']
  
  const datasets = strategies.map((strategy, index) => {
    return {
      label: strategy,
      data: trend.map(t => t.strategies[strategy] || 0),
      borderColor: colors[index % colors.length],
      backgroundColor: colors[index % colors.length] + '80', // 加透明度
      tension: 0.3,
      borderWidth: 2,
      pointBackgroundColor: '#0f172a',
      pointBorderColor: colors[index % colors.length],
      pointBorderWidth: 2,
      pointRadius: 4,
      pointHoverRadius: 6
    }
  })
  
  return { labels, datasets }
})

// 中獎/未中獎長條圖資料
const hitMissChartData = computed(() => {
  if (!gamePerf.value || !gamePerf.value.strategies) return { labels: [], datasets: [] }
  
  const strategies = Object.keys(gamePerf.value.strategies)
  const hitData = strategies.map(s => gamePerf.value.strategies[s].total_hits)
  const missData = strategies.map(s => gamePerf.value.strategies[s].total_misses)
  
  return {
    labels: strategies,
    datasets: [
      {
        label: '總命中數',
        data: hitData,
        backgroundColor: '#10b981', // emerald-500
        borderRadius: 4
      },
      {
        label: '總未命中數',
        data: missData,
        backgroundColor: '#f43f5e', // rose-500
        borderRadius: 4
      }
    ]
  }
})

</script>

<template>
  <div v-if="gamePerf" class="mt-8 space-y-6">
    <div class="flex items-center gap-2 mb-2">
      <span class="text-xl">📊</span>
      <h3 class="text-lg font-bold text-slate-200">成效分析看板</h3>
      <span class="text-xs text-slate-500 bg-slate-800 px-2 py-1 rounded-full">
        累積評估: {{ gamePerf.total_draws_evaluated }} 期
      </span>
    </div>
    
    <div class="grid grid-cols-1 lg:grid-cols-2 gap-6">
      
      <!-- 長條圖: 命中與未命中對比 -->
      <div class="bg-slate-900/60 rounded-2xl p-5 ring-1 ring-white/10 backdrop-blur-md">
        <h4 class="text-sm font-semibold text-slate-400 mb-4 text-center">策略總命中與未命中數對比</h4>
        <div class="h-64 w-full">
          <Bar :data="hitMissChartData" :options="commonOptions" />
        </div>
      </div>
      
      <!-- 折線圖: 趨勢變化 -->
      <div class="bg-slate-900/60 rounded-2xl p-5 ring-1 ring-white/10 backdrop-blur-md">
        <h4 class="text-sm font-semibold text-slate-400 mb-4 text-center">各期命中數走勢</h4>
        <div class="h-64 w-full">
          <Line :data="trendChartData" :options="commonOptions" />
        </div>
      </div>
      
    </div>
    
    <!-- 勝率總覽小卡 -->
    <div class="grid grid-cols-2 md:grid-cols-4 gap-4">
      <div v-for="(stats, strategy) in gamePerf.strategies" :key="strategy" 
           class="bg-slate-800/40 rounded-xl p-4 ring-1 ring-white/5 text-center flex flex-col justify-center transition-all hover:bg-slate-800/60">
        <span class="text-slate-400 text-xs mb-1">{{ strategy }} 勝率</span>
        <span class="text-2xl font-bold font-mono" 
              :class="stats.win_rate > 0.15 ? 'text-emerald-400' : 'text-amber-400'">
          {{ (stats.win_rate * 100).toFixed(1) }}%
        </span>
      </div>
    </div>
  </div>
</template>
