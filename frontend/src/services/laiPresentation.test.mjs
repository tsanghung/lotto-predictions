import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'

import {
  isLaiPredictionRecord,
  toModelEvidenceView,
  toLaiLearningView,
  toLaiPerformanceView,
  toLaiViewModel
} from './laiPresentation.js'

const LAI_PREDICTION = {
  model: 'lai-v2',
  agent_status: 'baseline',
  agent_state_version: 4,
  combinations: {
    '機率主攻': [2, 7, 17, 34, 37],
    '覆蓋探索': [8, 11, 22, 35, 39]
  },
  group_metrics: {
    overlap_count: 0,
    union_size: 10
  },
  expert_weights: {
    uniform: 0.25,
    frequency: 0.45,
    overdue: 0.3
  },
  evidence: {
    last_learned_draw_date: '2026-07-14',
    proven_above_random: false
  }
}

const V3_PREDICTION = {
  model: 'lai-v3',
  agent_status: 'baseline',
  agent_state_version: 12,
  combinations: {
    '證據主攻': [1, 7, 13, 25, 39],
    '覆蓋保底': [2, 8, 14, 26, 38]
  },
  evidence: {
    champion_model: 'uniform-null',
    promotion_stage: 'baseline',
    sample_counts: { shadow_draws: 18, evaluated_draws: 120 },
    brier_skill: -0.012,
    brier_ci: { lower95: -0.031, upper95: 0.008 },
    decision_reason: 'confidence_interval_crosses_zero',
    proven_above_random: false,
    limitation: '尚無證據優於隨機基準，僅供 shadow 驗證。',
    private_parameters: { service_role_key: 'must-not-leak' }
  }
}

function mappedRecord(overrides = {}) {
  return {
    source_key: '今彩539:2026-07-15',
    timestamp: '2026-07-15T02:00:00.000Z',
    target_draw_date: '2026-07-15',
    game_name: '今彩539',
    prediction: LAI_PREDICTION,
    ...overrides
  }
}

function mappedV3Record(overrides = {}) {
  return {
    source_key: '今彩539:2026-08-07',
    timestamp: '2026-08-07T02:00:00.000Z',
    target_draw_date: '2026-08-07',
    game_name: '今彩539',
    prediction: V3_PREDICTION,
    ...overrides
  }
}

test('maps an LAI prediction into two named groups and operational status', () => {
  const view = toLaiViewModel(mappedRecord())

  assert.equal(view.version, 'LAI v2')
  assert.equal(view.status, 'Baseline')
  assert.equal(view.stateVersion, 4)
  assert.equal(view.lastLearnedDate, '2026-07-14')
  assert.equal(view.provenAboveRandom, false)
  assert.deepEqual(view.groups.map((group) => group.label), ['機率主攻', '覆蓋探索'])
  assert.deepEqual(view.groups[0].numbers, [2, 7, 17, 34, 37])
  assert.equal(view.overlapCount, 0)
  assert.equal(view.unionSize, 10)
  assert.deepEqual(view.expertWeights, {
    uniform: 0.25,
    frequency: 0.45,
    overdue: 0.3
  })
})

test('returns null for null, invalid, and non-LAI records', () => {
  assert.equal(toLaiViewModel(null), null)
  assert.equal(toLaiViewModel({}), null)
  assert.equal(toLaiViewModel({ prediction: 'invalid' }), null)
  assert.equal(toLaiViewModel({ prediction: { model: 'game-theory-v1' } }), null)
})

test('identifies LAI records without requiring legacy insight fields', () => {
  assert.equal(isLaiPredictionRecord(mappedRecord()), true)
  assert.equal(isLaiPredictionRecord(mappedV3Record()), true)
  assert.equal(isLaiPredictionRecord({ prediction: { model: 'game-theory-v1' } }), false)
  assert.equal(isLaiPredictionRecord(null), false)
})

test('maps only stored LAI v3 public evidence and two evidence groups', () => {
  const view = toLaiViewModel(mappedV3Record())
  const evidence = toModelEvidenceView(mappedV3Record())

  assert.equal(view.version, 'LAI v3')
  assert.deepEqual(view.groups.map((group) => group.label), ['證據主攻', '覆蓋保底'])
  assert.deepEqual(view.groups[0].numbers, [1, 7, 13, 25, 39])
  assert.deepEqual(evidence, {
    champion: 'uniform-null',
    promotionStage: 'baseline',
    shadowSamples: 18,
    brierSkill: -0.012,
    ciLower95: -0.031,
    ciUpper95: 0.008,
    decisionReason: 'confidence_interval_crosses_zero',
    provenAboveRandom: false,
    limitation: '尚無證據優於隨機基準，僅供 shadow 驗證。'
  })
  assert.equal(JSON.stringify(evidence).includes('must-not-leak'), false)
})

test('keeps unavailable LAI v3 confidence evidence unavailable without inventing a claim', () => {
  const record = mappedV3Record({
    prediction: {
      ...V3_PREDICTION,
      evidence: {
        ...V3_PREDICTION.evidence,
        brier_ci: undefined,
        proven_above_random: undefined
      }
    }
  })
  const evidence = toModelEvidenceView(record)

  assert.equal(evidence.ciLower95, null)
  assert.equal(evidence.ciUpper95, null)
  assert.equal(evidence.provenAboveRandom, false)
})

