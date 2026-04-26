<script setup>
import { computed } from 'vue'

const props = defineProps({
  gameName: { type: String, required: true },
  historyData: { type: Array, default: () => [] },
  maxNumber: { type: Number, default: 49 },
  accent: { type: String, default: '#2dd4bf' }
})

const last20 = computed(() => props.historyData.slice(-20))

// Count frequency of each number in recent 20 draws
const frequency = computed(() => {
  const freq = {}
  for (let i = 1; i <= props.maxNumber; i++) freq[i] = 0
  last20.value.forEach(draw => {
    draw.numbers.forEach(n => { freq[n] = (freq[n] || 0) + 1 })
  })
  return freq
})

// Top 5 hot and cold numbers
const sorted = computed(() => {
  return Object.entries(frequency.value)
    .map(([num, count]) => ({ num: parseInt(num), count }))
    .sort((a, b) => b.count - a.count)
})

const hotNumbers = computed(() => sorted.value.slice(0, 5))
const coldNumbers = computed(() => sorted.value.slice(-5).reverse())

// Last 20 draws for trend
const recentDraws = computed(() => props.historyData.slice(-5).reverse())

// Stats
const totalDraws = computed(() => props.historyData.length)
const avgSum = computed(() => {
  if (!last20.value.length) return 0
  const sums = last20.value.map(d => d.numbers.reduce((a, b) => a + b, 0))
  return Math.round(sums.reduce((a, b) => a + b, 0) / sums.length)
})
</script>

<template>
  <div style="display:flex;flex-direction:column;gap:20px;">

    <!-- Stat cards row -->
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">
      <div style="background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.07);border-radius:14px;padding:16px;text-align:center;">
        <p style="font-size:11px;color:#64748b;margin-bottom:6px;letter-spacing:0.05em;">累積期數</p>
        <p :style="{ fontSize:'1.8rem', fontWeight:'900', color: accent, fontFamily:'monospace' }">{{ totalDraws }}</p>
      </div>
      <div style="background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.07);border-radius:14px;padding:16px;text-align:center;">
        <p style="font-size:11px;color:#64748b;margin-bottom:6px;letter-spacing:0.05em;">近20期均值</p>
        <p style="font-size:1.8rem;font-weight:900;color:#f59e0b;font-family:monospace;">{{ avgSum }}</p>
      </div>
    </div>

    <!-- Hot numbers -->
    <div style="background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.07);border-radius:20px;padding:20px;">
      <h3 style="font-size:13px;font-weight:700;color:#f1f5f9;margin-bottom:14px;display:flex;align-items:center;gap:6px;">
        🔥 近20期熱門號碼
      </h3>
      <div style="display:flex;gap:10px;justify-content:center;">
        <div v-for="(item, i) in hotNumbers" :key="item.num" style="display:flex;flex-direction:column;align-items:center;gap:6px;">
          <span :style="{
            width:'44px', height:'44px', borderRadius:'50%',
            background: i===0 ? 'linear-gradient(135deg,#ef4444,#dc2626)' : 'rgba(239,68,68,0.12)',
            border: i===0 ? '2px solid #ef4444' : '2px solid rgba(239,68,68,0.35)',
            display:'flex', alignItems:'center', justifyContent:'center',
            fontSize:'14px', fontWeight:'800', fontFamily:'monospace',
            color: i===0 ? '#fff' : '#fca5a5',
            boxShadow: i===0 ? '0 0 16px rgba(239,68,68,0.4)' : 'none'
          }">
            {{ item.num.toString().padStart(2,'0') }}
          </span>
          <span style="font-size:10px;color:#64748b;">{{ item.count }}次</span>
        </div>
      </div>
    </div>

    <!-- Cold numbers -->
    <div style="background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.07);border-radius:20px;padding:20px;">
      <h3 style="font-size:13px;font-weight:700;color:#f1f5f9;margin-bottom:14px;display:flex;align-items:center;gap:6px;">
        🧊 近20期冷門號碼
      </h3>
      <div style="display:flex;gap:10px;justify-content:center;">
        <div v-for="(item, i) in coldNumbers" :key="item.num" style="display:flex;flex-direction:column;align-items:center;gap:6px;">
          <span :style="{
            width:'44px', height:'44px', borderRadius:'50%',
            background: i===0 ? 'linear-gradient(135deg,#3b82f6,#1d4ed8)' : 'rgba(59,130,246,0.12)',
            border: i===0 ? '2px solid #3b82f6' : '2px solid rgba(59,130,246,0.35)',
            display:'flex', alignItems:'center', justifyContent:'center',
            fontSize:'14px', fontWeight:'800', fontFamily:'monospace',
            color: i===0 ? '#fff' : '#93c5fd',
            boxShadow: i===0 ? '0 0 16px rgba(59,130,246,0.4)' : 'none'
          }">
            {{ item.num.toString().padStart(2,'0') }}
          </span>
          <span style="font-size:10px;color:#64748b;">{{ item.count }}次</span>
        </div>
      </div>
    </div>

    <!-- Recent draws -->
    <div style="background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.07);border-radius:20px;padding:20px;">
      <h3 style="font-size:13px;font-weight:700;color:#f1f5f9;margin-bottom:14px;">📅 近5期開獎紀錄</h3>
      <div style="display:flex;flex-direction:column;gap:10px;">
        <div v-for="draw in recentDraws" :key="draw.draw_id"
          style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding-bottom:10px;border-bottom:1px solid rgba(255,255,255,0.04);">
          <span style="font-size:11px;color:#475569;min-width:82px;">{{ draw.date }}</span>
          <div style="display:flex;gap:5px;flex-wrap:wrap;">
            <span v-for="n in draw.numbers" :key="n"
              style="width:26px;height:26px;border-radius:50%;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.1);display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:700;font-family:monospace;color:#cbd5e1;">
              {{ n.toString().padStart(2,'0') }}
            </span>
            <span v-if="draw.special_number" style="width:26px;height:26px;border-radius:50%;background:rgba(251,191,36,0.1);border:1px solid rgba(251,191,36,0.3);display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:700;font-family:monospace;color:#fbbf24;">
              {{ draw.special_number.toString().padStart(2,'00') }}
            </span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
