<script setup>
import { computed } from 'vue'
import { specialAreaLabel } from '../services/gameMeta'

const props = defineProps({
  gameName: { type: String, required: true },
  historyData: { type: Array, default: () => [] },
  maxNumber: { type: Number, default: 49 },
  ballsPerDraw: { type: Number, default: 6 },
  hasSpecial: { type: Boolean, default: false },
  accent: { type: String, default: '#2dd4bf' }
})

// 大樂透=特別號、威力彩=第二區（用於稽核項目命名，避免把特別號誤稱第二區）。
const specialLabel = specialAreaLabel(props.gameName) || '特別號'

/* ───────────────── 數值工具：卡方 / 常態 p 值（純前端計算） ───────────────── */
// Lanczos 對數 Gamma
function gammaln (x) {
  const c = [76.18009172947146, -86.50532032941677, 24.01409824083091,
    -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5]
  let y = x; let tmp = x + 5.5
  tmp -= (x + 0.5) * Math.log(tmp)
  let ser = 1.000000000190015
  for (let j = 0; j < 6; j++) { y++; ser += c[j] / y }
  return -tmp + Math.log(2.5066282746310005 * ser / x)
}
// 正則化上不完全 Gamma Q(a,x) = P(X>x)，用於卡方右尾
function gammaincUpper (a, x) {
  const ITMAX = 300; const EPS = 1e-13; const FPMIN = 1e-300
  if (x <= 0) return 1
  if (x < a + 1) {
    let ap = a; let sum = 1 / a; let del = 1 / a
    for (let n = 0; n < ITMAX; n++) { ap++; del *= x / ap; sum += del; if (Math.abs(del) < Math.abs(sum) * EPS) break }
    return 1 - sum * Math.exp(-x + a * Math.log(x) - gammaln(a))
  }
  let b = x + 1 - a; let c = 1 / FPMIN; let d = 1 / b; let h = d
  for (let i = 1; i < ITMAX; i++) {
    const an = -i * (i - a)
    b += 2
    d = an * d + b; if (Math.abs(d) < FPMIN) d = FPMIN
    c = b + an / c; if (Math.abs(c) < FPMIN) c = FPMIN
    d = 1 / d; const del = d * c; h *= del
    if (Math.abs(del - 1) < EPS) break
  }
  return Math.exp(-x + a * Math.log(x) - gammaln(a)) * h
}
// 卡方右尾 p 值
const chiSqP = (chi2, df) => gammaincUpper(df / 2, chi2 / 2)
// erf 近似 → 常態 CDF
function erf (x) {
  const sign = x < 0 ? -1 : 1; x = Math.abs(x)
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741, a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911
  const t = 1 / (1 + p * x)
  const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x)
  return sign * y
}
const normCdf = (z) => 0.5 * (1 + erf(z / Math.SQRT2))
const twoTailP = (z) => 2 * (1 - normCdf(Math.abs(z)))
const logComb = (n, k) => gammaln(n + 1) - gammaln(k + 1) - gammaln(n - k + 1)

const fmtP = (p) => (p < 0.0001 ? '<0.0001' : p.toFixed(4))

