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
  if (strategy.includes('①') || strategy.includes('激進') || strategy.includes('AI')) return { color: '#f87171', bg: 'rgba(248,113,113,0.08)', border: 'rgba(248,113,113,0.25)' }
  if (strategy.includes('②') || strategy.includes('穩健') || strategy.includes('平衡')) return { color: '#34d399', bg: 'rgba(52,211,153,0.08)', border: 'rgba(52,211,153,0.25)' }
  return { color: '#fbbf24', bg: 'rgba(251,191,36,0.08)', border: 'rgba(251,191,36,0.25)' }
}

// 公正性健診（誠實博弈版的招牌）
const fairness = computed(() => latestPrediction.value?.prediction?.fairness_diagnostic || null)

// 號碼心跳明牌（節奏推算，回測≈隨機，僅供對照）
const heartbeat = computed(() => latestPrediction.value?.prediction?.heartbeat || null)

// 穩健平衡組合（排除心跳明牌，後者另開區塊呈現）
const balancedCombos = computed(() => {
  const all = latestPrediction.value?.prediction?.combinations || {}
  return Object.fromEntries(Object.entries(all).filter(([key]) => key !== '心跳明牌'))
})

// 心跳明牌各號的節奏明細，依 overdue 比值由高到低
const heartbeatRows = computed(() => {
  const hb = heartbeat.value
  if (!hb || !hb.numbers) return []
  return Object.entries(hb.numbers)
    .map(([num, info]) => ({ num: parseInt(num, 10), ...info }))
    .sort((a, b) => (b.overdue_ratio ?? 0) - (a.overdue_ratio ?? 0))
})

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

