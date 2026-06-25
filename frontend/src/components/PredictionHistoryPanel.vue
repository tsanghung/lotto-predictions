<script setup>
import { computed, ref } from 'vue'

const props = defineProps({
  gameName: { type: String, required: true },
  predictionData: { type: Array, default: () => [] },
  accent: { type: String, default: '#2dd4bf' }
})

const visibleCount = ref(10)

const recordTargetDate = (record) => record?.target_draw_date || record?.timestamp?.slice(0, 10) || ''

const chooseDisplayRecord = (current, candidate) => {
  if (!current) return candidate
  if (candidate.is_evaluated && !current.is_evaluated) return candidate
  if (!candidate.is_evaluated && current.is_evaluated) return current
  return new Date(candidate.timestamp) > new Date(current.timestamp) ? candidate : current
}

const gameRecords = computed(() => {
  const byTargetDate = new Map()
  for (const record of props.predictionData || []) {
    if (record.game_name !== props.gameName) continue
    const target = recordTargetDate(record)
    const key = `${record.game_name}|${target}`
    byTargetDate.set(key, chooseDisplayRecord(byTargetDate.get(key), record))
  }

  return [...byTargetDate.values()]
    .sort((a, b) =>
      recordTargetDate(b).localeCompare(recordTargetDate(a)) ||
      new Date(b.timestamp) - new Date(a.timestamp)
    )
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

const formatDate = (dateString) => {
  if (!dateString) return '--'
  return new Date(`${dateString}T00:00:00+08:00`).toLocaleDateString('zh-TW', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
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
const secondAreaNumbers = (record, strategy) => record?.prediction?.special_combinations?.[strategy] || []
const actualSecondAreaNumber = (record) => record?.evaluation?.special_number || null
const formatPercent = (rate) => `${((Number(rate) || 0) * 100).toFixed(1)}%`

const hitCount = (record, strategy, nums) => {
  const evaluation = strategyEvaluation(record, strategy)
  if (!record?.is_evaluated || !evaluation) return null
  return `${evaluation.hits ?? 0} / ${nums.length}`
}

const hitLabel = (record, strategy, nums) => {
  const evaluation = strategyEvaluation(record, strategy)
  if (!record?.is_evaluated || !evaluation) return '待對獎'
  const secondArea = secondAreaNumbers(record, strategy)
  const firstAreaText = secondArea.length ? `第一區 ${evaluation.hits ?? 0} / ${nums.length}` : `命中 ${evaluation.hits ?? 0} / ${nums.length}`
  if (!secondArea.length) return firstAreaText
  return `${firstAreaText}，第二區 ${evaluation.special_hits ?? 0} / ${secondArea.length}`
}

const secondAreaSummary = computed(() => {
  const summary = {
    total_hits: 0,
    total_predictions: 0,
    hit_rate: 0,
    strategies: {},
  }

  for (const record of gameRecords.value) {
    if (!record?.is_evaluated) continue

    for (const strategy of Object.keys(record.prediction?.special_combinations || {})) {
      const picks = secondAreaNumbers(record, strategy)
      if (!picks.length) continue

      const evaluation = strategyEvaluation(record, strategy)
      if (!evaluation) continue

      if (!summary.strategies[strategy]) {
        summary.strategies[strategy] = {
          total_hits: 0,
          total_predictions: 0,
          hit_rate: 0,
        }
      }

      const actualSecondArea = Number(actualSecondAreaNumber(record))
      const hits = Number.isFinite(Number(evaluation.special_hits))
        ? Number(evaluation.special_hits)
        : Number.isInteger(actualSecondArea)
          ? picks.filter((number) => number === actualSecondArea).length
          : 0

      summary.total_hits += hits
      summary.total_predictions += picks.length
      summary.strategies[strategy].total_hits += hits
      summary.strategies[strategy].total_predictions += picks.length
    }
  }

  summary.hit_rate = summary.total_predictions ? summary.total_hits / summary.total_predictions : 0
  for (const stats of Object.values(summary.strategies)) {
    stats.hit_rate = stats.total_predictions ? stats.total_hits / stats.total_predictions : 0
  }

  return summary
})

const isMatched = (record, strategy, number) => {
  const evaluation = strategyEvaluation(record, strategy)
  return Boolean(evaluation?.matches?.includes(number))
}

const isSecondAreaMatched = (record, strategy, number) => {
  const evaluation = strategyEvaluation(record, strategy)
  return Boolean(evaluation?.special_matches?.includes(number))
}

const learningReport = (record) => record?.evaluation?.learning_report || null
const learningSummary = (record) => learningReport(record)?.summary || {}
const predictedLearningRows = (record) => learningReport(record)?.predicted_numbers || []
const actualLearningRows = (record) => learningReport(record)?.actual_numbers || []
const strategyLearningRows = (record) =>
  Object.entries(learningReport(record)?.strategy_reviews || {}).map(([strategy, review]) => ({
    strategy,
    ...review
  }))
const guidanceItems = (record) => learningReport(record)?.next_prediction_guidance || []

const numberListText = (numbers) => {
  if (!Array.isArray(numbers) || !numbers.length) return '無'
  return numbers.map((n) => n.toString().padStart(2, '0')).join('、')
}

const predictedOutcomeLabel = (outcome) => outcome === 'hit' ? '命中' : '未中'
const actualOutcomeLabel = (item) => item?.was_predicted ? '已預測' : '漏抓'

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
      <section v-if="secondAreaSummary.total_predictions"
        style="border:1px solid rgba(251,191,36,0.22);background:rgba(251,191,36,0.06);border-radius:16px;padding:16px;display:flex;flex-direction:column;gap:14px;">
        <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:16px;flex-wrap:wrap;">
          <div>
            <p style="font-size:12px;font-weight:800;color:#fbbf24;letter-spacing:0.16em;text-transform:uppercase;margin:0 0 4px;">
              Second Area
            </p>
            <h4 style="font-size:20px;font-weight:900;color:#f8fafc;margin:0;">第二區歷史累積命中率</h4>
          </div>
          <div style="text-align:right;">
            <p style="font-size:13px;font-weight:700;color:#94a3b8;margin:0 0 4px;">累積命中</p>
            <p style="font-size:28px;font-weight:900;color:#fbbf24;font-family:monospace;margin:0;">
              {{ secondAreaSummary.total_hits }} / {{ secondAreaSummary.total_predictions }}
            </p>
            <p style="font-size:15px;font-weight:900;color:#fde68a;font-family:monospace;margin:0;">
              {{ formatPercent(secondAreaSummary.hit_rate) }}
            </p>
          </div>
        </div>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:10px;">
          <div v-for="(stats, strategy) in secondAreaSummary.strategies" :key="`history-second-area-${strategy}`"
            style="background:rgba(15,23,42,0.5);border:1px solid rgba(255,255,255,0.08);border-radius:12px;padding:12px;">
            <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;">
              <span style="font-size:14px;font-weight:800;color:#cbd5e1;">{{ strategy }}</span>
              <span style="font-size:18px;font-weight:900;color:#fbbf24;font-family:monospace;">{{ formatPercent(stats.hit_rate) }}</span>
            </div>
            <p style="font-size:12px;font-weight:700;color:#64748b;margin:4px 0 0;">
              命中 {{ stats.total_hits }} / {{ stats.total_predictions }}
            </p>
          </div>
        </div>
      </section>

      <article v-for="record in visibleRecords" :key="record.source_key || `${record.game_name}-${recordTargetDate(record)}`"
        style="background:rgba(15,23,42,0.58);border:1px solid rgba(255,255,255,0.08);border-radius:16px;padding:18px;">
        <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:14px;flex-wrap:wrap;margin-bottom:16px;">
          <div>
            <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:8px;">
              <span :style="{ width:'10px', height:'10px', borderRadius:'50%', background: accent, boxShadow:`0 0 10px ${accent}` }"></span>
              <span style="font-size:18px;font-weight:800;color:#e2e8f0;">{{ formatDate(recordTargetDate(record)) }}</span>
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
              <span style="font-size:14px;color:#64748b;">
                產生：{{ formatDateTime(record.timestamp) }}
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
              <template v-if="actualSecondAreaNumber(record)">
                <span style="font-size:13px;font-weight:800;color:#fbbf24;margin-left:4px;">第二區</span>
                <span
                  :style="{ width:'40px', height:'40px', borderRadius:'50%', background:'rgba(251,191,36,0.16)', border:'1px solid rgba(251,191,36,0.48)', display:'flex', alignItems:'center', justifyContent:'center', fontSize:'20px', fontWeight:'900', fontFamily:'monospace', color:'#fbbf24' }">
                  {{ actualSecondAreaNumber(record).toString().padStart(2, '0') }}
                </span>
              </template>
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
              <span v-if="secondAreaNumbers(record, strategy).length" style="font-size:13px;font-weight:800;color:#94a3b8;">第一區</span>
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
              <template v-if="secondAreaNumbers(record, strategy).length">
                <span style="font-size:13px;font-weight:800;color:#fbbf24;margin-left:6px;">第二區</span>
                <span v-for="n in secondAreaNumbers(record, strategy)" :key="`special-${strategy}-${n}`"
                  :style="{
                    width:'38px', height:'38px', borderRadius:'50%',
                    background: isSecondAreaMatched(record, strategy, n) ? 'rgba(251,191,36,0.28)' : 'rgba(251,191,36,0.12)',
                    border: isSecondAreaMatched(record, strategy, n) ? '2px solid rgba(251,191,36,0.9)' : '1px solid rgba(251,191,36,0.42)',
                    display:'flex', alignItems:'center', justifyContent:'center',
                    fontSize:'19px', fontWeight:'900', fontFamily:'monospace',
                    color:'#fbbf24',
                    boxShadow: isSecondAreaMatched(record, strategy, n) ? '0 0 12px rgba(251,191,36,0.35)' : 'none'
                  }">
                  {{ n.toString().padStart(2, '0') }}
                </span>
              </template>
            </div>
            <span :style="{ fontSize:'15px', fontWeight:'800', color: hitCount(record, strategy, nums) ? '#cbd5e1' : '#fbbf24', whiteSpace:'nowrap' }">
              {{ hitLabel(record, strategy, nums) }}
            </span>
          </div>
        </div>

        <section v-if="learningReport(record)" class="learning-report">
          <div class="learning-report-header">
            <div>
              <p class="learning-kicker">Agent Learning</p>
              <h4>智能體學習回饋</h4>
            </div>
            <span class="learning-best">
              最佳策略：{{ learningSummary(record).best_strategy || '待累積' }}
            </span>
          </div>

          <div class="learning-summary">
            <div>
              <span>命中號碼</span>
              <strong>{{ numberListText(learningSummary(record).hit_predicted_numbers) }}</strong>
            </div>
            <div>
              <span>未中號碼</span>
              <strong>{{ numberListText(learningSummary(record).missed_predicted_numbers) }}</strong>
            </div>
            <div>
              <span>漏抓號碼</span>
              <strong>{{ numberListText(learningSummary(record).uncovered_actual_numbers) }}</strong>
            </div>
          </div>

          <div class="learning-block">
            <p class="learning-title">預測號碼檢討</p>
            <div class="learning-number-grid">
              <div v-for="item in predictedLearningRows(record)" :key="`predicted-${item.number}`" class="learning-number-row">
                <span class="learning-ball">{{ item.number.toString().padStart(2, '0') }}</span>
                <span :class="['learning-status', item.outcome === 'hit' ? 'is-hit' : 'is-miss']">
                  {{ predictedOutcomeLabel(item.outcome) }}
                </span>
                <div>
                  <p>{{ item.selection_reason }}</p>
                  <small>{{ item.learning_note }}</small>
                </div>
              </div>
            </div>
          </div>

          <div class="learning-block">
            <p class="learning-title">實際開出分析</p>
            <div class="learning-number-grid">
              <div v-for="item in actualLearningRows(record)" :key="`actual-${item.number}`" class="learning-number-row">
                <span class="learning-ball is-actual">{{ item.number.toString().padStart(2, '0') }}</span>
                <span :class="['learning-status', item.was_predicted ? 'is-hit' : 'is-miss']">
                  {{ actualOutcomeLabel(item) }}
                </span>
                <div>
                  <p>{{ item.opening_analysis }}</p>
                  <small>{{ item.learning_note }}</small>
                </div>
              </div>
            </div>
          </div>

          <div class="learning-block">
            <p class="learning-title">策略檢討</p>
            <div class="learning-strategy-list">
              <div v-for="item in strategyLearningRows(record)" :key="item.strategy">
                <strong>{{ item.strategy }}：命中 {{ item.hits }} / {{ (item.matches?.length || 0) + (item.missed_numbers?.length || 0) }}</strong>
                <p>{{ item.analysis }}</p>
                <small>{{ item.next_adjustment }}</small>
              </div>
            </div>
          </div>

          <div class="learning-block">
            <p class="learning-title">下期修正方向</p>
            <ol class="learning-guidance">
              <li v-for="item in guidanceItems(record)" :key="item">{{ item }}</li>
            </ol>
          </div>
        </section>
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
.learning-report {
  margin-top: 16px;
  border-top: 1px solid rgba(255, 255, 255, 0.1);
  padding-top: 16px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.learning-report-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}

.learning-kicker {
  color: #64748b;
  font-size: 12px;
  font-weight: 800;
  letter-spacing: 0.12em;
  margin: 0 0 4px;
  text-transform: uppercase;
}

.learning-report h4 {
  color: #f8fafc;
  font-size: 20px;
  font-weight: 900;
  line-height: 1.25;
  margin: 0;
}

.learning-best {
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 999px;
  color: #cbd5e1;
  font-size: 14px;
  font-weight: 800;
  padding: 6px 12px;
}

.learning-summary {
  display: grid;
  gap: 10px;
  grid-template-columns: repeat(3, minmax(0, 1fr));
}

.learning-summary > div {
  background: rgba(15, 23, 42, 0.52);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 12px;
  padding: 12px;
}

.learning-summary span,
.learning-title {
  color: #94a3b8;
  display: block;
  font-size: 13px;
  font-weight: 800;
  margin: 0 0 6px;
}

.learning-summary strong {
  color: #f8fafc;
  display: block;
  font-family: monospace;
  font-size: 18px;
  line-height: 1.35;
  overflow-wrap: anywhere;
}

.learning-block {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.learning-number-grid,
.learning-strategy-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.learning-number-row {
  align-items: flex-start;
  background: rgba(255, 255, 255, 0.035);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 12px;
  display: grid;
  gap: 10px;
  grid-template-columns: 42px 58px minmax(0, 1fr);
  padding: 10px;
}

.learning-ball {
  align-items: center;
  background: rgba(15, 23, 42, 0.8);
  border: 1px solid rgba(148, 163, 184, 0.28);
  border-radius: 50%;
  color: #e2e8f0;
  display: flex;
  font-family: monospace;
  font-size: 17px;
  font-weight: 900;
  height: 36px;
  justify-content: center;
  width: 36px;
}

.learning-ball.is-actual {
  border-color: rgba(167, 139, 250, 0.45);
  color: #c4b5fd;
}

.learning-status {
  border-radius: 999px;
  font-size: 13px;
  font-weight: 900;
  justify-self: start;
  padding: 4px 9px;
  white-space: nowrap;
}

.learning-status.is-hit {
  background: rgba(52, 211, 153, 0.12);
  border: 1px solid rgba(52, 211, 153, 0.32);
  color: #86efac;
}

.learning-status.is-miss {
  background: rgba(251, 191, 36, 0.12);
  border: 1px solid rgba(251, 191, 36, 0.3);
  color: #fde68a;
}

.learning-number-row p,
.learning-strategy-list p {
  color: #dbeafe;
  font-size: 14px;
  line-height: 1.55;
  margin: 0 0 4px;
  overflow-wrap: anywhere;
}

.learning-number-row small,
.learning-strategy-list small {
  color: #94a3b8;
  display: block;
  font-size: 13px;
  line-height: 1.5;
  overflow-wrap: anywhere;
}

.learning-strategy-list > div {
  background: rgba(255, 255, 255, 0.035);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 12px;
  padding: 10px 12px;
}

.learning-strategy-list strong {
  color: #f8fafc;
  display: block;
  font-size: 14px;
  margin-bottom: 4px;
}

.learning-guidance {
  color: #cbd5e1;
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 0;
  padding-left: 20px;
}

.learning-guidance li {
  font-size: 14px;
  line-height: 1.55;
  overflow-wrap: anywhere;
}

@media (max-width: 760px) {
  .prediction-history-row {
    grid-template-columns: 1fr !important;
    align-items: flex-start !important;
  }

  .learning-summary {
    grid-template-columns: 1fr;
  }

  .learning-number-row {
    grid-template-columns: 42px minmax(0, 1fr);
  }

  .learning-number-row > div {
    grid-column: 1 / -1;
  }
}
</style>
