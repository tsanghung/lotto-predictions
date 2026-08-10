import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { canonicalChronologyInstant } from '../supabase/functions/_shared/lai-v3/contracts.js'
import { scoreEvidenceForecast } from '../supabase/functions/_shared/lai-v3/evaluation.js'
import { buildEvidenceForecasts } from '../supabase/functions/_shared/lai-v3/models.js'
import { evaluatePromotionGate } from '../supabase/functions/_shared/lai-v3/promotionGate.js'
import { benjaminiHochberg } from '../supabase/functions/_shared/lai-v3/statistics.js'
import {
  accumulateEvidencePair,
  canonicalJson,
  createInitialEvidenceState,
  finalizeEvidenceRun
} from '../supabase/functions/lotto-train-agent/lib/evidenceTraining.js'
import { GAME_CONFIG } from '../supabase/functions/lotto-predict-notify/lib/gameConfig.js'
import {
  optimizeEvidenceGroups,
  optimizeEvidencePowerGroups
} from '../supabase/functions/lotto-predict-notify/lib/evidenceOptimizer.js'

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const LOCAL_DATA_FILES = {
  '539': 'data/daily539.json',
  '649': 'data/lotto649.json',
  power: 'data/power.json'
}
const GAME_TYPES = new Set(Object.keys(GAME_CONFIG))
const DEFAULT_COVERAGE_SIMULATIONS = 64
const CODE_COMMIT_PATTERN = /^[0-9a-f]{7,64}$/

function requireNonEmptyString(value, label) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new TypeError(`${label} must be a non-empty string`)
  }
  return value.trim()
}

function requireDateOnly(value, label) {
  const date = requireNonEmptyString(value, label)
  const match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(date)
  if (!match) {
    throw new RangeError(`${label} must be an ISO calendar date`)
  }
  const normalized = `${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}`
  canonicalChronologyInstant(normalized)
  return normalized
}

function requireGameType(gameType) {
  if (!GAME_TYPES.has(gameType)) {
    throw new RangeError('gameType must be one of 539, 649, or power')
  }
  return gameType
}

function cloneJson(value) {
  return structuredClone(value)
}

function stringifyDigest(value) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex')
}

function compareDraws(left, right) {
  return canonicalChronologyInstant(left.draw_date) - canonicalChronologyInstant(right.draw_date)
    || left.draw_id.localeCompare(right.draw_id, undefined, { numeric: true })
}

function validateReplayOutputPath(output) {
  const requested = requireNonEmptyString(output, '--output')
  if (isAbsolute(requested)) throw new RangeError('--output must stay within the repository')
  const destination = resolve(ROOT_DIR, requested)
  const pathFromRoot = relative(ROOT_DIR, destination)
  if (!pathFromRoot || pathFromRoot.startsWith('..') || isAbsolute(pathFromRoot)) {
    throw new RangeError('--output must stay within the repository')
  }
  if (!destination.toLowerCase().endsWith('.json')) {
    throw new RangeError('--output must end with .json')
  }
  return destination
}

function validateCoverageSimulations(value) {
  if (!Number.isInteger(value) || value < 1 || value > 1000) {
    throw new RangeError('coverageSimulations must be an integer from 1 through 1000')
  }
  return value
}

function resolveRegistrations(input, gameType) {
  const rows = input.registrations ?? (input.registration ? [input.registration] : null)
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new TypeError('registrations must contain at least one immutable registration')
  }

  const cloned = rows.map((row) => cloneJson(row))
  const config = GAME_CONFIG[gameType]
  if (cloned.some((row) => row?.game_name !== config.name)) {
    throw new RangeError('registrations must match the selected game')
  }
  const baseline = cloned.filter((row) => row?.model_family === 'uniform-null' && row?.status === 'baseline')
  if (baseline.length !== 1) {
    throw new RangeError('registrations must contain exactly one uniform-null baseline')
  }
  if (cloned.some((row) => !CODE_COMMIT_PATTERN.test(row?.code_commit ?? ''))) {
    throw new RangeError('registrations must provide a valid code_commit')
  }
  return {
    baseline: baseline[0],
    challengers: cloned.filter((row) => row !== baseline[0])
  }
}

