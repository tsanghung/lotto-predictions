<script setup>
import { computed } from 'vue'
import { predictionHasDetailedInsight } from '../services/predictionVisibility'

const props = defineProps({
  gameName: { type: String, required: true },
  predictionData: { type: Array, default: () => [] },
  historyData: { type: Array, default: () => [] },
  accent: { type: String, default: '#2dd4bf' }
})

const latestPrediction = computed(() => {
  if (!props.predictionData || props.predictionData.length === 0) return null
  const filtered = props.predictionData.filter(p => p.game_name === props.gameName)
  const detailed = filtered.filter(predictionHasDetailedInsight)
  return detailed.length ? detailed[detailed.length - 1] : (filtered[filtered.length - 1] || null)
})

const latestPredictionDate = computed(() => {
  const date = latestPrediction.value?.target_draw_date || latestPrediction.value?.timestamp
  return date ? new Date(date).toLocaleDateString('zh-TW') : ''
})

const strategyStyle = (strategy) => {
  if (strategy.includes('激進') || strategy.includes('AI')) return { color: '#f87171', bg: 'rgba(248,113,113,0.08)', border: 'rgba(248,113,113,0.25)' }
  if (strategy.includes('穩健') || strategy.includes('平衡')) return { color: '#34d399', bg: 'rgba(52,211,153,0.08)', border: 'rgba(52,211,153,0.25)' }
  return { color: '#fbbf24', bg: 'rgba(251,191,36,0.08)', border: 'rgba(251,191,36,0.25)' }
}

// 各號碼的選號理由（相容舊版數字 key 與新版 selected_numbers）
const numberInsights = computed(() => {
  const insights = latestPrediction.value?.prediction?.number_insights || null
  if (!insights) return null
  return insights.selected_numbers || insights
})

// 理由標籤的色彩
const tagStyle = (tag) => {
  switch (tag) {
    case 'overdue': return { color: '#fca5a5', bg: 'rgba(239,68,68,0.12)', border: 'rgba(239,68,68,0.3)', label: '久未開' }
    case 'hot':     return { color: '#fcd34d', bg: 'rgba(251,191,36,0.12)', border: 'rgba(251,191,36,0.3)', label: '近期熱' }
    case 'fresh':   return { color: '#93c5fd', bg: 'rgba(59,130,246,0.12)', border: 'rgba(59,130,246,0.3)', label: '剛開出' }
    default:        return { color: '#86efac', bg: 'rgba(52,211,153,0.10)', border: 'rgba(52,211,153,0.28)', label: '週期穩' }
  }
}

// 取某號碼的理由文字（供徽章 tooltip 使用）
const reasonOf = (n) => (numberInsights.value && numberInsights.value[n]?.reason ? numberInsights.value[n].reason : '')

// 依即將開出指數由高至低排序，最具話題性的（久未開出）優先列出
const sortedInsights = computed(() => {
  if (!numberInsights.value) return []
  return Object.entries(numberInsights.value)
    .filter(([num, info]) => Number.isInteger(Number(num)) && info && typeof info.reason === 'string')
    .map(([num, info]) => ({ num: parseInt(num, 10), ...info }))
    .sort((a, b) => (b.overdue_index ?? 0) - (a.overdue_index ?? 0))
})
</script>