const secondAreaNumbers = (strategy) =>
  latestPrediction.value?.prediction?.special_combinations?.[strategy] || []

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
          <span>🎲</span> 公正性健診 + 博弈選號
        </h2>
        <span v-if="latestPrediction" style="font-size:14px;color:#64748b;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.06);border-radius:100px;padding:3px 10px;">
          {{ latestPredictionDate }}
        </span>
      </div>

      <!-- No data state -->
      <div v-if="!latestPrediction" style="text-align:center;padding:40px 0;color:#475569;">
        <div style="font-size:38px;margin-bottom:12px;">🎲</div>
        <p style="font-size:17px;">尚無本期資料</p>
        <p style="font-size:15px;margin-top:4px;">請等待每日自動生成</p>
      </div>

      <!-- Prediction content -->
      <div v-else>
        <!-- 公正性健診 -->
        <div v-if="fairness" :style="{ background: fairness.passed ? 'rgba(52,211,153,0.08)' : 'rgba(251,191,36,0.08)', border: `1px solid ${fairness.passed ? 'rgba(52,211,153,0.28)' : 'rgba(251,191,36,0.28)'}`, borderRadius:'12px', padding:'14px', marginBottom:'16px' }">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px;">
            <span style="font-size:20px;">{{ fairness.passed ? '✅' : '⚠️' }}</span>
            <p style="font-size:15px;font-weight:700;color:#e2e8f0;">公正性健診：{{ fairness.passed ? '通過（開獎與真隨機無法區分）' : '異常待查' }}</p>
          </div>
          <div style="display:flex;gap:18px;flex-wrap:wrap;font-size:14px;color:#94a3b8;font-family:monospace;">
            <span>號碼均勻性 p = {{ fairness.uniform_p }}</span>
            <span>前後期獨立性 p = {{ fairness.serial_p }}</span>
            <span>樣本 {{ fairness.sample_size }} 期</span>
          </div>
          <p style="font-size:13px;color:#475569;line-height:1.6;margin-top:10px;">p ≥ 0.05 代表與「真隨機」無法區分 → 每組號碼中獎機率都相同、沒有「明牌」。以下選號為統計啟發式，僅供參考，不提高中獎機率。</p>
        </div>

        <!-- 選號說明 -->
        <div style="background:rgba(0,0,0,0.2);border-radius:12px;padding:14px;margin-bottom:16px;border:1px solid rgba(255,255,255,0.05);">
          <p style="font-size:14px;font-weight:600;color:#64748b;letter-spacing:0.08em;text-transform:uppercase;margin-bottom:8px;">📊 健診與選號說明</p>
          <p style="font-size:16px;color:#94a3b8;line-height:1.6;">{{ latestPrediction.prediction.reasoning }}</p>
        </div>

        <!-- Combinations -->
        <div style="display:flex;flex-direction:column;gap:10px;">
          <p style="font-size:14px;font-weight:600;color:#64748b;letter-spacing:0.08em;text-transform:uppercase;">① ⚖️ 穩健平衡（跨號段均勻分布、結構平衡的一組選號）</p>
          <div v-for="(nums, strategy) in balancedCombos" :key="strategy"
            :style="{
              background: strategyStyle(strategy).bg,
              border: `1px solid ${strategyStyle(strategy).border}`,
              borderRadius:'12px', padding:'12px 14px',
              display:'flex', alignItems:'center', justifyContent:'space-between', flexWrap:'wrap', gap:'10px'
            }">
            <span :style="{ fontSize:'15px', fontWeight:'700', color: strategyStyle(strategy).color, minWidth:'80px' }">{{ strategy }}</span>
            <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;">
              <span v-if="secondAreaNumbers(strategy).length" style="font-size:13px;font-weight:800;color:#94a3b8;margin-right:2px;">第一區</span>
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
              <template v-if="secondAreaNumbers(strategy).length">
                <span style="font-size:13px;font-weight:800;color:#fbbf24;margin:0 2px 0 8px;">第二區</span>
                <span v-for="n in secondAreaNumbers(strategy)" :key="`special-${strategy}-${n}`"
                  :style="{
                    width:'32px', height:'32px', borderRadius:'50%',
                    background:'rgba(251,191,36,0.16)', border:'1px solid rgba(251,191,36,0.45)',
                    display:'flex', alignItems:'center', justifyContent:'center',
                    fontSize:'15px', fontWeight:'800', fontFamily:'monospace', color:'#fbbf24'
                  }">
                  {{ n.toString().padStart(2, '0') }}
                </span>
              </template>
            </div>
          </div>
        </div>

        <!-- ② 號碼心跳明牌（節奏推算 + 滾動校正回歸） -->
        <div v-if="heartbeat && heartbeat.combination" style="margin-top:16px;display:flex;flex-direction:column;gap:10px;">
          <p style="font-size:14px;font-weight:600;color:#64748b;letter-spacing:0.08em;text-transform:uppercase;">② 💓 號碼心跳明牌</p>
          <div style="background:rgba(168,85,247,0.06);border:1px solid rgba(168,85,247,0.22);border-radius:12px;padding:12px 14px;display:flex;flex-direction:column;gap:10px;">
            <span style="font-size:13px;font-weight:700;color:#c4b5fd;">依各號平均間隔（天）的節奏，挑最久未開（overdue 比值最高）的號</span>
            <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;">
              <span v-if="heartbeat.second_area && heartbeat.second_area.length" style="font-size:13px;font-weight:800;color:#94a3b8;margin-right:2px;">第一區</span>
              <span v-for="n in heartbeat.combination" :key="`hb-${n}`"
                :style="{ width:'32px',height:'32px',borderRadius:'50%',background:'rgba(168,85,247,0.16)',border:'1px solid rgba(168,85,247,0.4)',display:'flex',alignItems:'center',justifyContent:'center',fontSize:'15px',fontWeight:'700',fontFamily:'monospace',color:'#e9d5ff' }">
                {{ n.toString().padStart(2, '0') }}
              </span>
              <template v-if="heartbeat.second_area && heartbeat.second_area.length">
                <span style="font-size:13px;font-weight:800;color:#fbbf24;margin:0 2px 0 8px;">第二區</span>
                <span v-for="n in heartbeat.second_area" :key="`hb2-${n}`"
                  :style="{ width:'32px',height:'32px',borderRadius:'50%',background:'rgba(251,191,36,0.16)',border:'1px solid rgba(251,191,36,0.45)',display:'flex',alignItems:'center',justifyContent:'center',fontSize:'15px',fontWeight:'800',fontFamily:'monospace',color:'#fbbf24' }">
                  {{ n.toString().padStart(2, '0') }}
                </span>
              </template>
            </div>
            <div v-if="heartbeat.calibration" style="font-size:13px;color:#94a3b8;font-family:monospace;background:rgba(0,0,0,0.2);border-radius:8px;padding:8px 10px;line-height:1.6;">
              滾動校正：心跳命中率 {{ heartbeat.calibration.hit_rate }}% ≈ 隨機 {{ heartbeat.calibration.base_rate }}%
              （近 {{ heartbeat.calibration.window }} 期回測，p={{ heartbeat.calibration.p_value }}）
              <span :style="{ color: heartbeat.calibration.beats_random ? '#fca5a5' : '#86efac' }">
                → {{ heartbeat.calibration.beats_random ? '⚠ 顯著偏離隨機，值得追查' : '與隨機無異' }}
              </span>
            </div>
            <div v-if="heartbeatRows.length" style="display:flex;flex-direction:column;gap:6px;">
              <div v-for="row in heartbeatRows" :key="`hbrow-${row.num}`" style="display:flex;align-items:center;gap:8px;font-size:13px;color:#94a3b8;flex-wrap:wrap;">
                <span :style="{ flexShrink:0,width:'30px',height:'30px',borderRadius:'50%',background:'rgba(168,85,247,0.12)',border:'1px solid rgba(168,85,247,0.3)',display:'flex',alignItems:'center',justifyContent:'center',fontWeight:'800',fontFamily:'monospace',color:'#e9d5ff' }">{{ row.num.toString().padStart(2, '0') }}</span>
                <span v-if="row.avg_interval_days != null">平均間隔 {{ row.avg_interval_days }} 天</span>
                <span v-if="row.gap_days != null">· 已隔 {{ row.gap_days }} 天</span>
                <span v-if="row.overdue_ratio != null" style="color:#c4b5fd;font-weight:700;">· overdue {{ row.overdue_ratio }}×</span>
              </div>
            </div>
            <p style="font-size:12px;color:#64748b;line-height:1.6;">
              ⚠ 公正抽獎是「無記憶」過程，等再久也不會更可能開；回測證實此排名命中率與隨機無異，僅供節奏對照，非中獎保證。
            </p>
          </div>
        </div>

        <!-- 今日選號理由 -->
        <div v-if="sortedInsights.length" style="margin-top:16px;background:rgba(0,0,0,0.2);border:1px solid rgba(255,255,255,0.05);border-radius:12px;padding:14px;">
          <p style="font-size:18px;font-weight:600;color:#64748b;letter-spacing:0.08em;text-transform:uppercase;margin-bottom:14px;">🔍 選號號碼統計特徵</p>
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
