const GROUP_LABELS = ['機率主攻', '覆蓋探索']

const STATUS_LABELS = {
  baseline: 'Baseline',
  champion: 'Champion',
  degraded: 'Degraded'
}

const GAME_LIMITS = {
  '今彩539': { max: 39, picks: 5 },
  '大樂透': { max: 49, picks: 6 },
  '威力彩': { max: 38, picks: 6, specialMax: 8, specialPicks: 1 }
}

function copyNumberList(value, max = Number.POSITIVE_INFINITY, picks = Number.POSITIVE_INFINITY) {
  if (!Array.isArray(value)) return []
  return [...new Set(value.filter((number) => (
    Number.isInteger(number) && number > 0 && number <= max
  )))].slice(0, picks)
}

function copyExpertWeights(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}

  return Object.fromEntries(
    Object.entries(value)
      .filter(([name, weight]) => name && Number.isFinite(weight) && weight >= 0 && weight <= 1)
      .map(([name, weight]) => [name, weight])
  )
}

function fallbackGroupMetrics(groups) {
  const first = new Set(groups[0]?.numbers || [])
  const second = new Set(groups[1]?.numbers || [])
  const overlapCount = [...first].filter((number) => second.has(number)).length

  return {
    overlapCount,
    unionSize: new Set([...first, ...second]).size
  }
}

export function isLaiPredictionRecord(record) {
  return Boolean(record?.prediction && typeof record.prediction === 'object' && record.prediction.model === 'lai-v2')
}

export function toLaiViewModel(record) {
  if (!isLaiPredictionRecord(record)) {
    return null
  }
  const prediction = record.prediction
  const limits = GAME_LIMITS[record.game_name] || {}

  const combinations = prediction.combinations && typeof prediction.combinations === 'object'
    ? prediction.combinations
    : {}
  const specialCombinations = prediction.special_combinations && typeof prediction.special_combinations === 'object'
    ? prediction.special_combinations
    : {}
  const groups = GROUP_LABELS.map((label) => ({
    label,
    numbers: copyNumberList(combinations[label], limits.max, limits.picks),
    special: copyNumberList(specialCombinations[label], limits.specialMax, limits.specialPicks)
  }))
  const fallbackMetrics = fallbackGroupMetrics(groups)

  return {
    version: 'LAI v2',
    status: STATUS_LABELS[prediction.agent_status] || 'Degraded',
    statusCode: Object.hasOwn(STATUS_LABELS, prediction.agent_status)
      ? prediction.agent_status
      : 'degraded',
    stateVersion: Number.isInteger(prediction.agent_state_version)
      ? prediction.agent_state_version
      : null,
    lastLearnedDate: prediction.evidence?.last_learned_draw_date || null,
    provenAboveRandom: prediction.evidence?.proven_above_random === true,
    targetDrawDate: record.target_draw_date || prediction.evidence?.target_draw_date || null,
    generatedAt: record.timestamp || record.predicted_at || null,
    groups,
    overlapCount: fallbackMetrics.overlapCount,
    unionSize: fallbackMetrics.unionSize,
    expertWeights: copyExpertWeights(prediction.expert_weights)
  }
}