function publicRegistration(registration) {
  return {
    id: registration.id,
    model_name: registration.model_name,
    model_family: registration.model_family,
    model_version: registration.model_version,
    feature_version: registration.feature_version,
    code_commit: registration.code_commit,
    status: registration.status
  }
}

function scoreForecastWithGroups(forecast, config, seed) {
  if (config.secondaryNumber) {
    const groups = optimizeEvidencePowerGroups({
      mainProbabilities: forecast.probabilities,
      specialProbabilities: forecast.specialProbabilities,
      config,
      seed
    })
    return {
      ...forecast,
      final_groups: {
        combinations: {
          '證據主攻': groups.evidenceAttack,
          '覆蓋保底': groups.coverageFallback
        },
        special_combinations: {
          '證據主攻': groups.specialEvidenceAttack,
          '覆蓋保底': groups.specialCoverageFallback
        }
      }
    }
  }

  const groups = optimizeEvidenceGroups({
    probabilities: forecast.probabilities,
    config,
    seed,
    minUtilityRatio: 0.90,
    maxOverlap: Math.floor(config.picks / 3)
  })
  return {
    ...forecast,
    final_groups: {
      combinations: {
        '證據主攻': groups.evidenceAttack,
        '覆蓋保底': groups.coverageFallback
      }
    }
  }
}

function emptyCoverageSummary() {
  return {
    sample_count: 0,
    main: { group_a_hits: 0, group_b_hits: 0, union_hits: 0, union_size: 0, matched_random_mean: 0 },
    special_area: { group_a_hits: 0, group_b_hits: 0, union_hits: 0, union_size: 0, matched_random_mean: 0 }
  }
}

function addCoverage(summary, score) {
  const next = cloneJson(summary)
  next.sample_count += 1
  for (const [target, source] of [['main', score.main?.coverage], ['special_area', score.special?.coverage]]) {
    if (!source) continue
    next[target].group_a_hits += source.groupAHits
    next[target].group_b_hits += source.groupBHits
    next[target].union_hits += source.unionHits
    next[target].union_size += source.unionSize
    next[target].matched_random_mean += Number.isFinite(source.matchedRandomMean) ? source.matchedRandomMean : 0
  }
  return next
}

function finalizeCoverage(summary) {
  const divisor = summary.sample_count || 1
  const average = (area) => ({
    average_group_a_hits: area.group_a_hits / divisor,
    average_group_b_hits: area.group_b_hits / divisor,
    average_union_hits: area.union_hits / divisor,
    average_union_size: area.union_size / divisor,
    average_matched_random_union_hits: area.matched_random_mean / divisor
  })
  return {
    sample_count: summary.sample_count,
    main: average(summary.main),
    special_area: summary.special_area.union_size ? average(summary.special_area) : null
  }
}

function emptyScoreSummary() {
  return {
    sample_count: 0,
    main_brier: 0,
    main_log_loss: 0,
    combined_brier: 0,
    combined_log_loss: 0,
    special_brier: 0,
    special_log_loss: 0,
    special_sample_count: 0
  }
}

function addScoreSummary(summary, score) {
  return {
    sample_count: summary.sample_count + 1,
    main_brier: summary.main_brier + score.main.brier,
    main_log_loss: summary.main_log_loss + score.main.logLoss,
    combined_brier: summary.combined_brier + score.combined.brier,
    combined_log_loss: summary.combined_log_loss + score.combined.logLoss,
    special_brier: summary.special_brier + (score.special?.brier ?? 0),
    special_log_loss: summary.special_log_loss + (score.special?.logLoss ?? 0),
    special_sample_count: summary.special_sample_count + Number(Boolean(score.special))
  }
}

function finalizeScoreSummary(summary) {
  const divisor = summary.sample_count || 1
  const specialDivisor = summary.special_sample_count || 1
  return {
    sample_count: summary.sample_count,
    main: {
      average_brier: summary.main_brier / divisor,
      average_log_loss: summary.main_log_loss / divisor
    },
    combined: {
      average_brier: summary.combined_brier / divisor,
      average_log_loss: summary.combined_log_loss / divisor
    },
    special_area: summary.special_sample_count
      ? {
        average_brier: summary.special_brier / specialDivisor,
        average_log_loss: summary.special_log_loss / specialDivisor
      }
      : null
  }
}

