<script setup>
import { computed } from 'vue'

const props = defineProps({
  gameName: { type: String, required: true },
  historyData: { type: Array, default: () => [] },
  maxNumber: { type: Number, default: 49 },
  accent: { type: String, default: '#2dd4bf' }
})

// Count frequency across all draws
const frequency = computed(() => {
  const freq = {}
  for (let i = 1; i <= props.maxNumber; i++) freq[i] = 0
  props.historyData.forEach(draw => {
    draw.numbers.forEach(n => { freq[n] = (freq[n] || 0) + 1 })
  })
  return freq
})

const maxFreq = computed(() => Math.max(...Object.values(frequency.value)))
const minFreq = computed(() => Math.min(...Object.values(frequency.value)))

const numbers = computed(() => {
  const spread = (maxFreq.value - minFreq.value) || 1
  return Array.from({ length: props.maxNumber }, (_, i) => i + 1).map(n => ({
    num: n,
    count: frequency.value[n] || 0,
    // 相對分布：最冷=0（藍），最熱=1（紅），中間平均散開
    ratio: ((frequency.value[n] || 0) - minFreq.value) / spread
  }))
})

// 依 ratio 回傳 [背景色, 邊框色]，固定不透明度確保冷熱色差清晰可見
const heatStyle = (ratio) => {
  // 5 段色階：藍(冷) → 青 → 綠 → 橙 → 紅(熱)
  if (ratio > 0.8)  return { bg: 'rgba(239,68,68,0.85)',   border: 'rgba(239,68,68,0.6)' }
  if (ratio > 0.6)  return { bg: 'rgba(249,115,22,0.80)',  border: 'rgba(249,115,22,0.5)' }
  if (ratio > 0.4)  return { bg: 'rgba(234,179,8,0.75)',   border: 'rgba(234,179,8,0.5)' }
  if (ratio > 0.2)  return { bg: 'rgba(34,197,94,0.70)',   border: 'rgba(34,197,94,0.45)' }
  return                    { bg: 'rgba(59,130,246,0.65)',  border: 'rgba(59,130,246,0.4)' }
}
</script>

<template>
  <div style="background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.07);border-radius:20px;padding:24px;">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:20px;">
      <h3 style="font-size:17px;font-weight:700;color:#f1f5f9;display:flex;align-items:center;gap:8px;">
        📈 號碼頻率熱力圖
        <span style="font-size:14px;font-weight:400;color:#475569;">全期統計</span>
      </h3>
      <div style="display:flex;align-items:center;gap:10px;font-size:13px;color:#64748b;">
        <span style="display:flex;align-items:center;gap:4px;"><span style="width:10px;height:10px;border-radius:2px;background:#3b82f6;display:inline-block;"></span>冷門</span>
        <span style="display:flex;align-items:center;gap:4px;"><span style="width:10px;height:10px;border-radius:2px;background:#22c55e;display:inline-block;"></span></span>
        <span style="display:flex;align-items:center;gap:4px;"><span style="width:10px;height:10px;border-radius:2px;background:#eab308;display:inline-block;"></span></span>
        <span style="display:flex;align-items:center;gap:4px;"><span style="width:10px;height:10px;border-radius:2px;background:#f97316;display:inline-block;"></span></span>
        <span style="display:flex;align-items:center;gap:4px;"><span style="width:10px;height:10px;border-radius:2px;background:#ef4444;display:inline-block;"></span>熱門</span>
      </div>
    </div>

    <div style="display:grid;gap:5px;" :style="{ gridTemplateColumns: `repeat(${maxNumber <= 39 ? 8 : 10}, 1fr)` }">
      <div v-for="item in numbers" :key="item.num"
        :title="`號碼 ${item.num}：出現 ${item.count} 次`"
        :style="{
          aspectRatio:'1',
          borderRadius:'8px',
          background: heatStyle(item.ratio).bg,
          border: `1px solid ${heatStyle(item.ratio).border}`,
          display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center',
          cursor:'default', transition:'transform 0.15s',
          transform: 'scale(1)'
        }"
        @mouseenter="e => e.target.style.transform='scale(1.15)'"
        @mouseleave="e => e.target.style.transform='scale(1)'"
      >
        <span :style="{ fontSize:'26px', fontWeight:'800', fontFamily:'monospace', color: item.ratio > 0.3 ? '#fff' : '#94a3b8', lineHeight:'1' }">
          {{ item.num.toString().padStart(2,'0') }}
        </span>
        <span :style="{ fontSize:'20px', color: item.ratio > 0.3 ? 'rgba(255,255,255,0.7)' : '#475569', lineHeight:'1', marginTop:'3px' }">
          {{ item.count }}
        </span>
      </div>
    </div>
  </div>
</template>
