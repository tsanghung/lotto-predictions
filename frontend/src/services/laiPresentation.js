const LAI_GROUP_LABELS = {
  'lai-v2': ['機率主攻', '覆蓋探索'],
  'lai-v3': ['證據主攻', '覆蓋保底']
}

const STATUS_LABELS = {
  baseline: 'Baseline',
  champion: 'Champion',
  degraded: 'Degraded'
}

const PROMOTION_STAGES = new Set(['baseline', 'canary', 'champion'])
const SHADOW_LIMITATION = 'LAI v3 僅作 shadow 驗證，尚未取得正式預測或通知資格。'

const GAME_LIMITS = {
  '今彩539': { max: 39, picks: 5 },
  '大樂透': { max: 49, picks: 6 },
  '威力彩': { max: 38, picks: 6, specialMax: 8, specialPicks: 1 }
}

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function copyNumberList(value, max = Number.POSITIVE_INFINITY, picks = Number.POSITIVE_INFINITY) {
  if (!Array.isArray(value)) return []
  return [...new Set(value.filter((number) => (
    Number.isInteger(number) && number > 0 && number <= max
  )))].slice(0, picks)
}

function copyExpertWeights(value) {
  if (!isPlainObject(value)) return {}

  return Object.fromEntries(
    Object.entries(value)
      .filter(([name, weight]) => name && Number.isFinite(weight) && weight >= 0 && weight <= 1)
      .map(([name, weight]) => [name, weight])
  )
}

function copyPublicText(value) {
  if (typeof value !== 'string') return null
  const text = value.trim()
  return text ? text.slice(0, 500) : null
}

function copyNonnegativeInteger(value) {
  return Number.isInteger(value) && value >= 0 ? value : null
}

function copyPromotionStage(value) {
  return PROMOTION_STAGES.has(value) ? value : null
}

function copyBrierInterval(value) {
  if (!isPlainObject(value)) return { lower95: null, upper95: null }
  return {
    lower95: Number.isFinite(value.lower95) ? value.lower95 : null,
    upper95: Number.isFinite(value.upper95) ? value.upper95 : null
  }
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
  const model = record?.prediction?.model
  return Boolean(record?.prediction && typeof record.prediction === 'object' && Object.hasOwn(LAI_GROUP_LABELS, model))
}

export function toModelEvidenceView(record) {
  if (record?.prediction?.model !== 'lai-v3') return null

  const evidence = isPlainObject(record.prediction.evidence) ? record.prediction.evidence : {}
  const sampleCounts = isPlainObject(evidence.sample_counts) ? evidence.sample_counts : {}
  const interval = copyBrierInterval(evidence.brier_ci)

  return {
    champion: copyPublicText(evidence.champion_model),
    promotionStage: copyPromotionStage(evidence.promotion_stage),
    shadowSamples: copyNonnegativeInteger(evidence.shadow_live_draws)
      ?? copyNonnegativeInteger(sampleCounts.shadow_draws),
    brierSkill: Number.isFinite(evidence.brier_skill) ? evidence.brier_skill : null,
    ciLower95: interval.lower95,
    ciUpper95: interval.upper95,
    decisionReason: copyPublicText(evidence.decision_reason) || copyPublicText(evidence.latest_decision_reason),
    provenAboveRandom: evidence.proven_above_random === true,
    limitation: copyPublicText(evidence.limitation) || SHADOW_LIMITATION
  }
}

export function toLaiViewModel(record) {
  if (!isLaiPredictionRecord(record)) {
    return null
  }

  const prediction = record.prediction
  const model = prediction.model
  const limits = GAME_LIMITS[record.game_name] || {}
  const groupLabels = LAI_GROUP_LABELS[model]
  const combinations = isPlainObject(prediction.combinations) ? prediction.combinations : {}
  const specialCombinations = isPlainObject(prediction.special_combinations)
    ? prediction.special_combinations
    : {}
  const groups = groupLabels.map((label) => ({
    label,
    numbers: copyNumberList(combinations[label], limits.max, limits.picks),
    special: copyNumberList(specialCombinations[label], limits.specialMax, limits.specialPicks)
  }))
  const fallbackMetrics = fallbackGroupMetrics(groups)

  return {
    model,
    version: model === 'lai-v3' ? 'LAI v3' : 'LAI v2',
    isEvidenceModel: model === 'lai-v3',
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
    expertWeights: copyExpertWeights(prediction.expert_weights),
    evidence: toModelEvidenceView(record)
  }
}

export function toLaiLearningView(record) {
  const report = record?.raw_learning_report?.lai || record?.evaluation?.learning_report?.lai
  if (!isPlainObject(report)) return null

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
  const coverage = isPlainObject(report.coverage) ? report.coverage : {}

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
  if (!isPlainObject(lai)) return null
  const interval = copyBrierInterval(lai.brier_ci)
  const sampleCounts = isPlainObject(lai.sample_counts) ? lai.sample_counts : {}

  return {
    brierSkillScore: Number.isFinite(lai.brier_skill_score) ? lai.brier_skill_score : null,
    brierCiLower95: interval.lower95,
    brierCiUpper95: interval.upper95,
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
    championModel: copyPublicText(lai.champion_model),
    agentStatus: copyPublicText(lai.agent_status),
    promotionStage: copyPromotionStage(lai.promotion_stage),
    shadowSamples: copyNonnegativeInteger(lai.shadow_live_draws)
      ?? copyNonnegativeInteger(sampleCounts.shadow_draws),
    limitation: 'Brier Skill Score 大於 0 代表此評估區間優於均勻隨機基準；不代表保證中獎。'
  }
}
