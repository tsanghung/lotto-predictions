<script setup>
import { computed, ref } from 'vue'
import { computeNumberRhythm, sortByIndexDesc, indexColor } from '../composables/useNumberRhythm'

const props = defineProps({
  gameName: { type: String, required: true },
  historyData: { type: Array, default: () => [] },
  maxNumber: { type: Number, default: 49 },
})

// 心電圖時間視窗：取最近 W 期作為 x 軸（讓各彩種脈衝密度接近、視覺可讀）。
const WINDOW = computed(() => Math.min(props.historyData.length, 90))
const startIdx = computed(() => Math.max(0, props.historyData.length - WINDOW.value))

const rows = computed(() => sortByIndexDesc(computeNumberRhythm(props.historyData, props.maxNumber)))

const showAll = ref(false)
const visibleRows = computed(() => (showAll.value ? rows.value : rows.value.slice(0, 12)))

const expanded = ref(null) // 展開單號詳圖的號碼
const toggle = (num) => { expanded.value = expanded.value === num ? null : num }

const fmt = (v, d = 1) => (v == null ? '—' : Number(v).toFixed(d))

// 把某號在視窗內的出現期序，映射成 SVG x 座標
function appearanceXs(row, width) {
  const start = startIdx.value
  const span = props.historyData.length - 1 - start || 1
  return row.idxs.filter((i) => i >= start).map((i) => ((i - start) / span) * width)
}

// 產生「心電圖」路徑：平線基準 + 每次開出一個 QRS 尖峰；最後一次開出到右緣(現在)保持平線，
// 平線尾巴越長 = 越久沒開(overdue 越高越「該跳了」)。
function ecgPath(row, width, height) {
  const base = height * 0.62
  const amp = height * 0.46
  const xs = appearanceXs(row, width)
  let d = `M 0 ${base}`
  let cursor = 0
  for (const x of xs) {
    const s = Math.max(cursor, x - 7)
    d += ` L ${s.toFixed(1)} ${base}` +          // 走到尖峰前
      ` L ${(x - 4).toFixed(1)} ${(base + amp * 0.16).toFixed(1)}` + // 小 Q 下沉
      ` L ${x.toFixed(1)} ${(base - amp).toFixed(1)}` +               // R 高峰
      ` L ${(x + 4).toFixed(1)} ${(base + amp * 0.22).toFixed(1)}` +  // S 下沉
      ` L ${(x + 7).toFixed(1)} ${base}`                              // 回基準
    cursor = x + 7
  }
  d += ` L ${width} ${base}` // 尾巴平線到現在
  return d
}
</script>