<template>
  <div style="display:flex;flex-direction:column;gap:20px;">

    <!-- Latest Prediction Card -->
    <div :style="{
      background: 'rgba(255,255,255,0.03)',
      border: '1px solid rgba(255,255,255,0.08)',
      borderRadius: '20px',
      padding: '24px',
      position: 'relative',
      overflow: 'hidden'
    }">
      <!-- Top glow accent -->
      <div :style="{
        position:'absolute', top:0, left:'50%', transform:'translateX(-50%)',
        width:'60%', height:'1px',
        background: `linear-gradient(90deg, transparent, ${accent}, transparent)`
      }"></div>

      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:20px;">
        <h2 style="font-size:1.1rem;font-weight:700;color:#f1f5f9;display:flex;align-items:center;gap:8px;">
          <span>🔮</span> AI 預測號碼
        </h2>
        <span v-if="latestPrediction" style="font-size:14px;color:#64748b;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.06);border-radius:100px;padding:3px 10px;">
          {{ latestPredictionDate }}
        </span>
      </div>

      <!-- No data state -->
      <div v-if="!latestPrediction" style="text-align:center;padding:40px 0;color:#475569;">
        <div style="font-size:38px;margin-bottom:12px;">🎲</div>
        <p style="font-size:17px;">尚無預測資料</p>
        <p style="font-size:15px;margin-top:4px;">請等待 AI 每日自動生成</p>
      </div>

      <!-- Prediction content -->
      <div v-else>
        <!-- AI Reasoning -->
        <div style="background:rgba(0,0,0,0.2);border-radius:12px;padding:14px;margin-bottom:16px;border:1px solid rgba(255,255,255,0.05);">
          <p style="font-size:14px;font-weight:600;color:#64748b;letter-spacing:0.08em;text-transform:uppercase;margin-bottom:8px;">📊 AI 統計洞察</p>
          <p style="font-size:16px;color:#94a3b8;line-height:1.6;">{{ latestPrediction.prediction.reasoning }}</p>
        </div>

        <!-- Combinations -->
        <div style="display:flex;flex-direction:column;gap:10px;">
          <p style="font-size:14px;font-weight:600;color:#64748b;letter-spacing:0.08em;text-transform:uppercase;">💡 推薦投注組合</p>
          <div v-for="(nums, strategy) in latestPrediction.prediction.combinations" :key="strategy"
            :style="{
              background: strategyStyle(strategy).bg,
              border: `1px solid ${strategyStyle(strategy).border}`,
              borderRadius:'12px', padding:'12px 14px',
              display:'flex', alignItems:'center', justifyContent:'space-between', flexWrap:'wrap', gap:'10px'
            }">
            <span :style="{ fontSize:'15px', fontWeight:'700', color: strategyStyle(strategy).color, minWidth:'80px' }">{{ strategy }}</span>
            <div style="display:flex;gap:6px;flex-wrap:wrap;">
              <span v-for="n in nums" :key="n"
                :title="reasonOf(n)"
                :style="{
                  width:'32px', height:'32px', borderRadius:'50%',
                  background:'rgba(0,0,0,0.3)', border:'1px solid rgba(255,255,255,0.1)',
                  display:'flex', alignItems:'center', justifyContent:'center',
                  fontSize:'15px', fontWeight:'700', fontFamily:'monospace', color:'#f1f5f9',
                  cursor: reasonOf(n) ? 'help' : 'default'
                }">
                {{ n.toString().padStart(2, '0') }}
              </span>
            </div>
          </div>
        </div>

        <!-- 今日選號理由 -->
        <div v-if="sortedInsights.length" style="margin-top:16px;background:rgba(0,0,0,0.2);border:1px solid rgba(255,255,255,0.05);border-radius:12px;padding:14px;">
          <p style="font-size:18px;font-weight:600;color:#64748b;letter-spacing:0.08em;text-transform:uppercase;margin-bottom:14px;">🔍 今日選號理由</p>
          <div style="display:flex;flex-direction:column;gap:14px;">
            <div v-for="item in sortedInsights" :key="item.num"
              style="display:flex;align-items:flex-start;gap:12px;">
              <span :style="{
                flexShrink:0, width:'44px', height:'44px', borderRadius:'50%',
                background: tagStyle(item.tag).bg, border: `1px solid ${tagStyle(item.tag).border}`,
                display:'flex', alignItems:'center', justifyContent:'center',
                fontSize:'20px', fontWeight:'800', fontFamily:'monospace', color: tagStyle(item.tag).color
              }">
                {{ item.num.toString().padStart(2, '0') }}
              </span>
              <div style="display:flex;flex-direction:column;gap:5px;min-width:0;">
                <span :style="{
                  alignSelf:'flex-start', fontSize:'14px', fontWeight:'700', padding:'2px 10px', borderRadius:'100px',
                  background: tagStyle(item.tag).bg, border: `1px solid ${tagStyle(item.tag).border}`, color: tagStyle(item.tag).color
                }">{{ tagStyle(item.tag).label }}</span>
                <span style="font-size:18px;color:#94a3b8;line-height:1.6;">{{ item.reason }}</span>
              </div>
            </div>
          </div>
          <p style="font-size:14px;color:#475569;line-height:1.6;margin-top:14px;padding-top:12px;border-top:1px solid rgba(255,255,255,0.05);">
            ⚠️ 以上為號碼的客觀統計特徵，各期開獎在機率上仍為獨立事件，僅供參考。
          </p>
        </div>

        <!-- Risk warning -->
        <p v-if="latestPrediction.prediction.risk_warning" style="font-size:14px;color:#475569;margin-top:12px;font-style:italic;">
          ⚠️ {{ latestPrediction.prediction.risk_warning }}
        </p>
      </div>
    </div>
  </div>
</template>
