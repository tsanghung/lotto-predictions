<script setup>
import { computed, ref } from 'vue'

const props = defineProps({
  gameName: { type: String, required: true },
  predictionData: { type: Array, default: () => [] },
  accent: { type: String, default: '#2dd4bf' }
})

const visibleCount = ref(10)

const gameRecords = computed(() => {
  return [...(props.predictionData || [])]
    .filter(record => record.game_name === props.gameName)
    .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
})

const visibleRecords = computed(() => gameRecords.value.slice(0, visibleCount.value))
const hasMore = computed(() => visibleCount.value < gameRecords.value.length)

const formatDateTime = (iso) => {
  if (!iso) return '--'
  return new Date(iso).toLocaleString('zh-TW', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  })
}

const strategyTheme = (strategy) => {
  if (strategy.includes('激進')) {
    return { color: '#f87171', bg: 'rgba(248,113,113,0.08)', border: 'rgba(248,113,113,0.25)' }
  }
  if (strategy.includes('穩健') || strategy.includes('平衡')) {
    return { color: '#34d399', bg: 'rgba(52,211,153,0.08)', border: 'rgba(52,211,153,0.25)' }
  }
  return { color: '#fbbf24', bg: 'rgba(251,191,36,0.08)', border: 'rgba(251,191,36,0.25)' }
}

const actualNumbers = (record) => record?.evaluation?.actual_numbers || []
const drawId = (record) => record?.evaluation?.draw_id || null
const strategyEvaluation = (record, strategy) => record?.evaluation?.strategies?.[strategy] || null

const hitCount = (record, strategy, nums) => {
  const evaluation = strategyEvaluation(record, strategy)
  if (!record?.is_evaluated || !evaluation) return null
  return `${evaluation.hits ?? 0} / ${nums.length}`
}

const isMatched = (record, strategy, number) => {
  const evaluation = strategyEvaluation(record, strategy)
  return Boolean(evaluation?.matches?.includes(number))
}

const showMore = () => {
  visibleCount.value += 10
}
</script>

