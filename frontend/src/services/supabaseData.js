import { filterVisiblePredictions } from './predictionVisibility'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL?.replace(/\/+$/, '')
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

export const isSupabaseConfigured = Boolean(supabaseUrl && supabaseAnonKey)

const headers = {
  apikey: supabaseAnonKey || '',
  Authorization: `Bearer ${supabaseAnonKey || ''}`
}

async function request(path) {
  if (!isSupabaseConfigured) {
    throw new Error('Supabase is not configured')
  }

  const response = await fetch(`${supabaseUrl}/rest/v1/${path}`, { headers })
  if (!response.ok) {
    throw new Error(`Supabase request failed: ${response.status} ${response.statusText}`)
  }

  return response.json()
}

async function requestAll(path, pageSize = 1000) {
  const rows = []
  let offset = 0

  while (true) {
    const separator = path.includes('?') ? '&' : '?'
    const page = await request(`${path}${separator}limit=${pageSize}&offset=${offset}`)
    rows.push(...page)

    if (page.length < pageSize) {
      return rows
    }

    offset += pageSize
  }
}

async function requestOptionalAll(path, pageSize = 1000) {
  try {
    return await requestAll(path, pageSize)
  } catch (error) {
    console.warn('Optional Supabase data unavailable:', error)
    return []
  }
}

function mapDraw(row) {
  return {
    draw_id: row.draw_id,
    date: row.draw_date,
    numbers: row.numbers,
    special_number: row.special_number
  }
}

function mapPrediction(row) {
  return {
    source_key: row.source_key,
    timestamp: row.predicted_at,
    target_draw_date: row.target_draw_date,
    game_name: row.game_name,
    prediction: row.prediction,
    is_evaluated: row.is_evaluated,
    evaluation: row.evaluation
  }
}

function mapAsiLearning(row) {
  return {
    game_name: row.game_name,
    target_draw_date: row.target_draw_date,
    draw_id: row.draw_id,
    matched_numbers: row.matched_numbers || [],
    missed_numbers: row.missed_numbers || [],
    actual_numbers: row.actual_numbers || [],
    strategy_effectiveness: row.strategy_effectiveness || {},
    next_adjustments: row.next_adjustments || [],
    reasoning_source: row.reasoning_source,
    model_name: row.model_name,
    created_at: row.created_at
  }
}

export async function fetchSupabaseLottoData() {
  const [
    metaRows,
    predictionRows,
    lottoRows,
    dailyRows,
    performanceRows,
    learningRows
  ] = await Promise.all([
    request('app_meta?meta_key=eq.current&select=payload&limit=1'),
    requestAll('prediction_records?select=source_key,predicted_at,target_draw_date,game_name,prediction,is_evaluated,evaluation&order=target_draw_date.asc,predicted_at.asc'),
    requestAll('lotto_draws?game_name=eq.%E5%A4%A7%E6%A8%82%E9%80%8F&select=draw_id,draw_date,numbers,special_number&order=draw_date.asc'),
    requestAll('lotto_draws?game_name=eq.%E4%BB%8A%E5%BD%A9539&select=draw_id,draw_date,numbers,special_number&order=draw_date.asc'),
    request('performance_snapshots?snapshot_key=eq.current&select=payload&limit=1'),
    requestOptionalAll('asi_learning_records?select=game_name,target_draw_date,draw_id,matched_numbers,missed_numbers,actual_numbers,strategy_effectiveness,next_adjustments,reasoning_source,model_name,created_at&order=target_draw_date.asc,created_at.asc')
  ])

  if (!metaRows[0]?.payload || !lottoRows.length || !dailyRows.length) {
    throw new Error('Supabase data is empty')
  }

  return {
    meta: metaRows[0].payload,
    predictions: filterVisiblePredictions(predictionRows.map(mapPrediction)),
    history: {
      '大樂透': lottoRows.map(mapDraw),
      '今彩539': dailyRows.map(mapDraw)
    },
    performance: performanceRows[0]?.payload || null,
    asiLearning: learningRows.map(mapAsiLearning)
  }
}
