import assert from 'node:assert/strict'
import test from 'node:test'

import {
  loadSupabaseReplayDraws,
  normalizeReplayDraws,
  parseArgs,
  runReplay
} from './lai_v3_replay.mjs'

const CODE_COMMIT = '0123456789abcdef0123456789abcdef01234567'

const baselineRegistration = {
  id: 'uniform-539',
  game_name: '今彩539',
  model_name: 'uniform-null',
  model_family: 'uniform-null',
  model_version: 'uniform-null-v1',
  feature_version: 'none-v1',
  parameters: { random_seed: 'uniform-null-v1' },
  code_commit: CODE_COMMIT,
  status: 'baseline'
}

const bayesianRegistration = {
  id: 'bayesian-539',
  game_name: '今彩539',
  model_name: 'bayesian-drift',
  model_family: 'bayesian-drift',
  model_version: 'bayesian-drift-v1',
  feature_version: 'weighted-counts-v1',
  parameters: { halfLifeDraws: 100, priorStrength: 100, random_seed: 'bayesian-drift-v1' },
  code_commit: CODE_COMMIT,
  status: 'registered'
}

const fixtureInput = {
  gameType: '539',
  seed: 'replay-proof',
  registrations: [baselineRegistration, bayesianRegistration],
  draws: [
    { draw_id: '1', draw_date: '2026-08-01', numbers: [1, 2, 3, 4, 5], special_number: null },
    { draw_id: '2', draw_date: '2026-08-03', numbers: [6, 7, 8, 9, 10], special_number: null },
    { draw_id: '3', draw_date: '2026-08-05', numbers: [11, 12, 13, 14, 15], special_number: null }
  ],
  resampling: { bootstrapIterations: 9, permutationIterations: 9 },
  coverageSimulations: 7
}

const [draw1, draw2] = fixtureInput.draws

test('replay defaults to read-only', () => {
  const args = parseArgs(['--game=539', '--source=local', '--seed=proof-1'])

  assert.equal(args.persist, false)
  assert.equal(args.game, '539')
  assert.equal(args.output, null)
  assert.throws(() => parseArgs(['--game=539', '--source=local', '--seed=proof-1', '--persist=true']), /Invalid argument/i)
})

test('draws are sorted and duplicate identities are rejected', () => {
  const sorted = normalizeReplayDraws([draw2, draw1], '539')

  assert.deepEqual(sorted.map((draw) => draw.draw_id), ['1', '2'])
  assert.throws(() => normalizeReplayDraws([draw2, draw1, draw1], '539'), /duplicate draw identity/i)
})

test('legacy ISO dates are normalized without relaxing date validation', () => {
  const normalized = normalizeReplayDraws([
    { draw_id: 'legacy', date: '2024-12-2', numbers: [1, 2, 3, 4, 5], special_number: null }
  ], '539')

  assert.equal(normalized[0].draw_date, '2024-12-02')
  assert.throws(() => normalizeReplayDraws([
    { draw_id: 'invalid', date: '2024/12/2', numbers: [1, 2, 3, 4, 5], special_number: null }
  ], '539'), /ISO calendar date/i)
})

test('Supabase replay adapter is strictly read-only and orders its source query', async () => {
  const calls = []
  const draws = await loadSupabaseReplayDraws({
    gameType: '539',
    supabaseUrl: 'https://example.supabase.co',
    serviceRoleKey: 'service-key',
    fetchFn: async (url, options) => {
      calls.push({ url, options })
      return new Response(JSON.stringify([
        { draw_id: '2', draw_date: '2026-08-03', numbers: [6, 7, 8, 9, 10], special_number: null },
        { draw_id: '1', draw_date: '2026-08-2', numbers: [1, 2, 3, 4, 5], special_number: null }
      ]), { status: 200 })
    }
  })

  assert.deepEqual(draws.map((draw) => [draw.draw_id, draw.draw_date]), [
    ['1', '2026-08-02'],
    ['2', '2026-08-03']
  ])
  assert.equal(calls.length, 1)
  assert.equal(calls[0].options.method, 'GET')
  assert.equal(calls[0].options.body, undefined)
  const url = new URL(calls[0].url)
  assert.equal(url.pathname, '/rest/v1/lotto_draws')
  assert.equal(url.searchParams.get('order'), 'draw_date.asc,draw_id.asc')
})

test('same input produces the same replay digest', async () => {
  const first = await runReplay(fixtureInput)
  const second = await runReplay(fixtureInput)

  assert.match(first.replay_digest, /^[0-9a-f]{64}$/)
  assert.equal(first.replay_digest, second.replay_digest)
  assert.deepEqual(first.metrics, second.metrics)
  assert.equal(first.read_only, true)
  assert.equal(first.metrics.models['bayesian-drift'].evidence.sample_count, 3)
})
