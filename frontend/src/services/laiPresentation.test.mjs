import assert from 'node:assert/strict'
import test from 'node:test'

import { isLaiPredictionRecord, toLaiViewModel } from './laiPresentation.js'

const LAI_PREDICTION = {
  model: 'lai-v2',
  agent_status: 'baseline',
  agent_state_version: 4,
  combinations: {
    '機率主攻': [2, 7, 17, 34, 41],
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

test('maps an LAI prediction into two named groups and operational status', () => {
  const view = toLaiViewModel(mappedRecord())

  assert.equal(view.version, 'LAI v2')
  assert.equal(view.status, 'Baseline')
  assert.equal(view.stateVersion, 4)
  assert.equal(view.lastLearnedDate, '2026-07-14')
  assert.equal(view.provenAboveRandom, false)
  assert.deepEqual(view.groups.map((group) => group.label), ['機率主攻', '覆蓋探索'])
  assert.deepEqual(view.groups[0].numbers, [2, 7, 17, 34, 41])
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
  assert.equal(isLaiPredictionRecord({ prediction: { model: 'game-theory-v1' } }), false)
  assert.equal(isLaiPredictionRecord(null), false)
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
