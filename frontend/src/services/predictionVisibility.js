export function predictionVisibleAtTaipei(prediction, now = new Date()) {
  const targetDrawDate = prediction?.target_draw_date
  if (!targetDrawDate) {
    return true
  }

  const visibleAt = new Date(`${targetDrawDate}T10:00:00+08:00`)
  return now.getTime() >= visibleAt.getTime()
}

export function predictionHasDetailedInsight(prediction) {
  const payload = prediction?.prediction || {}
  const reasoning = String(payload.reasoning || '').trim()
  const insights = payload.number_insights || {}
  const selectedNumbers = insights.selected_numbers || insights
  const hasNumberReasons = Object.entries(selectedNumbers).some(([num, info]) =>
    Number.isInteger(Number(num)) && info && typeof info.reason === 'string' && info.reason.trim()
  )

  if (hasNumberReasons) {
    return true
  }

  const isGenericFallback = reasoning === '依最近 30 期開獎頻率、遺漏期數與平均和值產生三組推薦。此模型為統計輔助，不保證命中。'
  if (isGenericFallback) {
    return false
  }

  return reasoning.length >= 80
}

export function filterVisiblePredictions(predictions, now = new Date()) {
  return predictions.filter((prediction) => predictionVisibleAtTaipei(prediction, now))
}
