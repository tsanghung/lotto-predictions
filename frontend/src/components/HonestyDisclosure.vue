<script setup>
import { computed } from 'vue'
import { predictionHasDetailedInsight } from '../services/predictionVisibility'

const props = defineProps({
  gameName: { type: String, required: true },
  predictionData: { type: Array, default: () => [] },
})

// 與 PredictionCard 相同的「取最新一筆有明細的預測」邏輯，保持數字一致。
const latest = computed(() => {
  const filtered = (props.predictionData || []).filter((p) => p.game_name === props.gameName)
  const detailed = filtered.filter(predictionHasDetailedInsight)
  return detailed.length ? detailed[detailed.length - 1] : (filtered[filtered.length - 1] || null)
})

const fairness = computed(() => latest.value?.prediction?.fairness_diagnostic || null)
const calibration = computed(() => latest.value?.prediction?.heartbeat?.calibration || null)
</script>

<template>
  <div class="card card-glow" style="border-color:var(--ok-border);">
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;">
      <span style="font-size:1.3rem;">🔬</span>
      <h3 style="font-size:1.15rem;font-weight:800;color:var(--text);">誠實揭露 · 數據說話</h3>
    </div>
    <p style="font-size:0.88rem;color:var(--text-mute);line-height:1.6;margin-bottom:18px;">
      本站不美化準確度。以下是本期公正性健診與心跳明牌滾動校正的<strong style="color:var(--text-dim);">真實回測數字</strong>——
      綠色代表「與隨機無異」，這正是我們據實以告的底線。
    </p>

    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:14px;">
      <!-- 公正性健診 -->
      <div style="background:var(--surface-2);border:1px solid var(--ok-border);border-radius:var(--radius);padding:16px;">
        <p class="eyebrow" style="margin-bottom:8px;">公正性健診</p>
        <p :style="{ fontSize:'1.5rem', fontWeight:800, color: fairness?.passed ? 'var(--ok)' : 'var(--warn)' }">
          {{ fairness ? (fairness.passed ? '通過' : '待查') : '—' }}
        </p>
        <p class="stat" style="font-size:0.78rem;margin-top:6px;line-height:1.5;">
          <template v-if="fairness">均勻性 p={{ fairness.uniform_p }}<br>獨立性 p={{ fairness.serial_p }}</template>
          <template v-else>尚無本期資料</template>
        </p>
      </div>

      <!-- 心跳命中率 -->
      <div style="background:var(--surface-2);border:1px solid var(--ok-border);border-radius:var(--radius);padding:16px;">
        <p class="eyebrow" style="margin-bottom:8px;">心跳命中率</p>
        <p style="font-size:1.5rem;font-weight:800;color:var(--ok);">
          {{ calibration ? `${calibration.hit_rate}%` : '—' }}
        </p>
        <p class="stat" style="font-size:0.78rem;margin-top:6px;line-height:1.5;">
          <template v-if="calibration">隨機基準 {{ calibration.base_rate }}%<br>近 {{ calibration.window }} 期・p={{ calibration.p_value }}</template>
          <template v-else>尚無回測資料</template>
        </p>
      </div>

      <!-- vs 隨機 -->
      <div style="background:var(--surface-2);border:1px solid var(--ok-border);border-radius:var(--radius);padding:16px;">
        <p class="eyebrow" style="margin-bottom:8px;">是否勝過隨機</p>
        <p :style="{ fontSize:'1.5rem', fontWeight:800, color: calibration?.beats_random ? 'var(--warn)' : 'var(--ok)' }">
          {{ calibration ? (calibration.beats_random ? '偏離待查' : '否 · 一致') : '—' }}
        </p>
        <p class="stat" style="font-size:0.78rem;margin-top:6px;line-height:1.5;">
          與隨機無顯著差異<br>= 誠實、可信
        </p>
      </div>

      <!-- 期望值 -->
      <div style="background:var(--surface-2);border:1px solid var(--danger-border);border-radius:var(--radius);padding:16px;">
        <p class="eyebrow" style="margin-bottom:8px;">數學期望值</p>
        <p style="font-size:1.5rem;font-weight:800;color:var(--danger);">為負</p>
        <p class="stat" style="font-size:0.78rem;margin-top:6px;line-height:1.5;">
          每組號碼中獎<br>機率完全相同
        </p>
      </div>
    </div>

    <p class="disclaimer" style="margin-top:16px;">
      ⚠️ 任何選號法都不影響中獎機率；唯一能改變的是注數（多買不同注）與中獎後被平分的機率。本站僅供參考娛樂，請理性投注、量力而為。
    </p>
  </div>
</template>