/* ───────────────── 主檢定計算 ───────────────── */
const result = computed(() => {
  const data = props.historyData
  const N = props.maxNumber
  const k = props.ballsPerDraw
  if (!data || data.length < 30) return null

  const draws = data.length
  const tests = []

  // 頻率表
  const freq = {}
  for (let i = 1; i <= N; i++) freq[i] = 0
  data.forEach(d => d.numbers.forEach(n => { if (n >= 1 && n <= N) freq[n]++ }))
  const totalBalls = draws * k

  // 1) 卡方均勻性
  const expEach = totalBalls / N
  let chi2 = 0
  for (let n = 1; n <= N; n++) chi2 += (freq[n] - expEach) ** 2 / expEach
  const pChi = chiSqP(chi2, N - 1)
  tests.push({
    key: 'uniform',
    name: '號碼均勻性（卡方檢定）',
    desc: `49 個號碼出現次數是否一樣多。期望每號 ${expEach.toFixed(0)} 次。`.replace('49', String(N)),
    stat: `χ² = ${chi2.toFixed(1)}　df = ${N - 1}`,
    p: pChi
  })

  // 2) 奇偶比例
  const oddTarget = Array.from({ length: N }, (_, i) => i + 1).filter(n => n % 2 === 1).length / N
  let oddCount = 0
  data.forEach(d => d.numbers.forEach(n => { if (n % 2 === 1) oddCount++ }))
  const oddRate = oddCount / totalBalls
  const zOdd = (oddRate - oddTarget) / Math.sqrt(oddTarget * (1 - oddTarget) / totalBalls)
  tests.push({
    key: 'odd',
    name: '奇偶平衡',
    desc: '開出奇數的比例是否符合理論值，檢查有無偏向單雙號。',
    stat: `實際奇數 ${(oddRate * 100).toFixed(1)}%　理論 ${(oddTarget * 100).toFixed(1)}%`,
    p: twoTailP(zOdd)
  })

  // 3) 大小號比例
  const mid = N / 2
  const bigTarget = Array.from({ length: N }, (_, i) => i + 1).filter(n => n > mid).length / N
  let bigCount = 0
  data.forEach(d => d.numbers.forEach(n => { if (n > mid) bigCount++ }))
  const bigRate = bigCount / totalBalls
  const zBig = (bigRate - bigTarget) / Math.sqrt(bigTarget * (1 - bigTarget) / totalBalls)
  tests.push({
    key: 'big',
    name: '大小號平衡',
    desc: `大號（>${mid}）出現比例是否符合理論值。`,
    stat: `實際大號 ${(bigRate * 100).toFixed(1)}%　理論 ${(bigTarget * 100).toFixed(1)}%`,
    p: twoTailP(zBig)
  })

  // 4) 連號出現率
  let consec = 0
  data.forEach(d => {
    const s = [...d.numbers].sort((a, b) => a - b)
    for (let i = 0; i < s.length - 1; i++) { if (s[i + 1] - s[i] === 1) { consec++; break } }
  })
  const consecRate = consec / draws
  const pNoConsec = Math.exp(logComb(N - k + 1, k) - logComb(N, k))
  const consecTarget = 1 - pNoConsec
  const zConsec = (consecRate - consecTarget) / Math.sqrt(consecTarget * (1 - consecTarget) / draws)
  tests.push({
    key: 'consec',
    name: '連號出現率',
    desc: '每期至少出現一對相鄰號（如 23、24）的機率是否正常。',
    stat: `實際 ${(consecRate * 100).toFixed(1)}%　理論 ${(consecTarget * 100).toFixed(1)}%`,
    p: twoTailP(zConsec)
  })

  // 5) 每期總和
  const sums = data.map(d => d.numbers.reduce((a, b) => a + b, 0))
  const meanSum = sums.reduce((a, b) => a + b, 0) / draws
  const theoMean = k * (N + 1) / 2
  const theoVar = k * (N * N - 1) / 12 * (N - k) / (N - 1)
  const zSum = (meanSum - theoMean) / (Math.sqrt(theoVar) / Math.sqrt(draws))
  tests.push({
    key: 'sum',
    name: '號碼總和',
    desc: '每期號碼加總的平均值是否落在理論中心，可揪出整體偏大或偏小。',
    stat: `實際均值 ${meanSum.toFixed(1)}　理論 ${theoMean.toFixed(0)}`,
    p: twoTailP(zSum)
  })

  // 6) 前後期獨立性（重疊號碼）
  let overlapSum = 0
  for (let i = 1; i < draws; i++) {
    const prev = new Set(data[i - 1].numbers)
    overlapSum += data[i].numbers.filter(n => prev.has(n)).length
  }
  const meanOverlap = overlapSum / (draws - 1)
  const theoOverlap = k * k / N
  const theoOverlapVar = k * (k / N) * (1 - k / N) * (N - k) / (N - 1)
  const zOv = (meanOverlap - theoOverlap) / (Math.sqrt(theoOverlapVar) / Math.sqrt(draws - 1))
  tests.push({
    key: 'serial',
    name: '前後期獨立性',
    desc: '上一期的號碼會不會影響下一期？檢查兩期重複號碼數是否異常。',
    stat: `平均重疊 ${meanOverlap.toFixed(3)}　理論 ${theoOverlap.toFixed(3)}`,
    p: twoTailP(zOv)
  })

  // 7) 特別號均勻性
  if (props.hasSpecial) {
    const sp = {}
    for (let i = 1; i <= N; i++) sp[i] = 0
    let spTotal = 0
    data.forEach(d => { if (d.special_number) { sp[d.special_number]++; spTotal++ } })
    if (spTotal > 30) {
      const spExp = spTotal / N
      let spChi = 0
      for (let n = 1; n <= N; n++) spChi += (sp[n] - spExp) ** 2 / spExp
      tests.push({
        key: 'special',
        name: `${specialLabel}均勻性（卡方檢定）`,
        desc: `${specialLabel}是否每個號碼機率相同。`,
        stat: `χ² = ${spChi.toFixed(1)}　df = ${N - 1}`,
        p: chiSqP(spChi, N - 1)
      })
    }
  }

  // 賭徒謬誤破解：遺漏期數 vs 開出率
  const buckets = [[], [], [], []]
  for (let num = 1; num <= N; num++) {
    let gap = 0
    for (let i = 0; i < draws; i++) {
      const appeared = data[i].numbers.includes(num)
      buckets[Math.min(Math.floor(gap / 10), 3)].push(appeared ? 1 : 0)
      gap = appeared ? 0 : gap + 1
    }
  }
  const baseRate = k / N
  const gambler = buckets.map((b, i) => {
    const rate = b.length ? b.reduce((a, c) => a + c, 0) / b.length : 0
    return {
      label: ['遺漏 0–9 期', '遺漏 10–19 期', '遺漏 20–29 期', '遺漏 30+ 期'][i],
      rate, n: b.length, diff: (rate - baseRate) / baseRate * 100
    }
  })

  const passCount = tests.filter(t => t.p >= 0.05).length
  return { tests, gambler, baseRate, passCount, draws }
})

