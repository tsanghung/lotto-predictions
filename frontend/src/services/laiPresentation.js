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

export function toLaiLearningView(record) {
  const report = record?.raw_learning_report?.lai || record?.evaluation?.learning_report?.lai
  if (!report || typeof report !== 'object' || Array.isArray(report)) return null

  const weightChanges = Array.isArray(report.weight_changes)
    ? report.weight_changes
      .filter((row) => (
        row && typeof row.model === 'string' && row.model &&
        Number.isFinite(row.before) && Number.isFinite(row.after)
      ))
      .map((row) => ({
        model: row.model,
        before: row.before,
        after: row.after,
        delta: Number((row.after - row.before).toFixed(12))
      }))
    : []
  const coverage = report.coverage && typeof report.coverage === 'object'
    ? report.coverage
    : {}

  return {
    drawDate: record.target_draw_date || record.draw_date || null,
    stateVersion: Number.isInteger(report.state_version) ? report.state_version : null,
    agentStatus: typeof report.agent_status === 'string' ? report.agent_status : null,
    weightChanges,
    championChanged: typeof report.champion_changed === 'boolean' ? report.champion_changed : null,
    previousChampionModel: typeof report.previous_champion_model === 'string'
      ? report.previous_champion_model
      : null,
    championModel: typeof report.champion_model === 'string' ? report.champion_model : null,
    brierSkillScore: Number.isFinite(report.brier_skill_score) ? report.brier_skill_score : null,
    unionHits: Number.isInteger(coverage.union_hits) && coverage.union_hits >= 0
      ? coverage.union_hits
      : null,
    unionSize: Number.isInteger(coverage.union_size) && coverage.union_size >= 0
      ? coverage.union_size
      : null,
    overlapCount: Number.isInteger(coverage.overlap_count) && coverage.overlap_count >= 0
      ? coverage.overlap_count
      : null,
    limitation: '單期結果只能更新量化損失，不能證明特定號碼具有因果規律。'
  }
}

export function toLaiPerformanceView(gamePerformance) {
  const lai = gamePerformance?.lai
  if (!lai || typeof lai !== 'object' || Array.isArray(lai)) return null
  return {
    brierSkillScore: Number.isFinite(lai.brier_skill_score) ? lai.brier_skill_score : null,
    unionCoverageRate: Number.isFinite(lai.union_coverage_rate) &&
      lai.union_coverage_rate >= 0 && lai.union_coverage_rate <= 1
      ? lai.union_coverage_rate
      : null,
    averageGroupAHits: Number.isFinite(lai.average_group_a_hits) && lai.average_group_a_hits >= 0
      ? lai.average_group_a_hits
      : null,
    averageGroupBHits: Number.isFinite(lai.average_group_b_hits) && lai.average_group_b_hits >= 0
      ? lai.average_group_b_hits
      : null,
    championModel: typeof lai.champion_model === 'string' ? lai.champion_model : null,
    agentStatus: typeof lai.agent_status === 'string' ? lai.agent_status : null,
    limitation: 'Brier Skill Score 大於 0 代表此評估區間優於均勻隨機基準；不代表保證中獎。'
  }
}