function compactEvidence(evidence, adjustedQ = null) {
  if (!evidence) return null
  return {
    sample_count: evidence.sampleCount,
    recent_30_skill: evidence.recent30Skill,
    recent_100_skill: evidence.recent100Skill,
    recent_500_skill: evidence.recent500Skill,
    brier_skill: evidence.brierSkill,
    mean_excess_loss: evidence.meanExcessLoss,
    brier_ci: evidence.brierCi,
    log_loss_delta: evidence.logLossDelta,
    calibration_delta: evidence.calibrationDelta,
    calibration_ci: evidence.calibrationCi,
    coverage_delta: evidence.coverageDelta,
    coverage_ci: evidence.coverageCi,
    permutation_p: evidence.permutationP,
    adjusted_q: adjustedQ
  }
}

function tallySkip(record, reason) {
  record.skipped_draws += 1
  const key = String(reason || 'unclassified_failure').slice(0, 160)
  record.skipped_reasons[key] = (record.skipped_reasons[key] || 0) + 1
}

function buildPromotionEvidence(finalized, adjustedQ) {
  const historical = finalized.metrics.fullRun
  const recent = finalized.metrics.detailWindow
  return {
    ...historical,
    recent30Skill: recent.recent30Skill,
    recent100Skill: recent.recent100Skill,
    recent500Skill: recent.recent500Skill,
    adjustedQ
  }
}

function promotionSimulation(registration, evidence, replayDigest) {
  return evaluatePromotionGate({
    stage: registration.status,
    evidence,
    liveShadowDraws: 0,
    canaryDraws: 0,
    evidenceDigest: replayDigest,
    previousEvidenceDigest: null,
    health: {
      dataValid: true,
      replayDigestValid: true,
      modelValid: true
    }
  })
}

export function parseArgs(argv) {
  if (!Array.isArray(argv)) throw new TypeError('argv must be an array')
  const allowed = new Set(['game', 'source', 'seed', 'output'])
  const values = {}
  for (const arg of argv) {
    const match = /^--([a-z-]+)=(.+)$/.exec(arg)
    if (!match || !allowed.has(match[1]) || Object.hasOwn(values, match[1])) {
      throw new Error(`Invalid argument: ${arg}`)
    }
    values[match[1]] = match[2]
  }
  if (!GAME_TYPES.has(values.game)) throw new Error('Invalid --game')
  if (!['local', 'supabase'].includes(values.source)) throw new Error('Invalid --source')
  if (!values.seed || !values.seed.trim()) throw new Error('--seed is required')
  if (values.output) validateReplayOutputPath(values.output)
  return {
    game: values.game,
    source: values.source,
    seed: values.seed,
    output: values.output || null,
    persist: false
  }
}

export function normalizeReplayDraws(rows, gameType) {
  requireGameType(gameType)
  if (!Array.isArray(rows)) throw new TypeError('draws must be an array')
  const identities = new Set()
  const drawIds = new Set()

  const normalized = rows.map((row, index) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      throw new TypeError(`draws[${index}] must be an object`)
    }
    const drawId = requireNonEmptyString(row.draw_id ?? row.drawId, `draws[${index}].draw_id`)
    const drawDate = requireDateOnly(row.draw_date ?? row.date ?? row.drawDate, `draws[${index}].draw_date`)
    const identity = `${canonicalChronologyInstant(drawDate)}|${drawId}`
    if (identities.has(identity) || drawIds.has(drawId)) {
      throw new RangeError(`duplicate draw identity: ${drawId}`)
    }
    identities.add(identity)
    drawIds.add(drawId)
    return {
      draw_id: drawId,
      draw_date: drawDate,
      numbers: cloneJson(row.numbers),
      special_number: row.special_number ?? row.specialNumber ?? null
    }
  })

  return normalized.sort(compareDraws)
}

