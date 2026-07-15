<script setup>
import { computed } from 'vue'
import { toLaiLearningView } from '../services/laiPresentation.js'

const props = defineProps({
  gameName: { type: String, required: true },
  records: { type: Array, default: () => [] },
  accent: { type: String, default: '#38bdf8' }
})

const latestRecords = computed(() => {
  return [...props.records]
    .filter((record) => record.game_name === props.gameName)
    .sort((a, b) => {
      const dateDiff = new Date(b.target_draw_date) - new Date(a.target_draw_date)
      if (dateDiff !== 0) return dateDiff
      return new Date(b.created_at || 0) - new Date(a.created_at || 0)
    })
    .slice(0, 10)
})

function formatNumbers(numbers) {
  if (!numbers?.length) return '無'
  return numbers.map((number) => String(number).padStart(2, '0')).join(' ')
}

function strategyRows(record) {
  return Object.entries(record.strategy_effectiveness || {}).map(([name, review]) => ({
    name,
    hits: review?.hits ?? review?.hit_count ?? '-',
    analysis: review?.analysis || review?.learning_note || '尚無分析'
  }))
}

const laiLearning = (record) => toLaiLearningView(record)
const expertName = (name) => ({
  uniform: '均勻基準', frequency: '頻率模型', overdue: '遺漏模型',
  hazard: '風險率模型', cooccurrence: '共現模型', markov: '轉移模型'
})[name] || name
const formatMetric = (value, digits = 4) => Number.isFinite(value) ? Number(value).toFixed(digits) : '資料不足'
const formatWeight = (value) => Number.isFinite(value) ? `${(value * 100).toFixed(1)}%` : '--'
</script>

<template>
  <section class="asi-panel">
    <div class="asi-heading">
      <p>ASI LEARNING</p>
      <h3>樂透 ASI 學習紀錄</h3>
    </div>

    <div v-if="!latestRecords.length" class="asi-empty">
      尚無已對獎的 ASI 學習紀錄。
    </div>

    <article
      v-for="record in latestRecords"
      :key="`${record.game_name}-${record.target_draw_date}-${record.draw_id || record.created_at}`"
      class="asi-record"
    >
      <header>
        <strong>{{ record.target_draw_date }}</strong>
        <span>{{ record.model_name || record.reasoning_source || 'statistical fallback' }}</span>
      </header>

      <div class="asi-grid">
        <div>
          <small>命中獎號</small>
          <b>{{ formatNumbers(record.matched_numbers) }}</b>
        </div>
        <div>
          <small>未中獎號</small>
          <b>{{ formatNumbers(record.missed_numbers) }}</b>
        </div>
        <div>
          <small>實際開出</small>
          <b>{{ formatNumbers(record.actual_numbers) }}</b>
        </div>
      </div>

      <section v-if="laiLearning(record)" class="lai-learning" aria-label="LAI 量化學習結果">
        <div class="lai-learning__summary">
          <div><small>Agent 狀態</small><b>{{ laiLearning(record).agentStatus || '資料不足' }}</b></div>
          <div><small>Champion</small><b>{{ laiLearning(record).championModel || '資料不足' }}</b></div>
          <div><small>Brier Skill Score</small><b>{{ formatMetric(laiLearning(record).brierSkillScore) }}</b></div>
          <div><small>雙組聯集命中</small><b>{{ laiLearning(record).unionHits ?? '--' }} / {{ laiLearning(record).unionSize ?? '--' }}</b></div>
        </div>
        <p v-if="laiLearning(record).championChanged === true" class="lai-learning__change">
          Champion 已由 {{ laiLearning(record).previousChampionModel || '未知' }} 更新為 {{ laiLearning(record).championModel }}。
        </p>
        <div v-if="laiLearning(record).weightChanges.length" class="lai-learning__table-wrap">
          <table>
            <thead><tr><th>專家模型</th><th>更新前</th><th>更新後</th><th>差異</th></tr></thead>
            <tbody>
              <tr v-for="row in laiLearning(record).weightChanges" :key="row.model">
                <td>{{ expertName(row.model) }}</td>
                <td>{{ formatWeight(row.before) }}</td>
                <td>{{ formatWeight(row.after) }}</td>
                <td :class="row.delta > 0 ? 'is-positive' : row.delta < 0 ? 'is-negative' : ''">
                  {{ row.delta > 0 ? '+' : '' }}{{ formatWeight(row.delta) }}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <p class="lai-learning__limitation">{{ laiLearning(record).limitation }}</p>
      </section>

      <div v-if="strategyRows(record).length" class="asi-strategies">
        <div v-for="row in strategyRows(record)" :key="row.name">
          <strong>{{ row.name }}：{{ row.hits }} hit</strong>
          <span>{{ row.analysis }}</span>
        </div>
      </div>

      <ol v-if="record.next_adjustments?.length" class="asi-adjustments">
        <li v-for="item in record.next_adjustments" :key="item">{{ item }}</li>
      </ol>
    </article>
  </section>
