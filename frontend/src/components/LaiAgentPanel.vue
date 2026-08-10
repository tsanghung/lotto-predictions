<script setup>
import { computed } from 'vue'
import { toLaiViewModel } from '../services/laiPresentation.js'
import ModelEvidencePanel from './ModelEvidencePanel.vue'

const props = defineProps({
  record: { type: Object, required: true },
  accent: { type: String, default: '#2dd4bf' }
})
const view = computed(() => toLaiViewModel(props.record))
const names = { uniform: '均勻基準', frequency: '頻率模型', overdue: '遺漏模型', bayesian: '貝氏模型', cooccurrence: '共現模型', markov: '轉移模型', lstm: '序列模型' }
const experts = computed(() => Object.entries(view.value?.expertWeights || {})
  .map(([name, weight]) => ({ name, label: names[name] || name, percent: Math.round(weight * 1000) / 10 }))
  .sort((a, b) => b.percent - a.percent || a.name.localeCompare(b.name)))
const numberLabel = (number) => String(number).padStart(2, '0')
</script>

<template>
  <section v-if="view" class="lai" :style="{ '--accent': accent }" :aria-label="`${view.version} 智能體`">
    <header class="lai__header">
      <div>
        <p class="lai__eyebrow">{{ view.isEvidenceModel ? 'Evidence shadow' : 'Adaptive prediction' }}</p>
        <h2>{{ view.version }} 智能體</h2>
        <p v-if="view.isEvidenceModel" class="lai__shadow-note">此組資料只用於 shadow 驗證，不是正式推薦，也不會觸發 LINE 通知。</p>
      </div>
      <span class="lai__status" :data-status="view.statusCode">{{ view.isEvidenceModel ? 'Shadow 驗證' : `狀態：${view.status}` }}</span>
    </header>
    <dl class="lai__meta" aria-label="智能體執行狀態">
      <div><dt>狀態版本</dt><dd>{{ view.stateVersion ?? '尚未建立' }}</dd></div>
      <div><dt>最近學習</dt><dd>{{ view.lastLearnedDate || '尚無紀錄' }}</dd></div>
      <div><dt>隨機基準驗證</dt><dd>{{ view.provenAboveRandom ? '已通過門檻' : '尚未證明優於隨機' }}</dd></div>
    </dl>
    <div class="lai__groups" :aria-label="view.isEvidenceModel ? 'LAI v3 shadow 候選組合' : 'LAI 推薦組合'">
      <section v-for="group in view.groups" :key="group.label" class="lai__group">
        <h3>{{ group.label }}</h3>
        <p v-if="!group.numbers.length" class="lai__empty">尚無可顯示號碼</p>
        <div v-else class="lai__numbers" :aria-label="`${group.label}第一區號碼`">
          <span v-for="number in group.numbers" :key="number" class="lai__number">{{ numberLabel(number) }}</span>
        </div>
        <div v-if="group.special.length" class="lai__special">
          <span>第二區</span>
          <div class="lai__numbers" :aria-label="`${group.label}第二區號碼`">
            <span v-for="number in group.special" :key="number" class="lai__number lai__number--special">{{ numberLabel(number) }}</span>
          </div>
        </div>
      </section>
    </div>
    <dl class="lai__coverage" aria-label="兩組號碼覆蓋統計">
      <div><dt>聯集覆蓋</dt><dd>{{ view.unionSize }} 個號碼</dd></div>
      <div><dt>兩組重疊</dt><dd>{{ view.overlapCount }} 個號碼</dd></div>
    </dl>
    <ModelEvidencePanel v-if="view.isEvidenceModel" :record="record" />
    <section v-else class="lai__experts">
      <h3>專家模型權重</h3>
      <p v-if="!experts.length" class="lai__empty">尚無權重資料</p>
      <ul v-else>
        <li v-for="expert in experts" :key="expert.name">
          <div class="lai__expert-label"><span>{{ expert.label }}</span><span>{{ expert.percent }}%</span></div>
          <div class="lai__track" role="progressbar" :aria-label="`${expert.label}權重`" aria-valuemin="0" aria-valuemax="100" :aria-valuenow="expert.percent"><span :style="{ width: `${Math.min(100, expert.percent)}%` }"></span></div>
        </li>
      </ul>
    </section>
  </section>