export async function loadLocalReplayDraws(gameType, readFileFn = readFile) {
  requireGameType(gameType)
  const dataPath = resolve(ROOT_DIR, LOCAL_DATA_FILES[gameType])
  const parsed = JSON.parse(await readFileFn(dataPath, 'utf8'))
  return normalizeReplayDraws(parsed, gameType)
}

export async function loadSupabaseReplayDraws({ gameType, supabaseUrl, serviceRoleKey, fetchFn = fetch } = {}) {
  requireGameType(gameType)
  const baseUrl = requireNonEmptyString(supabaseUrl, 'SUPABASE_URL').replace(/\/+$/, '')
  const key = requireNonEmptyString(serviceRoleKey, 'SUPABASE_SERVICE_ROLE_KEY')
  if (typeof fetchFn !== 'function') throw new TypeError('fetchFn must be a function')

  const rows = []
  const pageSize = 1000
  const gameName = GAME_CONFIG[gameType].name
  for (let offset = 0; ; offset += pageSize) {
    const params = new URLSearchParams({
      game_name: `eq.${gameName}`,
      select: 'draw_id,draw_date,numbers,special_number',
      order: 'draw_date.asc,draw_id.asc',
      limit: String(pageSize),
      offset: String(offset)
    })
    const response = await fetchFn(`${baseUrl}/rest/v1/lotto_draws?${params}`, {
      method: 'GET',
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`
      }
    })
    const text = await response.text()
    let page
    try {
      page = JSON.parse(text)
    } catch {
      throw new Error(`Supabase lottery draw read returned invalid JSON (${response.status})`)
    }
    if (!response.ok || !Array.isArray(page)) {
      throw new Error(`Supabase lottery draw read failed (${response.status})`)
    }
    rows.push(...page)
    if (page.length < pageSize) break
  }
  return normalizeReplayDraws(rows, gameType)
}

export function defaultReplayRegistrations(gameType, codeCommit) {
  requireGameType(gameType)
  if (!CODE_COMMIT_PATTERN.test(codeCommit ?? '')) {
    throw new RangeError('codeCommit must be a lowercase hexadecimal Git commit')
  }
  const gameName = GAME_CONFIG[gameType].name
  const registration = ({ modelName, family, version, featureVersion, parameters, status }) => ({
    id: `${gameType}-${modelName}`,
    game_name: gameName,
    model_name: modelName,
    model_family: family,
    model_version: version,
    feature_version: featureVersion,
    parameters,
    code_commit: codeCommit,
    status
  })
  return [
    registration({
      modelName: 'uniform-null', family: 'uniform-null', version: 'uniform-null-v1', featureVersion: 'none-v1',
      parameters: { random_seed: 'uniform-null-v1' }, status: 'baseline'
    }),
    registration({
      modelName: 'bayesian-drift', family: 'bayesian-drift', version: 'bayesian-drift-v1', featureVersion: 'weighted-counts-v1',
      parameters: { halfLifeDraws: 100, priorStrength: 100, random_seed: 'bayesian-drift-v1' }, status: 'registered'
    }),
    registration({
      modelName: 'transition-regularized', family: 'transition-regularized', version: 'transition-regularized-v1', featureVersion: 'transition-counts-v1',
      parameters: { minimumSupport: 30, effectCap: 0.25, random_seed: 'transition-regularized-v1' }, status: 'registered'
    }),
    registration({
      modelName: 'sequence-challenger', family: 'sequence-challenger', version: 'sequence-challenger-v1', featureVersion: 'lstm-static-v1',
      parameters: {
        minimumHistory: 30,
        random_seed: 'sequence-challenger-v1',
        calibration: {
          method: 'capped-simplex-projection',
          status: 'shadow-pending-evaluation',
          version: 'capped-simplex-projection-v1'
        }
      },
      status: 'registered'
    })
  ]
}

export async function runReplay(input = {}) {
  const gameType = requireGameType(input.gameType)
  const seed = requireNonEmptyString(input.seed, 'seed')
  const draws = normalizeReplayDraws(input.draws, gameType)
  if (!draws.length) throw new RangeError('draws must not be empty')
  const coverageSimulations = validateCoverageSimulations(input.coverageSimulations ?? DEFAULT_COVERAGE_SIMULATIONS)
  const config = GAME_CONFIG[gameType]
  const { baseline, challengers } = resolveRegistrations(input, gameType)
  const states = new Map(challengers.map((registration) => [
    registration.id,
    createInitialEvidenceState(registration, baseline)
  ]))
  const candidateRuns = new Map(challengers.map((registration) => [
    registration.id,
    {
      registration,
      skipped_draws: 0,
      skipped_reasons: {},
      coverage: emptyCoverageSummary(),
      scores: emptyScoreSummary()
    }
  ]))
  let baselineCoverage = emptyCoverageSummary()
  let baselineScores = emptyScoreSummary()

  for (let targetIndex = 0; targetIndex < draws.length; targetIndex += 1) {
    const target = draws[targetIndex]
    const history = draws.slice(0, targetIndex)
    const generatedAt = `${target.draw_date}T10:00:00+08:00`
    const forecasts = buildEvidenceForecasts({
      gameType,
      draws: history,
      generatedAt,
      registrations: [baseline, ...challengers],
      mode: 'shadow'
    })
    const baselineForecast = forecasts.find((forecast) => forecast.registryId === baseline.id)
    if (!baselineForecast || baselineForecast.status !== 'completed') {
      throw new Error(`uniform-null baseline failed for draw ${target.draw_id}`)
    }
    const preparedBaseline = scoreForecastWithGroups(
      baselineForecast,
      config,
      `${seed}|${target.draw_id}|${baseline.model_name}`
    )
    const baselineScore = scoreEvidenceForecast({
      forecast: preparedBaseline,
      draw: target,
      config,
      seed: `${seed}|${target.draw_id}|${baseline.model_name}|coverage`,
      simulations: coverageSimulations
    })
    baselineCoverage = addCoverage(baselineCoverage, baselineScore)
    baselineScores = addScoreSummary(baselineScores, baselineScore)

    for (const registration of challengers) {
      const run = candidateRuns.get(registration.id)
      const candidateForecast = forecasts.find((forecast) => forecast.registryId === registration.id)
      if (!candidateForecast || candidateForecast.status !== 'completed') {
        tallySkip(run, candidateForecast?.failureReason || 'candidate_forecast_unavailable')
        continue
      }
      try {
        const preparedCandidate = scoreForecastWithGroups(
          candidateForecast,
          config,
          `${seed}|${target.draw_id}|${registration.model_name}`
        )
        const candidateScore = scoreEvidenceForecast({
          forecast: preparedCandidate,
          draw: target,
          config,
          seed: `${seed}|${target.draw_id}|${registration.model_name}|coverage`,
          simulations: coverageSimulations
        })
        states.set(registration.id, accumulateEvidencePair(states.get(registration.id), {
          baseline: baselineScore,
          candidate: candidateScore
        }))
        run.coverage = addCoverage(run.coverage, candidateScore)
        run.scores = addScoreSummary(run.scores, candidateScore)
      } catch (error) {
        tallySkip(run, error instanceof Error ? error.message : String(error))
      }
    }
  }

  const finalizedById = new Map()
  for (const registration of challengers) {
    const state = states.get(registration.id)
    if (state.processedDraws === 0) continue
    finalizedById.set(registration.id, await finalizeEvidenceRun({
      draws,
      registration,
      baselineRegistration: baseline,
      state,
      resampling: input.resampling
    }))
  }

  const pValueModels = challengers
    .map((registration) => ({ registration, finalized: finalizedById.get(registration.id) }))
    .filter(({ finalized }) => Number.isFinite(finalized?.metrics?.fullRun?.permutationP))
  const adjustedQs = benjaminiHochberg(pValueModels.map(({ finalized }) => finalized.metrics.fullRun.permutationP))
  const qByRegistrationId = new Map(pValueModels.map(({ registration }, index) => [registration.id, adjustedQs[index]]))

  const models = {}
  for (const registration of challengers) {
    const run = candidateRuns.get(registration.id)
    const finalized = finalizedById.get(registration.id)
    const adjustedQ = qByRegistrationId.get(registration.id) ?? null
    const promotionEvidence = finalized ? buildPromotionEvidence(finalized, adjustedQ) : null
    const modelReplay = {
      registration: publicRegistration(registration),
      evaluated_draws: finalized?.metrics?.statisticalPopulation?.populationSampleCount ?? 0,
      skipped_draws: run.skipped_draws,
      skipped_reasons: run.skipped_reasons,
      score_summary: finalizeScoreSummary(run.scores),
      coverage: finalizeCoverage(run.coverage),
      second_area: config.secondaryNumber ? finalizeCoverage(run.coverage).special_area : null,
      evidence: promotionEvidence ? {
        ...compactEvidence(promotionEvidence, adjustedQ),
        historical: compactEvidence(finalized.metrics.fullRun, adjustedQ),
        recent_window: compactEvidence(finalized.metrics.detailWindow, adjustedQ),
        statistical_population: finalized.metrics.statisticalPopulation
      } : {
        sample_count: 0,
        historical: null,
        recent_window: null,
        statistical_population: null
      },
      replay_digest: finalized?.replayDigest ?? null
    }
    modelReplay.promotion_simulation = promotionEvidence
      ? promotionSimulation(registration, promotionEvidence, finalized.replayDigest)
      : null
    models[registration.model_name] = modelReplay
  }

  const reportWithoutDigest = {
    report_version: 'lai-v3-replay-v1',
    read_only: true,
    source: input.source || 'memory',
    game: { type: gameType, name: config.name },
    seed,
    data: {
      draw_count: draws.length,
      first_draw_date: draws[0].draw_date,
      data_cutoff: draws.at(-1).draw_date,
      draw_snapshot_digest: stringifyDigest(draws)
    },
    replay_configuration: {
      coverage_simulations: coverageSimulations,
      resampling: input.resampling ?? null
    },
    baseline: {
      registration: publicRegistration(baseline),
      evaluated_draws: baselineScores.sample_count,
      score_summary: finalizeScoreSummary(baselineScores),
      coverage: finalizeCoverage(baselineCoverage),
      second_area: config.secondaryNumber ? finalizeCoverage(baselineCoverage).special_area : null
    },
    metrics: { models }
  }

  return {
    ...reportWithoutDigest,
    replay_digest: stringifyDigest(reportWithoutDigest)
  }
}

export async function writeReplayReport(output, report) {
  const destination = validateReplayOutputPath(output)
  await mkdir(dirname(destination), { recursive: true })
  await writeFile(destination, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  return destination
}

function resolveCurrentCodeCommit() {
  const fromEnvironment = process.env.LOTTO_CODE_COMMIT
  if (CODE_COMMIT_PATTERN.test(fromEnvironment ?? '')) return fromEnvironment
  try {
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT_DIR, encoding: 'utf8' }).trim()
    if (CODE_COMMIT_PATTERN.test(commit)) return commit
  } catch {
    // The command below reports the actionable failure without fabricating a code version.
  }
  throw new Error('Unable to resolve a valid Git code commit for the replay')
}

export async function runCli(argv = process.argv.slice(2), environment = process.env) {
  const args = parseArgs(argv)
  const draws = args.source === 'local'
    ? await loadLocalReplayDraws(args.game)
    : await loadSupabaseReplayDraws({
      gameType: args.game,
      supabaseUrl: environment.SUPABASE_URL,
      serviceRoleKey: environment.SUPABASE_SERVICE_ROLE_KEY
    })
  const report = await runReplay({
    gameType: args.game,
    source: args.source,
    seed: args.seed,
    draws,
    registrations: defaultReplayRegistrations(args.game, resolveCurrentCodeCommit())
  })
  if (args.output) await writeReplayReport(args.output, report)
  return report
}

async function main() {
  try {
    const report = await runCli()
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  } catch (error) {
    process.stderr.write(`${JSON.stringify({
      Status: 'failed',
      RootCause: error instanceof Error ? error.message : String(error),
      SuggestedFix: '確認 --game、--source、--seed、歷史資料格式與唯讀 Supabase 環境變數。'
    })}\n`)
    process.exitCode = 1
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main()
}
