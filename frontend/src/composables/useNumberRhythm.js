// 號碼節奏（心跳/遺漏）計算 — 單一真相來源。
// 由 IntervalAnalysis.vue 與 NumberEcgChart.vue 共用，避免重複掃描與邏輯漂移。
//
// 「即將開出指數 index」= 目前已隔期數 ÷ 該號平均間隔期數；數值越大代表越久沒開（相對越冷）。
// ⚠ 每期開獎為獨立事件，本模組屬描述性統計，index 高不代表下次更可能開出（賭徒謬誤）。

const DAY = 86400000

/**
 * @param {Array<{date:string, numbers:number[]}>} data 依時間排序（舊→新）的開獎陣列
 * @param {number} maxNumber 該彩種號碼上限
 * @returns {Array} 每個號碼一列，含節奏統計與每次開出的期序/日期（供 ECG 波形繪製）
 */
export function computeNumberRhythm(data, maxNumber) {
  if (!data || data.length === 0) return []

  const lastIndex = data.length - 1
  const lastDate = new Date(data[lastIndex].date)

  // 單次掃描：號碼 -> [出現的期序]
  const idxMap = {}
  for (let i = 0; i < data.length; i++) {
    for (const n of data[i].numbers) {
      (idxMap[n] || (idxMap[n] = [])).push(i)
    }
  }

  const rows = []
  for (let n = 1; n <= maxNumber; n++) {
    const idxs = idxMap[n] || []
    if (idxs.length === 0) {
      rows.push({
        num: n, appearances: 0, idxs: [], appearDates: [],
        avgDraw: 0, avgDay: 0, maxDraw: 0,
        curGapDraw: lastIndex, curGapDay: null, index: 99,
      })
      continue
    }
    const appearances = idxs.length

    // 期數間隔
    let sumDraw = 0, maxDraw = 0
    for (let k = 1; k < idxs.length; k++) {
      const d = idxs[k] - idxs[k - 1]
      sumDraw += d
      if (d > maxDraw) maxDraw = d
    }
    const avgDraw = appearances > 1 ? sumDraw / (appearances - 1) : data.length / appearances

    // 天數間隔
    const firstDate = new Date(data[idxs[0]].date)
    const lastAppDate = new Date(data[idxs[idxs.length - 1]].date)
    const avgDay = appearances > 1 ? (lastAppDate - firstDate) / DAY / (appearances - 1) : null

    const lastAppIdx = idxs[idxs.length - 1]
    const curGapDraw = lastIndex - lastAppIdx
    const curGapDay = Math.round((lastDate - lastAppDate) / DAY)
    const index = avgDraw > 0 ? curGapDraw / avgDraw : 0

    rows.push({
      num: n, appearances, idxs,
      appearDates: idxs.map((i) => data[i].date),
      avgDraw, avgDay, maxDraw, curGapDraw, curGapDay, index,
    })
  }
  return rows
}

// 依即將開出指數由高至低排序（不改原陣列）
export function sortByIndexDesc(rows) {
  return [...rows].sort((a, b) => b.index - a.index)
}

// 依 index 回傳色階（紅=久未開/最 overdue → 藍=剛開出）。與 IntervalAnalysis 既有色階一致。
export function indexColor(index) {
  if (index >= 2.0) return { bg: 'rgba(239,68,68,0.85)',  border: 'rgba(239,68,68,0.6)',  text: '#fff' }
  if (index >= 1.4) return { bg: 'rgba(249,115,22,0.80)', border: 'rgba(249,115,22,0.5)', text: '#fff' }
  if (index >= 1.0) return { bg: 'rgba(234,179,8,0.75)',  border: 'rgba(234,179,8,0.5)',  text: '#1c1917' }
  if (index >= 0.5) return { bg: 'rgba(34,197,94,0.55)',  border: 'rgba(34,197,94,0.4)',  text: '#fff' }
  return                   { bg: 'rgba(59,130,246,0.55)', border: 'rgba(59,130,246,0.4)', text: '#fff' }
}
