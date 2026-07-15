<script setup>
import { computed } from 'vue'
import { computeNumberRhythm, sortByIndexDesc, indexColor } from '../composables/useNumberRhythm'

const props = defineProps({
  gameName: { type: String, required: true },
  historyData: { type: Array, default: () => [] },
  maxNumber: { type: Number, default: 49 },
  accent: { type: String, default: '#2dd4bf' }
})

// 號碼遺漏/節奏分析改用共用 composable，避免與 NumberEcgChart 邏輯漂移。
// 即將開出指數 = 目前已隔期數 ÷ 平均間隔期數，數值越大代表越久沒開（相對越冷）。
const analysis = computed(() => computeNumberRhythm(props.historyData, props.maxNumber))

// 依即將開出指數由高至低排序
const sortedByIndex = computed(() => sortByIndexDesc(analysis.value))

// 即將開出候選：指數最高的前 8 名
const dueCandidates = computed(() => sortedByIndex.value.slice(0, 8))

// 依指數回傳色階（紅=久未開/最overdue → 藍=剛開出）
const indexStyle = indexColor

const fmt = (v, d = 1) => (v == null ? '—' : Number(v).toFixed(d))
</script>

<template>
  <div style="background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.07);border-radius:20px;padding:24px;">
    <!-- 標題 -->
    <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;margin-bottom:8px;">
      <h3 style="font-size:21px;font-weight:700;color:#f1f5f9;display:flex;align-items:center;gap:8px;">
        ⏳ 號碼遺漏分析
        <span style="font-size:16px;font-weight:400;color:#475569;">即將開出推估</span>
      </h3>
      <div style="display:flex;align-items:center;gap:10px;font-size:14px;color:#64748b;">
        <span style="display:flex;align-items:center;gap:4px;"><span style="width:10px;height:10px;border-radius:2px;background:#3b82f6;display:inline-block;"></span>剛開出</span>
        <span style="display:flex;align-items:center;gap:4px;"><span style="width:10px;height:10px;border-radius:2px;background:#eab308;display:inline-block;"></span>接近週期</span>
        <span style="display:flex;align-items:center;gap:4px;"><span style="width:10px;height:10px;border-radius:2px;background:#ef4444;display:inline-block;"></span>久未開出</span>
      </div>
    </div>
    <p style="font-size:15px;color:#64748b;line-height:1.6;margin-bottom:18px;">
      即將開出指數 = <span style="color:#94a3b8;">目前已隔期數 ÷ 該號平均間隔</span>，數值越高代表越久沒開、相對越「冷」。
    </p>

    <!-- 即將開出候選 Top 8 -->
    <div style="margin-bottom:22px;">
      <h4 style="font-size:18px;font-weight:600;color:#cbd5e1;margin-bottom:14px;">🎯 即將開出候選（指數 Top 8）</h4>
      <div class="due-candidate-grid">
        <div v-for="item in dueCandidates" :key="item.num"
          :style="{
            background: indexStyle(item.index).bg,
            border: `1px solid ${indexStyle(item.index).border}`,
            borderRadius:'14px', padding:'18px 12px',
            display:'flex', flexDirection:'column', alignItems:'center', gap:'7px'
          }">
          <span :style="{ fontSize:'40px', fontWeight:'900', fontFamily:'monospace', lineHeight:'1', color: indexStyle(item.index).text }">
            {{ item.num.toString().padStart(2,'0') }}
          </span>
          <span :style="{ fontSize:'18px', fontWeight:'700', color: indexStyle(item.index).text, opacity:0.95 }">
            指數 {{ fmt(item.index, 2) }}
          </span>
          <span :style="{ fontSize:'16px', color: indexStyle(item.index).text, opacity:0.85 }">
            已隔 {{ item.curGapDay }} 天
          </span>
          <span :style="{ fontSize:'15px', color: indexStyle(item.index).text, opacity:0.75 }">
            均 {{ fmt(item.avgDay, 0) }} 天 / {{ fmt(item.avgDraw, 1) }} 期
          </span>
        </div>
      </div>
    </div>

    <!-- 全部號碼遺漏表（依指數排序） -->
    <h4 style="font-size:18px;font-weight:600;color:#cbd5e1;margin-bottom:14px;">全部號碼遺漏指數（高 → 低）</h4>
    <div style="display:grid;gap:6px;" :style="{ gridTemplateColumns: `repeat(${maxNumber <= 39 ? 8 : 10}, 1fr)` }">
      <div v-for="item in sortedByIndex" :key="item.num" class="interval-cell"
        :title="`號碼 ${item.num}｜已隔 ${item.curGapDraw} 期 / ${item.curGapDay} 天｜平均間隔 ${fmt(item.avgDraw,1)} 期 / ${fmt(item.avgDay,1)} 天｜最大遺漏 ${item.maxDraw} 期｜出現 ${item.appearances} 次｜指數 ${fmt(item.index,2)}`"
        :style="{
          background: indexStyle(item.index).bg,
          border: `1px solid ${indexStyle(item.index).border}`,
          borderRadius:'10px', padding:'12px 2px',
          display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center',
          cursor:'default', transition:'transform 0.15s'
        }"
        @mouseenter="e => e.currentTarget.style.transform='scale(1.12)'"
        @mouseleave="e => e.currentTarget.style.transform='scale(1)'"
      >
        <span class="interval-number" :style="{ color: indexStyle(item.index).text }">
          {{ item.num.toString().padStart(2,'0') }}
        </span>
        <span class="interval-gap" :style="{ color: indexStyle(item.index).text }">
          {{ item.curGapDraw }}期
        </span>
      </div>
    </div>

    <!-- 免責說明 -->
    <p style="font-size:12px;color:#475569;line-height:1.6;margin-top:18px;padding-top:14px;border-top:1px solid rgba(255,255,255,0.05);">
      ⚠️ 注意：每期開獎在統計上為獨立事件，「久未開出」在數學上並不會提高下次開出的真實機率（賭徒謬誤）。本分析屬描述性統計，僅供參考娛樂，請理性購彩。
    </p>
  </div>
</template>

<style scoped>
.due-candidate-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 12px;
}

.interval-cell {
  min-width: 0;
  overflow: hidden;
}

.interval-number {
  font-family: monospace;
  font-size: 26px;
  font-weight: 800;
  line-height: 1.1;
}

.interval-gap {
  font-size: 17px;
  line-height: 1.2;
  opacity: 0.85;
}

@media (max-width: 640px) {
  .due-candidate-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .interval-number { font-size: 16px; }
  .interval-gap { font-size: 11px; }
}
</style>
