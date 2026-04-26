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

const numbers = computed(() => {
  return Array.from({ length: props.maxNumber }, (_, i) => i + 1).map(n => ({
    num: n,
    count: frequency.value[n] || 0,
    ratio: frequency.value[n] / (maxFreq.value || 1)
  }))
})

// Color based on heat
const heatColor = (ratio) => {
  if (ratio > 0.75) return '#ef4444'
  if (ratio > 0.5) return '#f97316'
  if (ratio > 0.25) return '#eab308'
  return '#3b82f6'
}
</script>

<template>
  <div style="background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.07);border-radius:20px;padding:24px;">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:20px;">
      <h3 style="font-size:14px;font-weight:700;color:#f1f5f9;display:flex;align-items:center;gap:8px;">
        📈 號碼頻率熱力圖
        <span style="font-size:11px;font-weight:400;color:#475569;">全期統計</span>
      </h3>
      <div style="display:flex;align-items:center;gap:12px;font-size:10px;color:#64748b;">
        <span style="display:flex;align-items:center;gap:4px;"><span style="width:10px;height:10px;border-radius:2px;background:#3b82f6;display:inline-block;"></span>冷門</span>
        <span style="display:flex;align-items:center;gap:4px;"><span style="width:10px;height:10px;border-radius:2px;background:#ef4444;display:inline-block;"></span>熱門</span>
      </div>
    </div>

    <div style="display:grid;gap:5px;" :style="{ gridTemplateColumns: `repeat(${maxNumber <= 39 ? 8 : 10}, 1fr)` }">
      <div v-for="item in numbers" :key="item.num"
        :title="`號碼 ${item.num}：出現 ${item.count} 次`"
        :style="{
          aspectRatio:'1',
          borderRadius:'8px',
          background: `${heatColor(item.ratio)}${Math.round(item.ratio * 0.6 * 255).toString(16).padStart(2,'0')}`,
          border: `1px solid ${heatColor(item.ratio)}40`,
          display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center',
          cursor:'default', transition:'transform 0.15s',
          transform: 'scale(1)'
        }"
        @mouseenter="e => e.target.style.transform='scale(1.15)'"
        @mouseleave="e => e.target.style.transform='scale(1)'"
      >
        <span :style="{ fontSize:'10px', fontWeight:'800', fontFamily:'monospace', color: item.ratio > 0.3 ? '#fff' : '#94a3b8', lineHeight:'1' }">
          {{ item.num.toString().padStart(2,'0') }}
        </span>
        <span :style="{ fontSize:'8px', color: item.ratio > 0.3 ? 'rgba(255,255,255,0.7)' : '#475569', lineHeight:'1', marginTop:'1px' }">
          {{ item.count }}
        </span>
      </div>
    </div>
  </div>
</template>
