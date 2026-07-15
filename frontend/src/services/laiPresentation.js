const GROUP_LABELS = ['機率主攻', '覆蓋探索']

const STATUS_LABELS = {
  baseline: 'Baseline',
  champion: 'Champion',
  degraded: 'Degraded'
}

function copyNumberList(value) {
  if (!Array.isArray(value)) return []
  return value.filter((number) => Number.isInteger(number) && number > 0).slice()
}

function copyExpertWeights(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}

  return Object.fromEntries(
    Object.entries(value)
      .filter(([name, weight]) => name && Number.isFinite(weight) && weight >= 0)
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

  const combinations = prediction.combinations && typeof prediction.combinations === 'object'
    ? prediction.combinations
    : {}
  const specialCombinations = prediction.special_combinations && typeof prediction.special_combinations === 'object'
    ? prediction.special_combinations
    : {}
  const groups = GROUP_LABELS.map((label) => ({
    label,
    numbers: copyNumberList(combinations[label]),
    special: copyNumberList(specialCombinations[label])
  }))
  const fallbackMetrics = fallbackGroupMetrics(groups)
  const metrics = prediction.group_metrics && typeof prediction.group_metrics === 'object'
    ? prediction.group_metrics
    : {}

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
    overlapCount: Number.isInteger(metrics.overlap_count) && metrics.overlap_count >= 0
      ? metrics.overlap_count
      : fallbackMetrics.overlapCount,
    unionSize: Number.isInteger(metrics.union_size) && metrics.union_size >= 0
      ? metrics.union_size
      : fallbackMetrics.unionSize,
    expertWeights: copyExpertWeights(prediction.expert_weights)
  }
}
