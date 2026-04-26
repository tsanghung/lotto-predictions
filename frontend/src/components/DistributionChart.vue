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

// 計算最近 50 期的奇偶、大小比例
const distribution = computed(() => {
  let odd = 0
  let even = 0
  let large = 0
  let small = 0
  
  if (!props.historyData || props.historyData.length === 0) return { odd, even, large, small }
  
  const recentData = props.historyData.slice(-50)
  const midPoint = props.gameName === '大樂透' ? 24.5 : 19.5
  
  recentData.forEach(draw => {
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
        color: '#94a3b8', // text-slate-400
        usePointStyle: true,
        padding: 20,
        font: {
          family: "'Inter', sans-serif",
          size: 12
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
      props.gameName === '大樂透' ? '#2dd4bf' : '#d946ef', // teal-400 : fuchsia-500
      '#334155' // slate-700
    ],
    hoverBackgroundColor: [
      props.gameName === '大樂透' ? '#14b8a6' : '#c026d3', // teal-500 : fuchsia-600
      '#475569' // slate-600
    ]
  }]
}))

const largeSmallData = computed(() => ({
  labels: ['大號碼', '小號碼'],
  datasets: [{
    data: [distribution.value.large, distribution.value.small],
    backgroundColor: [
      props.gameName === '大樂透' ? '#3b82f6' : '#ec4899', // blue-500 : pink-500
      '#334155'
    ],
    hoverBackgroundColor: [
      props.gameName === '大樂透' ? '#2563eb' : '#db2777', // blue-600 : pink-600
      '#475569'
    ]
  }]
}))
</script>

<template>
  <div class="mt-8 grid grid-cols-2 gap-4">
    <div class="bg-slate-900/40 rounded-xl p-4 ring-1 ring-white/5">
      <h4 class="text-xs font-semibold text-slate-400 text-center mb-4">近 50 期奇偶分佈</h4>
      <div class="relative h-32 w-full">
        <Doughnut :data="oddEvenData" :options="chartOptions" />
        <div class="absolute inset-0 flex flex-col items-center justify-center pointer-events-none pb-5">
          <span class="text-xs text-slate-500">奇偶比</span>
          <span class="text-sm font-bold text-slate-300">{{ distribution.odd }}:{{ distribution.even }}</span>
        </div>
      </div>
    </div>
    
    <div class="bg-slate-900/40 rounded-xl p-4 ring-1 ring-white/5">
      <h4 class="text-xs font-semibold text-slate-400 text-center mb-4">近 50 期大小分佈</h4>
      <div class="relative h-32 w-full">
        <Doughnut :data="largeSmallData" :options="chartOptions" />
        <div class="absolute inset-0 flex flex-col items-center justify-center pointer-events-none pb-5">
          <span class="text-xs text-slate-500">大小比</span>
          <span class="text-sm font-bold text-slate-300">{{ distribution.large }}:{{ distribution.small }}</span>
        </div>
      </div>
    </div>
  </div>
</template>
