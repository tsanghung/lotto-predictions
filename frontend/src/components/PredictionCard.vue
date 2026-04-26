<script setup>
import { computed } from 'vue'

const props = defineProps({
  gameName: { type: String, required: true },
  predictionData: { type: Array, default: () => [] },
  historyData: { type: Array, default: () => [] },
  accent: { type: String, default: '#2dd4bf' }
})

const latestPrediction = computed(() => {
  if (!props.predictionData || props.predictionData.length === 0) return null
  const filtered = props.predictionData.filter(p => p.game_name === props.gameName)
  return filtered.length ? filtered[filtered.length - 1] : null
})

const latestDraw = computed(() => {
  if (!props.historyData || props.historyData.length === 0) return null
  return props.historyData[props.historyData.length - 1]
})

const strategyStyle = (strategy) => {
  if (strategy.includes('激進') || strategy.includes('AI')) return { color: '#f87171', bg: 'rgba(248,113,113,0.08)', border: 'rgba(248,113,113,0.25)' }
  if (strategy.includes('穩健') || strategy.includes('平衡')) return { color: '#34d399', bg: 'rgba(52,211,153,0.08)', border: 'rgba(52,211,153,0.25)' }
  return { color: '#fbbf24', bg: 'rgba(251,191,36,0.08)', border: 'rgba(251,191,36,0.25)' }
}
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
        <span v-if="latestPrediction" style="font-size:11px;color:#64748b;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.06);border-radius:100px;padding:3px 10px;">
          {{ new Date(latestPrediction.timestamp).toLocaleDateString('zh-TW') }}
        </span>
      </div>

      <!-- No data state -->
      <div v-if="!latestPrediction" style="text-align:center;padding:40px 0;color:#475569;">
        <div style="font-size:32px;margin-bottom:12px;">🎲</div>
        <p style="font-size:14px;">尚無預測資料</p>
        <p style="font-size:12px;margin-top:4px;">請等待 AI 每日自動生成</p>
      </div>

      <!-- Prediction content -->
      <div v-else>
        <!-- AI Reasoning -->
        <div style="background:rgba(0,0,0,0.2);border-radius:12px;padding:14px;margin-bottom:16px;border:1px solid rgba(255,255,255,0.05);">
          <p style="font-size:11px;font-weight:600;color:#64748b;letter-spacing:0.08em;text-transform:uppercase;margin-bottom:8px;">📊 AI 統計洞察</p>
          <p style="font-size:13px;color:#94a3b8;line-height:1.6;">{{ latestPrediction.prediction.reasoning }}</p>
        </div>

        <!-- Combinations -->
        <div style="display:flex;flex-direction:column;gap:10px;">
          <p style="font-size:11px;font-weight:600;color:#64748b;letter-spacing:0.08em;text-transform:uppercase;">💡 推薦投注組合</p>
          <div v-for="(nums, strategy) in latestPrediction.prediction.combinations" :key="strategy"
            :style="{
              background: strategyStyle(strategy).bg,
              border: `1px solid ${strategyStyle(strategy).border}`,
              borderRadius:'12px', padding:'12px 14px',
              display:'flex', alignItems:'center', justifyContent:'space-between', flexWrap:'wrap', gap:'10px'
            }">
            <span :style="{ fontSize:'12px', fontWeight:'700', color: strategyStyle(strategy).color, minWidth:'80px' }">{{ strategy }}</span>
            <div style="display:flex;gap:6px;flex-wrap:wrap;">
              <span v-for="n in nums" :key="n"
                :style="{
                  width:'32px', height:'32px', borderRadius:'50%',
                  background:'rgba(0,0,0,0.3)', border:'1px solid rgba(255,255,255,0.1)',
                  display:'flex', alignItems:'center', justifyContent:'center',
                  fontSize:'12px', fontWeight:'700', fontFamily:'monospace', color:'#f1f5f9'
                }">
                {{ n.toString().padStart(2, '0') }}
              </span>
            </div>
          </div>
        </div>

        <!-- Risk warning -->
        <p v-if="latestPrediction.prediction.risk_warning" style="font-size:11px;color:#475569;margin-top:12px;font-style:italic;">
          ⚠️ {{ latestPrediction.prediction.risk_warning }}
        </p>
      </div>
    </div>

    <!-- Latest Draw Result -->
    <div v-if="latestDraw" style="background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.08);border-radius:20px;padding:20px;">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;">
        <h3 style="font-size:0.95rem;font-weight:700;color:#f1f5f9;display:flex;align-items:center;gap:8px;">
          <span>🏆</span> 最新開獎
        </h3>
        <span style="font-size:11px;color:#64748b;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.06);border-radius:100px;padding:3px 10px;">
          {{ latestDraw.date }} &nbsp;|&nbsp; 第 {{ latestDraw.draw_id }} 期
        </span>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;">
        <span v-for="n in latestDraw.numbers" :key="n"
          :style="{
            width:'40px', height:'40px', borderRadius:'50%',
            background: `linear-gradient(135deg, ${accent}22, ${accent}44)`,
            border: `2px solid ${accent}60`,
            display:'flex', alignItems:'center', justifyContent:'center',
            fontSize:'13px', fontWeight:'800', fontFamily:'monospace', color: accent
          }">
          {{ n.toString().padStart(2,'0') }}
        </span>
        <div v-if="latestDraw.special_number" style="display:flex;align-items:center;gap:6px;">
          <span style="color:#475569;font-size:12px;">特別號</span>
          <span style="width:40px;height:40px;border-radius:50%;background:rgba(251,191,36,0.12);border:2px solid rgba(251,191,36,0.5);display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:800;font-family:monospace;color:#fbbf24;">
            {{ latestDraw.special_number.toString().padStart(2,'0') }}
          </span>
        </div>
      </div>
    </div>
  </div>
</template>