<template>
  <div style="background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.07);border-radius:20px;padding:24px;">
    <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:16px;flex-wrap:wrap;margin-bottom:20px;">
      <div>
        <p style="font-size:14px;font-weight:700;color:#64748b;letter-spacing:0.12em;text-transform:uppercase;margin-bottom:6px;">
          Prediction History
        </p>
        <h3 style="font-size:24px;font-weight:800;color:#f1f5f9;line-height:1.3;margin:0;">
          歷史推薦與開獎對照
        </h3>
      </div>
      <span :style="{ fontSize:'15px', color: accent, background:'rgba(255,255,255,0.04)', border:`1px solid ${accent}55`, borderRadius:'999px', padding:'6px 14px', fontWeight:'700' }">
        {{ gameRecords.length }} 筆紀錄
      </span>
    </div>

    <div v-if="!gameRecords.length" style="text-align:center;padding:40px 0;color:#64748b;font-size:17px;">
      尚無歷史推薦紀錄
    </div>

    <div v-else style="display:flex;flex-direction:column;gap:16px;">
      <article v-for="record in visibleRecords" :key="record.timestamp"
        style="background:rgba(15,23,42,0.58);border:1px solid rgba(255,255,255,0.08);border-radius:16px;padding:18px;">
        <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:14px;flex-wrap:wrap;margin-bottom:16px;">
          <div>
            <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:8px;">
              <span :style="{ width:'10px', height:'10px', borderRadius:'50%', background: accent, boxShadow:`0 0 10px ${accent}` }"></span>
              <span style="font-size:18px;font-weight:800;color:#e2e8f0;">{{ formatDateTime(record.timestamp) }}</span>
              <span style="font-size:14px;color:#64748b;">{{ record.game_name }}</span>
            </div>
            <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
              <span v-if="record.is_evaluated" style="font-size:14px;color:#34d399;background:rgba(52,211,153,0.1);border:1px solid rgba(52,211,153,0.28);border-radius:999px;padding:3px 10px;font-weight:700;">
                已對獎
              </span>
              <span v-else style="font-size:14px;color:#fbbf24;background:rgba(251,191,36,0.1);border:1px solid rgba(251,191,36,0.28);border-radius:999px;padding:3px 10px;font-weight:700;">
                待開獎
              </span>
              <span style="font-size:15px;color:#94a3b8;">
                {{ drawId(record) ? `第 ${drawId(record)} 期` : '尚未對應開獎期數' }}
              </span>
            </div>
          </div>

          <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
            <span style="font-size:15px;font-weight:700;color:#64748b;">實際開出</span>
            <template v-if="actualNumbers(record).length">
              <span v-for="n in actualNumbers(record)" :key="n"
                :style="{ width:'40px', height:'40px', borderRadius:'50%', background:`linear-gradient(135deg, ${accent}22, ${accent}44)`, border:`1px solid ${accent}66`, display:'flex', alignItems:'center', justifyContent:'center', fontSize:'20px', fontWeight:'900', fontFamily:'monospace', color: accent }">
                {{ n.toString().padStart(2, '0') }}
              </span>
            </template>
            <span v-else style="font-size:16px;color:#64748b;">尚未對獎</span>
          </div>
        </div>

        <div style="display:flex;flex-direction:column;gap:10px;">
          <div v-for="(nums, strategy) in record.prediction?.combinations" :key="strategy"
            :style="{ display:'grid', gridTemplateColumns:'minmax(100px, 140px) 1fr auto', alignItems:'center', gap:'12px', background:strategyTheme(strategy).bg, border:`1px solid ${strategyTheme(strategy).border}`, borderRadius:'12px', padding:'12px 14px' }"
            class="prediction-history-row">
            <span :style="{ fontSize:'16px', fontWeight:'800', color:strategyTheme(strategy).color }">{{ strategy }}</span>
            <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
              <span v-for="n in nums" :key="n"
                :style="{
                  width:'38px', height:'38px', borderRadius:'50%',
                  background: isMatched(record, strategy, n) ? 'rgba(52,211,153,0.22)' : 'rgba(0,0,0,0.28)',
                  border: isMatched(record, strategy, n) ? '2px solid rgba(52,211,153,0.85)' : '1px solid rgba(255,255,255,0.12)',
                  display:'flex', alignItems:'center', justifyContent:'center',
                  fontSize:'19px', fontWeight:'900', fontFamily:'monospace',
                  color: isMatched(record, strategy, n) ? '#86efac' : '#e2e8f0',
                  boxShadow: isMatched(record, strategy, n) ? '0 0 12px rgba(52,211,153,0.35)' : 'none'
                }">
                {{ n.toString().padStart(2, '0') }}
              </span>
            </div>
            <span :style="{ fontSize:'15px', fontWeight:'800', color: hitCount(record, strategy, nums) ? '#cbd5e1' : '#fbbf24', whiteSpace:'nowrap' }">
              {{ hitCount(record, strategy, nums) ? `命中 ${hitCount(record, strategy, nums)}` : '待對獎' }}
            </span>
          </div>
        </div>
      </article>
    </div>

    <div v-if="hasMore" style="display:flex;justify-content:center;margin-top:18px;">
      <button @click="showMore"
        :style="{ background:'rgba(255,255,255,0.06)', border:'1px solid rgba(255,255,255,0.12)', borderRadius:'10px', color:'#cbd5e1', cursor:'pointer', fontSize:'16px', fontWeight:'700', padding:'10px 18px' }">
        顯示更多
      </button>
    </div>
  </div>
</template>

<style scoped>
@media (max-width: 760px) {
  .prediction-history-row {
    grid-template-columns: 1fr !important;
    align-items: flex-start !important;
  }
}
</style>