<template>
  <div class="card">
    <!-- 標題 + 說明 -->
    <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;margin-bottom:6px;">
      <h3 style="font-size:1.25rem;font-weight:700;color:var(--text);display:flex;align-items:center;gap:8px;">
        💓 號碼心電圖
        <span style="font-size:0.9rem;font-weight:400;color:var(--text-faint);">每個號碼的開出節奏波形</span>
      </h3>
      <div style="display:flex;align-items:center;gap:12px;font-size:0.8rem;color:var(--text-mute);">
        <span style="display:flex;align-items:center;gap:4px;"><span style="width:10px;height:10px;border-radius:2px;background:#3b82f6;"></span>剛開出</span>
        <span style="display:flex;align-items:center;gap:4px;"><span style="width:10px;height:10px;border-radius:2px;background:#eab308;"></span>接近週期</span>
        <span style="display:flex;align-items:center;gap:4px;"><span style="width:10px;height:10px;border-radius:2px;background:#ef4444;"></span>久未開出</span>
      </div>
    </div>
    <p style="font-size:0.9rem;color:var(--text-mute);line-height:1.6;margin-bottom:18px;">
      每一次開出畫成一個心跳脈衝（近 {{ WINDOW }} 期）。最後一個脈衝到右緣的<strong style="color:var(--text-dim);">平線尾巴越長</strong>，
      代表該號越久沒開；<strong style="color:var(--text-dim);">overdue 比 = 已隔期數 ÷ 自身平均間隔</strong>。依 overdue 由高到低排序。
    </p>

    <!-- 心電圖列表 -->
    <div style="display:flex;flex-direction:column;gap:8px;">
      <div v-for="row in visibleRows" :key="row.num">
        <!-- 單列 -->
        <div
          @click="toggle(row.num)"
          :style="{
            display:'flex', alignItems:'center', gap:'12px',
            background:'var(--surface-2)', border:'1px solid var(--border-soft)',
            borderRadius:'var(--radius-sm)', padding:'8px 12px', cursor:'pointer'
          }">
          <span :style="{
            flexShrink:0, width:'38px', height:'38px', borderRadius:'50%',
            background: indexColor(row.index).bg, border:`1px solid ${indexColor(row.index).border}`,
            display:'flex', alignItems:'center', justifyContent:'center',
            fontFamily:'var(--mono)', fontWeight:800, fontSize:'1.05rem', color: indexColor(row.index).text
          }">{{ row.num.toString().padStart(2, '0') }}</span>

          <!-- ECG 波形 -->
          <svg viewBox="0 0 320 44" preserveAspectRatio="none" style="flex:1;height:44px;min-width:0;overflow:visible;">
            <line x1="0" y1="27.3" x2="320" y2="27.3" stroke="rgba(255,255,255,0.06)" stroke-width="1" />
            <path :d="ecgPath(row, 320, 44)" fill="none" :stroke="indexColor(row.index).bg"
              stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round" />
            <!-- 「現在」標記 -->
            <line x1="319" y1="6" x2="319" y2="40" :stroke="indexColor(row.index).border" stroke-width="1.5" stroke-dasharray="2 2" />
          </svg>

          <div style="flex-shrink:0;display:flex;flex-direction:column;align-items:flex-end;gap:1px;min-width:96px;">
            <span :style="{ fontFamily:'var(--mono)', fontWeight:700, fontSize:'0.95rem', color: indexColor(row.index).bg }">
              overdue {{ fmt(row.index, 2) }}×
            </span>
            <span class="stat" style="font-size:0.78rem;">已隔 {{ row.curGapDay ?? '—' }} 天 / 均 {{ fmt(row.avgDay, 0) }} 天</span>
          </div>
        </div>

        <!-- 展開：單號詳圖 -->
        <div v-if="expanded === row.num"
          style="background:var(--surface-2);border:1px solid var(--border-soft);border-top:none;border-radius:0 0 var(--radius-sm) var(--radius-sm);padding:16px;margin-top:-6px;">
          <svg viewBox="0 0 640 90" preserveAspectRatio="none" style="width:100%;height:90px;overflow:visible;margin-bottom:12px;">
            <line x1="0" y1="55.8" x2="640" y2="55.8" stroke="rgba(255,255,255,0.06)" stroke-width="1" />
            <path :d="ecgPath(row, 640, 90)" fill="none" :stroke="indexColor(row.index).bg"
              stroke-width="2" stroke-linejoin="round" stroke-linecap="round" />
            <line x1="638" y1="10" x2="638" y2="82" :stroke="indexColor(row.index).border" stroke-width="1.5" stroke-dasharray="3 3" />
          </svg>
          <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(110px,1fr));gap:10px;font-size:0.85rem;">
            <div><span class="stat" style="display:block;font-size:1.2rem;color:var(--text);">{{ row.appearances }}</span><span style="color:var(--text-mute);">近全期出現</span></div>
            <div><span class="stat" style="display:block;font-size:1.2rem;color:var(--text);">{{ fmt(row.avgDay, 0) }} 天</span><span style="color:var(--text-mute);">平均間隔</span></div>
            <div><span class="stat" style="display:block;font-size:1.2rem;color:var(--text);">{{ row.curGapDay ?? '—' }} 天</span><span style="color:var(--text-mute);">目前已隔</span></div>
            <div><span class="stat" style="display:block;font-size:1.2rem;color:var(--text);">{{ row.maxDraw }} 期</span><span style="color:var(--text-mute);">最大遺漏</span></div>
            <div><span class="stat" style="display:block;font-size:1.2rem;color:var(--text);">{{ fmt(row.index, 2) }}×</span><span style="color:var(--text-mute);">overdue 比</span></div>
          </div>
        </div>
      </div>
    </div>

    <!-- 展開全部 -->
    <button v-if="rows.length > 12" @click="showAll = !showAll"
      style="margin-top:14px;width:100%;background:var(--surface-3);border:1px solid var(--border);border-radius:var(--radius-sm);padding:9px;color:var(--text-dim);font-size:0.85rem;cursor:pointer;font-family:inherit;">
      {{ showAll ? '收合' : `展開全部 ${rows.length} 個號碼` }}
    </button>

    <!-- 免責 -->
    <p class="disclaimer" style="margin-top:16px;padding-top:14px;border-top:1px solid var(--border-soft);">
      ⚠️ 公正抽獎是「無記憶」過程，「久未開出」在數學上並不會提高下次開出的真實機率（賭徒謬誤）。
      本圖屬描述性統計，僅供節奏對照與娛樂參考，不提高中獎機率，請理性購彩。
    </p>
  </div>
</template>
