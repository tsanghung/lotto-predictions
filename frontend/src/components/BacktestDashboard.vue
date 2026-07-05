<script setup>
import { computed } from 'vue'
import { predictionHasDetailedInsight } from '../services/predictionVisibility'
import AttributionReport from './AttributionReport.vue'
import PredictionHistoryPanel from './PredictionHistoryPanel.vue'
import AsiLearningPanel from './AsiLearningPanel.vue'
import PerformanceChart from './PerformanceChart.vue'

const props = defineProps({
  gameName: { type: String, required: true },
  predictionData: { type: Array, default: () => [] },
  performanceData: { type: Object, default: null },
  asiLearning: { type: Array, default: () => [] },
})

const gamePerf = computed(() => props.performanceData?.games?.[props.gameName] || null)

const latestPrediction = computed(() =>
  [...props.predictionData].reverse().find((p) => p.game_name === props.gameName) || null
)

const detailedLatest = computed(() => {
  const filtered = (props.predictionData || []).filter((p) => p.game_name === props.gameName)
  const detailed = filtered.filter(predictionHasDetailedInsight)
  return detailed.length ? detailed[detailed.length - 1] : (filtered[filtered.length - 1] || null)
})

const calibration = computed(() => detailedLatest.value?.prediction?.heartbeat?.calibration || null)

// 穩健平衡策略的平均命中 / 期（若快照有該策略）
const balancedAvgHits = computed(() => {
  const s = gamePerf.value?.strategies?.['穩健平衡']
  const draws = gamePerf.value?.total_draws_evaluated
  if (!s || !draws) return null
  return (s.total_hits / draws).toFixed(2)
})

const kpis = computed(() => [
  { label: '已評估期數', value: gamePerf.value?.total_draws_evaluated ?? '—', sub: '逐期對獎累積', color: 'var(--text)' },
  { label: '心跳命中率', value: calibration.value ? `${calibration.value.hit_rate}%` : '—', sub: calibration.value ? `隨機基準 ${calibration.value.base_rate}%` : 'walk-forward', color: 'var(--ok)' },
  { label: '校正 p 值', value: calibration.value ? calibration.value.p_value : '—', sub: calibration.value?.beats_random ? '偏離待查' : '與隨機無異', color: calibration.value?.beats_random ? 'var(--warn)' : 'var(--ok)' },
  { label: '穩健平衡平均命中', value: balancedAvgHits.value ?? '—', sub: '顆 / 期', color: 'var(--text)' },
])
</script>

<template>
  <div style="display:flex;flex-direction:column;gap:24px;">
    <!-- KPI 頭部 -->
    <div class="card card-glow">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:16px;">
        <span style="font-size:1.2rem;">📊</span>
        <h3 style="font-size:1.15rem;font-weight:800;color:var(--text);">回測成效總覽</h3>
        <span style="font-size:0.82rem;color:var(--text-faint);">預測 vs 實際開獎的滾動校正</span>
      </div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:14px;">
        <div v-for="k in kpis" :key="k.label"
          style="background:var(--surface-2);border:1px solid var(--border-soft);border-radius:var(--radius);padding:16px;">
          <p class="eyebrow" style="margin-bottom:8px;">{{ k.label }}</p>
          <p :style="{ fontSize:'1.6rem', fontWeight:800, fontFamily:'var(--mono)', color: k.color }">{{ k.value }}</p>
          <p class="stat" style="font-size:0.78rem;margin-top:4px;">{{ k.sub }}</p>
        </div>
      </div>
    </div>

    <!-- 既有子元件（各自帶卡片樣式） -->
    <AttributionReport :prediction="latestPrediction" />
    <PredictionHistoryPanel :game-name="gameName" :prediction-data="predictionData" accent="var(--accent)" />
    <AsiLearningPanel :game-name="gameName" :records="asiLearning" accent="var(--accent)" />
    <PerformanceChart :game-name="gameName" :performance-data="performanceData" />
  </div>
</template>