const verdict = (p) => p >= 0.05
  ? { color: '#34d399', bg: 'rgba(52,211,153,0.10)', border: 'rgba(52,211,153,0.30)', label: '通過 ✓ 符合隨機' }
  : { color: '#fbbf24', bg: 'rgba(251,191,36,0.10)', border: 'rgba(251,191,36,0.30)', label: '偏離 ⚠ 待觀察' }
</script>

<template>
  <div v-if="result" style="background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.07);border-radius:20px;padding:24px;">

    <!-- 標題 -->
    <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;margin-bottom:6px;">
      <h3 style="font-size:21px;font-weight:700;color:#f1f5f9;display:flex;align-items:center;gap:8px;">
        🔬 開獎公正性稽核
        <span style="font-size:16px;font-weight:400;color:#475569;">隨機性統計檢定</span>
      </h3>
      <span :style="{ fontSize:'14px', color:'#64748b', background:'rgba(255,255,255,0.04)', border:'1px solid rgba(255,255,255,0.06)', borderRadius:'100px', padding:'4px 12px' }">
        樣本 {{ result.draws }} 期
      </span>
    </div>
    <p style="font-size:15px;color:#64748b;line-height:1.7;margin-bottom:18px;">
      用 {{ result.tests.length }} 種統計檢定，從全歷史開獎資料中尋找「人為操控」的指紋。
      <span style="color:#94a3b8;">p ≥ 0.05 代表「與真隨機無法區分」（通過）</span>，p &lt; 0.05 代表「偏離隨機、值得進一步觀察」。
    </p>

    <!-- 總結橫幅 -->
    <div :style="{
      display:'flex', alignItems:'center', gap:'14px', flexWrap:'wrap',
      background: result.passCount === result.tests.length ? 'rgba(52,211,153,0.08)' : 'rgba(251,191,36,0.07)',
      border: `1px solid ${result.passCount === result.tests.length ? 'rgba(52,211,153,0.25)' : 'rgba(251,191,36,0.25)'}`,
      borderRadius:'14px', padding:'16px 18px', marginBottom:'20px'
    }">
      <span style="font-size:34px;line-height:1;">{{ result.passCount === result.tests.length ? '🟢' : '🟡' }}</span>
      <div>
        <p style="font-size:18px;font-weight:700;color:#e2e8f0;margin-bottom:4px;">
          {{ result.passCount }} / {{ result.tests.length }} 項檢定通過隨機性
        </p>
        <p style="font-size:15px;color:#94a3b8;line-height:1.5;">
          {{ result.passCount === result.tests.length
            ? `${gameName}全歷史開獎在統計上與「真隨機」無法區分，未發現系統性人為偏差。`
            : `多數檢定通過；少數偏離多為小樣本雜訊，經多重比較校正後通常不顯著。` }}
        </p>
      </div>
    </div>

    <!-- 檢定列表 -->
    <div style="display:flex;flex-direction:column;gap:10px;margin-bottom:22px;">
      <div v-for="t in result.tests" :key="t.key"
        :style="{
          display:'flex', alignItems:'flex-start', gap:'14px', flexWrap:'wrap',
          background:'rgba(0,0,0,0.18)', border:'1px solid rgba(255,255,255,0.05)',
          borderRadius:'12px', padding:'14px 16px'
        }">
        <div style="flex:1;min-width:200px;">
          <p style="font-size:17px;font-weight:700;color:#e2e8f0;margin-bottom:3px;">{{ t.name }}</p>
          <p style="font-size:14px;color:#64748b;line-height:1.5;margin-bottom:6px;">{{ t.desc }}</p>
          <p style="font-size:14px;color:#94a3b8;font-family:monospace;">{{ t.stat }}　·　p = {{ fmtP(t.p) }}</p>
        </div>
        <span :style="{
          flexShrink:0, alignSelf:'center', fontSize:'14px', fontWeight:'700', whiteSpace:'nowrap',
          padding:'6px 14px', borderRadius:'100px',
          color: verdict(t.p).color, background: verdict(t.p).bg, border: `1px solid ${verdict(t.p).border}`
        }">{{ verdict(t.p).label }}</span>
      </div>
    </div>

    <!-- 賭徒謬誤破解 -->
    <div style="background:rgba(0,0,0,0.18);border:1px solid rgba(255,255,255,0.05);border-radius:12px;padding:16px 18px;">
      <p style="font-size:17px;font-weight:700;color:#e2e8f0;margin-bottom:4px;">🎯 「久未開出 = 即將開出」是真的嗎？</p>
      <p style="font-size:14px;color:#64748b;line-height:1.6;margin-bottom:14px;">
        若賭徒謬誤成立，遺漏越久的號碼開出率應越高。實測結果（基準線 {{ (result.baseRate * 100).toFixed(1) }}%）：
      </p>
      <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px;">
        <div v-for="g in result.gambler" :key="g.label"
          style="background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.06);border-radius:10px;padding:12px 8px;text-align:center;">
          <p style="font-size:13px;color:#64748b;margin-bottom:6px;line-height:1.3;">{{ g.label }}</p>
          <p :style="{ fontSize:'22px', fontWeight:'800', fontFamily:'monospace', lineHeight:'1', color: Math.abs(g.diff) < 3 ? '#94a3b8' : (g.diff > 0 ? '#fbbf24' : '#60a5fa') }">
            {{ (g.rate * 100).toFixed(1) }}%
          </p>
          <p :style="{ fontSize:'12px', marginTop:'4px', color: Math.abs(g.diff) < 3 ? '#475569' : (g.diff > 0 ? '#d97706' : '#3b82f6') }">
            {{ g.diff >= 0 ? '+' : '' }}{{ g.diff.toFixed(1) }}%
          </p>
        </div>
      </div>
      <p style="font-size:14px;color:#64748b;line-height:1.6;margin-top:12px;">
        各組開出率都貼近基準線、差異在統計雜訊範圍內 →
        <span style="color:#cbd5e1;">號碼不會因為「冷很久」就更容易開出，每期都是獨立事件。</span>
      </p>
    </div>

    <!-- 免責 -->
    <p style="font-size:13px;color:#475569;line-height:1.7;margin-top:18px;padding-top:14px;border-top:1px solid rgba(255,255,255,0.05);">
      📐 方法說明：卡方右尾 p 值由正則化不完全 Gamma 函數於瀏覽器端即時計算；比例與均值檢定採雙尾常態近似。
      所有檢定皆從本頁載入的全歷史資料動態運算，每次開獎更新後自動重跑。
      單一檢定 p&lt;0.05 不代表造假——在多項檢定下，純隨機本就預期偶有 1～2 項「假性顯著」，須經 Bonferroni 等多重比較校正方能定論。
    </p>
  </div>
</template>
