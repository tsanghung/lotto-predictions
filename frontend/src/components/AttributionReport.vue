<script setup>
import { computed, ref } from 'vue'

const props = defineProps({
  prediction: {
    type: Object,
    default: null
  }
})

const isExpanded = ref(false)

const evaluation = computed(() => {
  if (!props.prediction || !props.prediction.is_evaluated) return null
  return props.prediction.evaluation
})

const hasReport = computed(() => {
  return evaluation.value && evaluation.value.attribution_report
})

const isGoodPerformance = computed(() => {
  if (!hasReport.value) return false
  return evaluation.value.attribution_report.includes('表現優良') || 
         evaluation.value.attribution_report.includes('無需特殊歸因')
})
</script>

<template>
  <div v-if="evaluation" class="mt-6 border-t border-white/10 pt-6">
    <div class="flex items-center justify-between mb-4 cursor-pointer group" @click="isExpanded = !isExpanded">
      <div class="flex items-center gap-2">
        <span class="text-xl">🔬</span>
        <h3 class="text-md font-bold text-slate-200 group-hover:text-white transition-colors">
          科學歸因分析報告
        </h3>
        <span v-if="isGoodPerformance" class="ml-2 text-xs bg-emerald-500/20 text-emerald-400 px-2 py-0.5 rounded-full ring-1 ring-emerald-500/50">
          優良
        </span>
        <span v-else class="ml-2 text-xs bg-amber-500/20 text-amber-400 px-2 py-0.5 rounded-full ring-1 ring-amber-500/50">
          已歸因
        </span>
      </div>
      <button class="text-slate-400 hover:text-white transition-colors">
        <svg class="w-5 h-5 transform transition-transform duration-300" :class="isExpanded ? 'rotate-180' : ''" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"></path></svg>
      </button>
    </div>

    <!-- 摺疊內容區塊 -->
    <div v-show="isExpanded" class="space-y-4 animate-in fade-in slide-in-from-top-2 duration-300">
      
      <!-- 對獎結果摘要 -->
      <div class="flex flex-wrap gap-3">
        <div class="bg-slate-900/50 rounded-lg px-3 py-2 ring-1 ring-white/5 flex items-center gap-2">
          <span class="text-xs text-slate-500">實際開出:</span>
          <div class="flex gap-1">
            <span v-for="n in evaluation.actual_numbers" :key="n" class="text-sm font-mono text-white">
              {{ n.toString().padStart(2, '0') }}
            </span>
          </div>
        </div>
      </div>

      <!-- AI 報告內文 -->
      <div class="relative overflow-hidden rounded-xl bg-slate-900/80 p-5 ring-1 ring-white/10 shadow-inner">
        <!-- 裝飾用光暈 -->
        <div class="absolute -top-10 -right-10 w-32 h-32 bg-blue-500/10 blur-[40px] rounded-full pointer-events-none"></div>
        
        <div class="relative z-10 flex gap-3">
          <div class="flex-shrink-0 mt-1">
            <div class="w-8 h-8 rounded-full bg-slate-800 flex items-center justify-center ring-1 ring-white/10 shadow-lg">
              🤖
            </div>
          </div>
          <div>
            <h4 class="text-sm font-semibold text-blue-400 mb-1">系統診斷</h4>
            <p class="text-sm text-slate-300 leading-relaxed font-light tracking-wide whitespace-pre-wrap">
              {{ evaluation.attribution_report }}
            </p>
          </div>
        </div>
      </div>
      
    </div>
  </div>
</template>