test('uses degraded and safe empty fallbacks when optional LAI fields are missing', () => {
  const view = toLaiViewModel({ prediction: { model: 'lai-v2' } })

  assert.equal(view.status, 'Degraded')
  assert.equal(view.stateVersion, null)
  assert.equal(view.lastLearnedDate, null)
  assert.equal(view.provenAboveRandom, false)
  assert.deepEqual(view.groups, [
    { label: '機率主攻', numbers: [], special: [] },
    { label: '覆蓋探索', numbers: [], special: [] }
  ])
  assert.equal(view.overlapCount, 0)
  assert.equal(view.unionSize, 0)
  assert.deepEqual(view.expertWeights, {})
})

test('maps champion status and Power Lottery second-area selections', () => {
  const view = toLaiViewModel(mappedRecord({
    game_name: '威力彩',
    prediction: {
      ...LAI_PREDICTION,
      agent_status: 'champion',
      combinations: {
        '機率主攻': [2, 7, 17, 28, 34, 38],
        '覆蓋探索': [1, 9, 18, 24, 30, 36]
      },
      special_combinations: {
        '機率主攻': [3],
        '覆蓋探索': [7]
      }
    }
  }))

  assert.equal(view.status, 'Champion')
  assert.deepEqual(view.groups[0].special, [3])
  assert.deepEqual(view.groups[1].special, [7])
})

test('supports raw prediction_records rows and mapped supabaseData records', () => {
  const raw = {
    predicted_at: '2026-07-15T02:00:00.000Z',
    target_draw_date: '2026-07-15',
    game_name: '今彩539',
    prediction: LAI_PREDICTION
  }
  const mapped = mappedRecord()

  assert.equal(toLaiViewModel(raw).generatedAt, raw.predicted_at)
  assert.equal(toLaiViewModel(mapped).generatedAt, mapped.timestamp)
  assert.equal(toLaiViewModel(raw).targetDrawDate, '2026-07-15')
  assert.deepEqual(toLaiViewModel(raw).groups, toLaiViewModel(mapped).groups)
})

test('does not mutate the source record or expose mutable source arrays and objects', () => {
  const source = mappedRecord({
    prediction: structuredClone(LAI_PREDICTION)
  })
  const before = structuredClone(source)
  const view = toLaiViewModel(source)

  view.groups[0].numbers.push(49)
  view.expertWeights.uniform = 1

  assert.deepEqual(source, before)
})

test('sanitizes malformed number groups and derives coverage from displayed numbers', () => {
  const view = toLaiViewModel(mappedRecord({
    prediction: {
      ...LAI_PREDICTION,
      combinations: {
        '機率主攻': [1, 1, 40, 2, 3, 4, 5, 6],
        '覆蓋探索': [2, 7, 8, 9, 10]
      },
      group_metrics: { overlap_count: 99, union_size: 99 },
      expert_weights: { valid: 0.5, invalid: 2 }
    }
  }))
  assert.deepEqual(view.groups[0].numbers, [1, 2, 3, 4, 5])
  assert.equal(view.overlapCount, 1)
  assert.equal(view.unionSize, 9)
  assert.deepEqual(view.expertWeights, { valid: 0.5 })
})

test('maps post-draw LAI learning without inventing causal explanations', () => {
  const view = toLaiLearningView({
    target_draw_date: '2026-07-15',
    raw_learning_report: {
      lai: {
        state_version: 5,
        agent_status: 'baseline',
        weight_changes: [{ model: 'hazard', before: 0.2, after: 0.18, delta: 999 }],
        champion_changed: false,
        champion_model: 'uniform',
        brier_skill_score: 0.04,
        coverage: { union_hits: 2, union_size: 10, overlap_count: 0 }
      }
    }
  })
  assert.deepEqual(view.weightChanges, [{ model: 'hazard', before: 0.2, after: 0.18, delta: -0.02 }])
  assert.equal(view.championChanged, false)
  assert.equal(view.unionHits, 2)
  assert.ok(!JSON.stringify(view).includes('為什麼開'))
  assert.match(view.limitation, /不能證明/)
})

test('maps LAI performance metrics and preserves unavailable values as null', () => {
  assert.equal(toLaiPerformanceView({}), null)
  assert.equal(toLaiPerformanceView({ lai: { union_coverage_rate: 1.01 } }).unionCoverageRate, null)
  const view = toLaiPerformanceView({
    lai: {
      brier_skill_score: 0.03,
      brier_ci: { lower95: -0.01, upper95: 0.07 },
      union_coverage_rate: 0.4,
      average_group_a_hits: 1.2,
      average_group_b_hits: 1.1,
      champion_model: 'hazard',
      agent_status: 'champion',
      promotion_stage: 'baseline',
      sample_counts: { shadow_draws: 18 }
    }
  })
  assert.equal(view.brierSkillScore, 0.03)
  assert.equal(view.brierCiLower95, -0.01)
  assert.equal(view.brierCiUpper95, 0.07)
  assert.equal(view.unionCoverageRate, 0.4)
  assert.equal(view.championModel, 'hazard')
  assert.equal(view.promotionStage, 'baseline')
  assert.equal(view.shadowSamples, 18)
  assert.match(view.limitation, /不代表保證中獎/)
})

test('Supabase learning query retains the persisted LAI report', async () => {
  const source = await readFile(new URL('./supabaseData.js', import.meta.url), 'utf8')
  assert.match(source, /asi_learning_records\?select=[^'\n]*raw_learning_report/)
  assert.match(source, /raw_learning_report:\s*row\.raw_learning_report/)
})
