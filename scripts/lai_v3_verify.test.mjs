import assert from 'node:assert/strict'
import test from 'node:test'

import { parseVerifyArgs, verifyProduction } from './lai_v3_verify.mjs'

const BASE_URL = 'https://example.supabase.co'
const SERVICE_KEY = 'service-key'
const ANON_KEY = 'anon-key'
const GAMES = ['今彩539', '大樂透', '威力彩']

function baselineRows() {
  return GAMES.map((game_name) => ({
    id: `baseline-${game_name}`,
    game_name,
    model_name: 'uniform-null',
    model_family: 'uniform-null',
    status: 'baseline'
  }))
}

function responseRows(rows, url) {
  const parsed = new URL(url)
  const offset = Number(parsed.searchParams.get('offset') ?? 0)
  const limit = Number(parsed.searchParams.get('limit') ?? rows.length)
  return new Response(JSON.stringify(rows.slice(offset, offset + limit)), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  })
}

function createReadOnlyFetch(seed = {}) {
  const calls = []
  const rowsByTable = {
    lai_model_registry: baselineRows(),
    lai_experiment_runs: [],
    lai_promotion_decisions: [],
    lai_evidence_snapshots: [],
    lai_evidence_corrections: [],
    lotto_model_forecasts: [],
    prediction_records: [],
    lotto_agent_states: [],
    notification_logs: [],
    ...seed
  }
  const protectedTables = new Set([
    'lai_model_registry',
    'lai_experiment_runs',
    'lai_promotion_decisions',
    'lai_evidence_snapshots',
    'lai_evidence_corrections'
  ])
  const fetchFn = async (url, options = {}) => {
    calls.push({ url, options })
    const table = new URL(url).pathname.split('/').at(-1)
    const isAnon = options.headers?.apikey === ANON_KEY
    return responseRows(isAnon && protectedTables.has(table) ? [] : (rowsByTable[table] ?? []), url)
  }
  return { calls, fetchFn, rowsByTable }
}

async function verifyWith(fetchFn) {
  return verifyProduction({
    supabaseUrl: BASE_URL,
    serviceRoleKey: SERVICE_KEY,
    anonKey: ANON_KEY,
    fetchFn
  })
}

test('verifier uses GET only and passes an isolated shadow fixture', async () => {
  const { calls, fetchFn } = createReadOnlyFetch()
  const result = await verifyWith(fetchFn)

  assert.equal(result.Status, 'passed')
  assert.equal(result.read_only, true)
  assert.ok(calls.length >= 17)
  assert.ok(calls.every(({ options }) => options.method === 'GET'))
  assert.ok(calls.every(({ url }) => url.startsWith(`${BASE_URL}/rest/v1/`)))
})

test('verifier rejects formal LAI v3 prediction records', async () => {
  const { fetchFn } = createReadOnlyFetch({
    prediction_records: [{
      source_key: 'formal-v3',
      game_name: '今彩539',
      target_draw_date: '2026-08-10',
      prediction: { model: 'lai-v3' }
    }]
  })

  await assert.rejects(() => verifyWith(fetchFn), /shadow isolation violated.*formal LAI v3/i)
})

test('verifier rejects duplicate sent notification keys', async () => {
  const { fetchFn } = createReadOnlyFetch({
    notification_logs: [
      { notification_key: 'same-key', game_name: '今彩539', target_date: '2026-08-10', status: 'sent', payload: {} },
      { notification_key: 'same-key', game_name: '今彩539', target_date: '2026-08-10', status: 'sent', payload: {} }
    ]
  })

  await assert.rejects(() => verifyWith(fetchFn), /multiple sent rows/i)
})

test('verifier rejects a canary challenger above the ten percent cap', async () => {
  const registrations = baselineRows()
  registrations.push({
    id: 'candidate-539',
    game_name: '今彩539',
    model_name: 'bayesian-drift',
    model_family: 'bayesian-drift',
    status: 'canary'
  })
  const { fetchFn } = createReadOnlyFetch({
    lai_model_registry: registrations,
    lotto_agent_states: [{
      game_name: '今彩539',
      state_version: 2,
      is_active: true,
      champion_model: 'legacy',
      expert_weights: { 'bayesian-drift': 0.11 },
      metrics: { promotion_stage: 'canary' }
    }]
  })

  await assert.rejects(() => verifyWith(fetchFn), /canary weight exceeds 10%/i)
})

test('verifier accepts only the documented stage argument', () => {
  assert.deepEqual(parseVerifyArgs([]), { requireStage: null })
  assert.deepEqual(parseVerifyArgs(['--require-stage=shadow_verified']), { requireStage: 'shadow_verified' })
  assert.throws(() => parseVerifyArgs(['--require-stage=production']), /Invalid argument/i)
})
