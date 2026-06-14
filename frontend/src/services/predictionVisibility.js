export function predictionVisibleAtTaipei(prediction, now = new Date()) {
  const targetDrawDate = prediction?.target_draw_date
  if (!targetDrawDate) {
    return true
  }

  const visibleAt = new Date(`${targetDrawDate}T10:00:00+08:00`)
  return now.getTime() >= visibleAt.getTime()
}

export function filterVisiblePredictions(predictions, now = new Date()) {
  return predictions.filter((prediction) => predictionVisibleAtTaipei(prediction, now))
}
