import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REQUIRED_TABLES = [
  'lai_model_registry',
  'lai_experiment_runs',
  'lai_promotion_decisions',
  'lai_evidence_snapshots',
  'lai_evidence_corrections'
]
const GAME_NAMES = ['今彩539', '大樂透', '威力彩']
const STAGE_RANK = { shadow_verified: 1, canary: 2, champion: 3 }
const DIGEST_PATTERN = /^[0-9a-f]{64}$/

function requireNonEmptyString(value, label) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new TypeError(`${label} must be a non-empty string`)
  }
  return value.trim()
}

function requireBaseUrl(value) {
  return requireNonEmptyString(value, 'SUPABASE_URL').replace(/\/+$/, '')
}

function encodePath(path, params = {}) {
  const query = new URLSearchParams(params)
  return `${path}?${query}`
}

function asRows(value, label) {
  if (!Array.isArray(value)) throw new Error(`${label} did not return a JSON array`)
  return value
}

async function getRows({ baseUrl, key, path, params, fetchFn, label }) {
  const response = await fetchFn(`${baseUrl}/rest/v1/${encodePath(path, params)}`, {
    method: 'GET',
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`
    }
  })
  const text = await response.text()
  let body
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    throw new Error(`${label} returned invalid JSON (${response.status})`)
  }
  if (!response.ok) throw new Error(`${label} failed (${response.status})`)
  return asRows(body, label)
}

async function getAllRows({ baseUrl, key, path, params = {}, fetchFn, label }) {
  const rows = []
  const pageSize = 1000
  for (let offset = 0; ; offset += pageSize) {
    const page = await getRows({
      baseUrl,
      key,
      path,
      params: { ...params, limit: String(pageSize), offset: String(offset) },
      fetchFn,
      label
    })
    rows.push(...page)
    if (page.length < pageSize) return rows
  }
}

function verifyBaselineRows(rows) {
  const byGame = new Map()
  for (const row of rows) {
    if (row?.model_name !== 'uniform-null' || row?.model_family !== 'uniform-null' || row?.status !== 'baseline') continue
    const group = byGame.get(row.game_name) ?? []
    group.push(row)
    byGame.set(row.game_name, group)
  }
  for (const gameName of GAME_NAMES) {
    if ((byGame.get(gameName) ?? []).length !== 1) {
      throw new Error(`${gameName} must have exactly one uniform-null baseline registration`)
    }
  }
}

function verifyExperiments(rows) {
  for (const row of rows) {
    if (!Number.isInteger(row?.range_start) || !Number.isInteger(row?.range_end)
      || !Number.isInteger(row?.checkpoint_cursor)
      || row.range_start < 0 || row.range_end < row.range_start
      || row.checkpoint_cursor < row.range_start || row.checkpoint_cursor > row.range_end) {
      throw new Error(`experiment ${row?.id ?? 'unknown'} has an invalid checkpoint range`)
    }
    if (typeof row.data_cutoff !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(row.data_cutoff)) {
      throw new Error(`experiment ${row.id} has an invalid data cutoff`)
    }
    if (row.status === 'completed') {
      if (!DIGEST_PATTERN.test(row.replay_digest ?? '')) {
        throw new Error(`completed experiment ${row.id} is missing a valid replay digest`)
      }
      if (row.run_mode === 'historical' && row.checkpoint_cursor !== row.range_end) {
        throw new Error(`completed historical experiment ${row.id} did not finish its checkpoint range`)
      }
    }
  }
}

function verifyActiveStates(activeStates, registrations) {
  const activeByGame = new Map()
  for (const state of activeStates) {
    const group = activeByGame.get(state.game_name) ?? []
    group.push(state)
    activeByGame.set(state.game_name, group)
  }
  for (const [gameName, states] of activeByGame) {
    if (states.length > 1) throw new Error(`${gameName} has more than one active agent state`)
    const state = states[0]
    if (state?.metrics?.promotion_stage !== 'canary') continue
    const candidates = registrations.filter((row) => row.game_name === gameName && row.status === 'canary')
    if (!candidates.length) throw new Error(`${gameName} has a canary state without a canary registry`) 
    const weights = state.expert_weights
    if (!weights || typeof weights !== 'object' || Array.isArray(weights)) {
      throw new Error(`${gameName} canary state is missing expert weights`)
    }
    for (const candidate of candidates) {
      const weight = weights[candidate.model_name]
      if (!Number.isFinite(weight) || weight < 0 || weight > 0.10) {
        throw new Error(`${gameName} canary weight exceeds 10% for ${candidate.model_name}`)
      }
    }
  }
}

function modelOfPrediction(row) {
  return row?.prediction && typeof row.prediction === 'object' ? row.prediction.model : null
}

function hasTaggedV3Notification(row) {
  const payload = row?.payload
  return Boolean(payload && typeof payload === 'object' && (
    payload.engine === 'lai-v3'
    || payload.model === 'lai-v3'
    || payload?.prediction?.model === 'lai-v3'
  ))
}

function verifyNotificationUniqueness(rows) {
  const sentByKey = new Map()
  for (const row of rows) {
    if (row?.status !== 'sent') continue
    const count = (sentByKey.get(row.notification_key) ?? 0) + 1
    if (count > 1) throw new Error(`notification key ${row.notification_key} has multiple sent rows`)
    sentByKey.set(row.notification_key, count)
  }
}

function latestByGame(rows, compare) {
  const latest = new Map()
  for (const row of rows) {
    const current = latest.get(row.game_name)
    if (!current || compare(row, current) > 0) latest.set(row.game_name, row)
  }
  return latest
}

function decisionRank(row) {
  const stage = row?.to_status
  return row?.decision === 'promote' ? (STAGE_RANK[stage] ?? 0) : 0
}

function verifyRequiredStage({ requiredStage, decisions, activeStates }) {
  if (!requiredStage) return
  const requiredRank = STAGE_RANK[requiredStage]
  const latestDecision = latestByGame(decisions, (left, right) => (
    Number(left.decision_sequence ?? 0) - Number(right.decision_sequence ?? 0)
    || String(left.decided_at ?? '').localeCompare(String(right.decided_at ?? ''))
  ))
  const activeByGame = latestByGame(activeStates, (left, right) => (
    Number(left.state_version ?? 0) - Number(right.state_version ?? 0)
  ))
  for (const gameName of GAME_NAMES) {
    const decision = latestDecision.get(gameName)
    const activeStage = activeByGame.get(gameName)?.metrics?.promotion_stage
    const activeRank = STAGE_RANK[activeStage] ?? 0
    if (Math.max(decisionRank(decision), activeRank) < requiredRank) {
      throw new Error(`${gameName} has not reached the required ${requiredStage} stage`)
    }
  }
}

export function parseVerifyArgs(argv) {
  if (!Array.isArray(argv)) throw new TypeError('argv must be an array')
  if (argv.length === 0) return { requireStage: null }
  if (argv.length !== 1) throw new Error('Invalid verifier arguments')
  const match = /^--require-stage=(shadow_verified|canary|champion)$/.exec(argv[0])
  if (!match) throw new Error(`Invalid argument: ${argv[0]}`)
  return { requireStage: match[1] }
}

export async function verifyProduction({
  supabaseUrl,
  serviceRoleKey,
  anonKey,
  requireStage = null,
  fetchFn = fetch
} = {}) {
  const baseUrl = requireBaseUrl(supabaseUrl)
  const serviceKey = requireNonEmptyString(serviceRoleKey, 'SUPABASE_SERVICE_ROLE_KEY')
  const resolvedAnonKey = requireNonEmptyString(anonKey, 'SUPABASE_ANON_KEY')
  if (requireStage && !Object.hasOwn(STAGE_RANK, requireStage)) throw new Error('Invalid --require-stage')
  if (typeof fetchFn !== 'function') throw new TypeError('fetchFn must be a function')

  const tableChecks = await Promise.all(REQUIRED_TABLES.map(async (table) => {
    const serviceRows = await getRows({
      baseUrl, key: serviceKey, path: table, params: { select: '*', limit: '1' }, fetchFn,
      label: `service-role ${table} read`
    })
    const anonRows = await getRows({
      baseUrl, key: resolvedAnonKey, path: table, params: { select: '*', limit: '1' }, fetchFn,
      label: `anon ${table} read`
    })
    if (anonRows.length > 0) throw new Error(`anon can read protected ${table} rows`)
    return { table, service_role_readable: true, anon_rows: anonRows.length, observed_rows: serviceRows.length }
  }))

  const [registrations, experiments, shadowForecasts, v3Predictions, activeStates, decisions, notifications] = await Promise.all([
    getAllRows({ baseUrl, key: serviceKey, path: 'lai_model_registry', params: { select: 'id,game_name,model_name,model_family,status' }, fetchFn, label: 'registry read' }),
    getAllRows({ baseUrl, key: serviceKey, path: 'lai_experiment_runs', params: { select: 'id,game_name,run_mode,status,data_cutoff,range_start,range_end,checkpoint_cursor,replay_digest' }, fetchFn, label: 'experiment read' }),
    getAllRows({ baseUrl, key: serviceKey, path: 'lotto_model_forecasts', params: { forecast_mode: 'eq.shadow', select: 'prediction_source_key,game_name,target_draw_date,model_name,model_version,registry_id' }, fetchFn, label: 'shadow forecast read' }),
    getAllRows({ baseUrl, key: serviceKey, path: 'prediction_records', params: { select: 'source_key,game_name,target_draw_date,prediction' }, fetchFn, label: 'prediction record read' }),
    getAllRows({ baseUrl, key: serviceKey, path: 'lotto_agent_states', params: { is_active: 'eq.true', select: 'game_name,state_version,is_active,champion_model,expert_weights,metrics' }, fetchFn, label: 'active state read' }),
    getAllRows({ baseUrl, key: serviceKey, path: 'lai_promotion_decisions', params: { select: 'game_name,registry_id,decision,to_status,decision_sequence,decided_at' }, fetchFn, label: 'promotion decision read' }),
    getAllRows({ baseUrl, key: serviceKey, path: 'notification_logs', params: { select: 'notification_key,game_name,target_date,status,payload' }, fetchFn, label: 'notification log read' })
  ])

  verifyBaselineRows(registrations)
  verifyExperiments(experiments)
  verifyActiveStates(activeStates, registrations)
  verifyNotificationUniqueness(notifications)
  verifyRequiredStage({ requiredStage: requireStage, decisions, activeStates })

  const formalV3Predictions = v3Predictions.filter((row) => modelOfPrediction(row) === 'lai-v3')
  if (formalV3Predictions.length > 0) {
    throw new Error(`shadow isolation violated: ${formalV3Predictions.length} formal LAI v3 prediction records exist`)
  }
  const taggedV3Notifications = notifications.filter(hasTaggedV3Notification)
  if (taggedV3Notifications.length > 0) {
    throw new Error(`shadow isolation violated: ${taggedV3Notifications.length} tagged LAI v3 notifications exist`)
  }

  return {
    Status: 'passed',
    read_only: true,
    required_stage: requireStage,
    protected_tables: tableChecks,
    shadow_forecast_count: shadowForecasts.length,
    formal_lai_v3_prediction_count: formalV3Predictions.length,
    tagged_lai_v3_notification_count: taggedV3Notifications.length,
    active_state_count: activeStates.length,
    experiment_count: experiments.length,
    sent_notification_count: notifications.filter((row) => row.status === 'sent').length
  }
}

export async function runVerifyCli(argv = process.argv.slice(2), environment = process.env) {
  const args = parseVerifyArgs(argv)
  return verifyProduction({
    supabaseUrl: environment.SUPABASE_URL,
    serviceRoleKey: environment.SUPABASE_SERVICE_ROLE_KEY,
    anonKey: environment.SUPABASE_ANON_KEY,
    requireStage: args.requireStage
  })
}

async function main() {
  try {
    const result = await runVerifyCli()
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  } catch (error) {
    process.stderr.write(`${JSON.stringify({
      Status: 'failed',
      RootCause: error instanceof Error ? error.message : String(error),
      SuggestedFix: 'Confirm SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY, migrations, and the required stage before retrying.'
    })}\n`)
    process.exitCode = 1
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main()
}
