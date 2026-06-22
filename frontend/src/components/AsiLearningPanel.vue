<script setup>
import { computed } from 'vue'

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
  .asi-grid {
    grid-template-columns: 1fr;
  }
}
</style>
