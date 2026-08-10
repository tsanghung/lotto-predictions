<script setup>
import { computed } from 'vue'
import { toModelEvidenceView } from '../services/laiPresentation.js'

const props = defineProps({
  record: { type: Object, required: true }
})

const evidence = computed(() => toModelEvidenceView(props.record))

const stageLabels = {
  baseline: 'Baseline',
  canary: 'Canary',
  champion: 'Champion'
}

const decisionLabels = {
  confidence_interval_crosses_zero: '信賴區間跨越 0，尚無優於隨機的證據',
  approved_state: '沿用已核准的量化狀態'
}

const formatScore = (value) => Number.isFinite(value) ? value.toFixed(4) : '資料不足'
const formatInterval = (lower, upper) => (
  Number.isFinite(lower) && Number.isFinite(upper)
    ? `[${lower.toFixed(4)}, ${upper.toFixed(4)}]`
    : '資料不足'
)
const stageLabel = (stage) => stageLabels[stage] || '資料不足'
const decisionLabel = (reason) => decisionLabels[reason] || reason || '資料不足'
</script>

<template>
  <section v-if="evidence" class="evidence" aria-label="LAI v3 量化證據">
    <header class="evidence__header">
      <div>
        <p class="evidence__eyebrow">Model evidence</p>
        <h3>量化證據與限制</h3>
      </div>
      <span class="evidence__shadow">僅作 shadow 驗證</span>
    </header>

    <dl class="evidence__grid">
      <div>
        <dt>Champion 模型</dt>
        <dd>{{ evidence.champion || '資料不足' }}</dd>
      </div>
      <div>
        <dt>驗證階段</dt>
        <dd>{{ stageLabel(evidence.promotionStage) }}</dd>
      </div>
      <div>
        <dt>Shadow 樣本</dt>
        <dd>{{ evidence.shadowSamples == null ? '資料不足' : `${evidence.shadowSamples} 期` }}</dd>
      </div>
      <div>
        <dt>Brier Skill</dt>
        <dd>{{ formatScore(evidence.brierSkill) }}</dd>
      </div>
      <div>
        <dt>Brier Skill 95% CI</dt>
        <dd>{{ formatInterval(evidence.ciLower95, evidence.ciUpper95) }}</dd>
      </div>
    </dl>

    <div class="evidence__notes">
      <p><strong>最近決策</strong><span>{{ decisionLabel(evidence.decisionReason) }}</span></p>
      <p><strong>驗證結論</strong><span>{{ evidence.provenAboveRandom ? '已通過既定隨機基準門檻' : '尚無證據優於隨機基準' }}</span></p>
      <p><strong>限制</strong><span>{{ evidence.limitation }}</span></p>
    </div>
  </section>
</template>

<style scoped>
.evidence, .evidence * { box-sizing: border-box; letter-spacing: 0; }
.evidence { min-width: 0; padding-top: 18px; margin-top: 18px; color: #cbd5e1; border-top: 1px solid rgba(45,212,191,.24); }
.evidence h3, .evidence p, .evidence dl, .evidence dd { margin: 0; }
.evidence__header { display: flex; gap: 16px; align-items: flex-start; justify-content: space-between; }
.evidence__eyebrow { margin-bottom: 4px !important; color: #5eead4; font-size: 12px; font-weight: 700; text-transform: uppercase; }
.evidence h3 { color: #e2e8f0; font-size: 16px; line-height: 1.4; }
.evidence__shadow { flex: none; padding: 5px 9px; color: #fbbf24; font-size: 13px; font-weight: 700; background: rgba(251,191,36,.08); border: 1px solid rgba(251,191,36,.28); border-radius: 6px; }
.evidence__grid { display: grid; grid-template-columns: repeat(auto-fit,minmax(132px,1fr)); gap: 12px; padding: 14px 0; margin-top: 14px; border-block: 1px solid rgba(255,255,255,.08); }
.evidence__grid div { min-width: 0; }
.evidence dt { margin-bottom: 5px; color: #64748b; font-size: 12px; font-weight: 700; }
.evidence dd { overflow-wrap: anywhere; color: #d1fae5; font: 700 14px/1.45 monospace; }
.evidence__notes { display: grid; gap: 8px; margin-top: 14px; }
.evidence__notes p { display: grid; grid-template-columns: 84px minmax(0,1fr); gap: 12px; color: #94a3b8; font-size: 13px; line-height: 1.6; }
.evidence__notes strong { color: #cbd5e1; font-size: 13px; }
.evidence__notes span { overflow-wrap: anywhere; }
@media (max-width: 720px) {
  .evidence__header { flex-direction: column; }
  .evidence__grid { grid-template-columns: 1fr; }
  .evidence__notes p { grid-template-columns: 1fr; gap: 2px; }
}
</style>