</template>

<style scoped>
.asi-panel {
  border: 1px solid rgba(148, 163, 184, 0.18);
  border-radius: 8px;
  padding: 24px;
  background: rgba(15, 23, 42, 0.72);
}

.asi-heading p {
  color: v-bind(accent);
  font-size: 0.75rem;
  font-weight: 800;
  letter-spacing: 0.14em;
}

.asi-heading h3 {
  color: #f8fafc;
  font-size: 1.5rem;
  margin-top: 4px;
}

.asi-empty {
  margin-top: 16px;
  color: #94a3b8;
}

.asi-record {
  margin-top: 18px;
  padding-top: 18px;
  border-top: 1px solid rgba(148, 163, 184, 0.14);
}

.asi-record header,
.asi-grid,
.asi-strategies > div {
  display: grid;
  gap: 8px;
}

.asi-record header {
  grid-template-columns: 1fr auto;
  color: #e2e8f0;
}

.asi-record header span,
.asi-grid small,
.asi-strategies span {
  color: #94a3b8;
}

.asi-grid {
  grid-template-columns: repeat(3, minmax(0, 1fr));
  margin-top: 14px;
}

.asi-grid b {
  color: #f8fafc;
  font-size: 1.05rem;
}

.asi-strategies,
.asi-adjustments {
  margin-top: 14px;
}

.lai-learning {
  margin-top: 16px;
  padding-top: 16px;
  border-top: 1px solid rgba(148, 163, 184, 0.14);
}

.lai-learning__summary {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 10px;
}

.lai-learning__summary > div {
  min-width: 0;
  padding: 10px;
  background: rgba(255, 255, 255, 0.035);
  border: 1px solid rgba(148, 163, 184, 0.12);
  border-radius: 6px;
}

.lai-learning small,
.lai-learning__limitation {
  color: #94a3b8;
}

.lai-learning b {
  display: block;
  margin-top: 4px;
  color: #f8fafc;
  overflow-wrap: anywhere;
}

.lai-learning__change {
  margin-top: 12px;
  color: #86efac;
}

.lai-learning__table-wrap {
  margin-top: 12px;
  overflow-x: auto;
}

.lai-learning table {
  width: 100%;
  border-collapse: collapse;
  color: #cbd5e1;
  font-size: 0.875rem;
}

.lai-learning th,
.lai-learning td {
  padding: 8px;
  border-bottom: 1px solid rgba(148, 163, 184, 0.12);
  text-align: right;
}

.lai-learning th:first-child,
.lai-learning td:first-child { text-align: left; }
.lai-learning .is-positive { color: #86efac; }
.lai-learning .is-negative { color: #fca5a5; }
.lai-learning__limitation { margin-top: 12px; font-size: 0.8125rem; line-height: 1.55; }

.asi-strategies > div {
  padding: 12px;
  border-radius: 8px;
  background: rgba(15, 23, 42, 0.6);
}

.asi-strategies strong {
  color: #f8fafc;
}

.asi-adjustments {
  color: #cbd5e1;
  padding-left: 20px;
}

@media (max-width: 720px) {
  .asi-record header,
  .asi-grid,
  .lai-learning__summary {
    grid-template-columns: 1fr;
  }
}
</style>
