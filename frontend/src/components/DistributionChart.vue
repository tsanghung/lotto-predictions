<script setup>
import { computed } from 'vue'
import { Chart as ChartJS, ArcElement, Tooltip, Legend } from 'chart.js'
import { Doughnut } from 'vue-chartjs'

ChartJS.register(ArcElement, Tooltip, Legend)

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

// 計算全歷史的奇偶、大小比例
const distribution = computed(() => {
  let odd = 0
  let even = 0
  let large = 0
  let small = 0

  if (!props.historyData || props.historyData.length === 0) return { odd, even, large, small }

  const midPoint = props.gameName === '大樂透' ? 24.5 : props.gameName === '威力彩' ? 19 : 19.5

  props.historyData.forEach(draw => {
    draw.numbers.forEach(n => {
      if (n % 2 !== 0) odd++
      else even++
      
      if (n > midPoint) large++
      else small++
    })
  })
  
  return { odd, even, large, small }
})

const chartOptions = {
  responsive: true,
  maintainAspectRatio: false,
  plugins: {
    legend: {
      position: 'bottom',
      labels: {
        color: '#94a3b8',
        usePointStyle: true,
        padding: 36,
        font: {
          family: "'Inter', sans-serif",
          size: 22
        }
      }
    },
    tooltip: {
      backgroundColor: 'rgba(15, 23, 42, 0.9)', // bg-slate-900
      titleColor: '#f1f5f9',
      bodyColor: '#cbd5e1',
      borderColor: 'rgba(255, 255, 255, 0.1)',
      borderWidth: 1,
      padding: 10,
      boxPadding: 4
    }
  },
  cutout: '70%',
  borderWidth: 0
}

const oddEvenData = computed(() => ({
  labels: ['奇數', '偶數'],
  datasets: [{
    data: [distribution.value.odd, distribution.value.even],
    backgroundColor: [
      props.gameName === '大樂透' ? '#2dd4bf' : props.gameName === '威力彩' ? '#f59e0b' : '#d946ef',
      '#334155' // slate-700
    ],
    hoverBackgroundColor: [
      props.gameName === '大樂透' ? '#14b8a6' : props.gameName === '威力彩' ? '#d97706' : '#c026d3',
      '#475569' // slate-600
    ]
  }]
}))

const largeSmallData = computed(() => ({
  labels: ['大號碼', '小號碼'],
  datasets: [{
    data: [distribution.value.large, distribution.value.small],
    backgroundColor: [
      props.gameName === '大樂透' ? '#3b82f6' : props.gameName === '威力彩' ? '#e11d48' : '#ec4899',
      '#334155'
    ],
    hoverBackgroundColor: [
      props.gameName === '大樂透' ? '#2563eb' : props.gameName === '威力彩' ? '#be123c' : '#db2777',
      '#475569'
    ]
  }]
}))
</script>

<template>
  <div class="rounded-2xl border border-white/[0.07] bg-white/[0.03] p-10 flex flex-col gap-12">
    <div class="bg-slate-900/40 rounded-xl p-10 ring-1 ring-white/5">
      <h4 class="text-2xl font-semibold text-slate-400 text-center mb-8">歷史奇偶分佈</h4>
      <div class="relative h-[560px] w-full">
        <Doughnut :data="oddEvenData" :options="chartOptions" />
        <div class="absolute inset-0 flex flex-col items-center justify-center pointer-events-none pb-20">
          <span class="text-xl text-slate-500">奇 / 偶</span>
          <span class="text-5xl font-bold text-slate-300">{{ Math.round(distribution.odd / (distribution.odd + distribution.even) * 100) }}% / {{ Math.round(distribution.even / (distribution.odd + distribution.even) * 100) }}%</span>
        </div>
      </div>
    </div>

    <div class="bg-slate-900/40 rounded-xl p-10 ring-1 ring-white/5">
      <h4 class="text-2xl font-semibold text-slate-400 text-center mb-8">歷史大小分佈</h4>
      <div class="relative h-[560px] w-full">
        <Doughnut :data="largeSmallData" :options="chartOptions" />
        <div class="absolute inset-0 flex flex-col items-center justify-center pointer-events-none pb-20">
          <span class="text-xl text-slate-500">大 / 小</span>
          <span class="text-5xl font-bold text-slate-300">{{ Math.round(distribution.large / (distribution.large + distribution.small) * 100) }}% / {{ Math.round(distribution.small / (distribution.large + distribution.small) * 100) }}%</span>
        </div>
      </div>
    </div>
  </div>
</template>