</template>

<style scoped>
.lai, .lai * { box-sizing: border-box; letter-spacing: 0; }
.lai { position: relative; overflow: hidden; padding: 20px; color: #e2e8f0; background: rgba(255,255,255,.03); border: 1px solid rgba(255,255,255,.1); border-radius: 8px; }
.lai::before { position: absolute; inset: 0 0 auto; height: 2px; content: ''; background: var(--accent); }
.lai h2, .lai h3, .lai p, .lai dl, .lai dd { margin: 0; }
.lai__header { display: flex; gap: 16px; align-items: flex-start; justify-content: space-between; }
.lai__eyebrow { margin-bottom: 4px !important; color: #64748b; font-size: 12px; font-weight: 700; text-transform: uppercase; }
.lai__shadow-note { max-width: 560px; margin-top: 8px !important; color: #fbbf24; font-size: 13px; line-height: 1.6; }
.lai h2 { font-size: 20px; line-height: 1.35; }
.lai h3 { font-size: 15px; line-height: 1.4; }
.lai__status { flex: none; padding: 5px 9px; color: #cbd5e1; font-size: 13px; font-weight: 700; background: rgba(148,163,184,.1); border: 1px solid rgba(148,163,184,.24); border-radius: 6px; }
.lai__status[data-status='champion'] { color: #6ee7b7; border-color: rgba(52,211,153,.4); }
.lai__status[data-status='degraded'] { color: #fca5a5; border-color: rgba(248,113,113,.4); }
.lai__meta, .lai__coverage { display: grid; grid-template-columns: repeat(3,minmax(0,1fr)); gap: 14px; padding: 14px 0; margin-top: 16px; border-block: 1px solid rgba(255,255,255,.08); }
.lai dt { margin-bottom: 4px; color: #64748b; font-size: 12px; }
.lai dd { overflow-wrap: anywhere; color: #cbd5e1; font-size: 14px; font-weight: 700; }
.lai__groups { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); margin-top: 18px; }
.lai__group { min-width: 0; padding-inline: 18px; }
.lai__group:first-child { padding-left: 0; border-right: 1px solid rgba(255,255,255,.08); }
.lai__group:last-child { padding-right: 0; }
.lai__group h3 { margin-bottom: 10px; color: var(--accent); }
.lai__numbers { display: flex; flex-wrap: wrap; gap: 7px; }
.lai__number { display: inline-flex; width: 36px; height: 36px; align-items: center; justify-content: center; color: #f8fafc; font: 800 15px monospace; background: rgba(0,0,0,.28); border: 1px solid rgba(148,163,184,.35); border-radius: 50%; }
.lai__special { display: flex; gap: 9px; align-items: center; margin-top: 12px; color: #fbbf24; font-size: 13px; font-weight: 700; }
.lai__number--special { color: #fbbf24; border-color: rgba(251,191,36,.48); }
.lai__coverage { grid-template-columns: repeat(2,minmax(0,1fr)); margin-top: 18px; }
.lai__experts { margin-top: 18px; }
.lai__experts h3 { margin-bottom: 10px; color: #cbd5e1; }
.lai__experts ul { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: 10px 18px; padding: 0; margin: 0; list-style: none; }
.lai__expert-label { display: flex; gap: 12px; justify-content: space-between; margin-bottom: 5px; color: #94a3b8; font-size: 12px; }
.lai__track { height: 5px; overflow: hidden; background: rgba(148,163,184,.14); border-radius: 3px; }
.lai__track span { display: block; height: 100%; background: var(--accent); border-radius: inherit; }
.lai__empty { color: #64748b; font-size: 13px; }
@media (max-width: 720px) {
  .lai { padding: 16px; }
  .lai__header { flex-direction: column; }
  .lai__meta, .lai__coverage, .lai__experts ul, .lai__groups { grid-template-columns: 1fr; }
  .lai__groups { gap: 16px; }
  .lai__group, .lai__group:first-child, .lai__group:last-child { padding: 0; border-right: 0; }
  .lai__group + .lai__group { padding-top: 16px; border-top: 1px solid rgba(255,255,255,.08); }
}
</style>
