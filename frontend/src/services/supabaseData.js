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
    timestamp: row.predicted_at,
    game_name: row.game_name,
    prediction: row.prediction,
    is_evaluated: row.is_evaluated,
    evaluation: row.evaluation
  }
}

export async function fetchSupabaseLottoData() {
  const [
    metaRows,
    predictionRows,
    lottoRows,
    dailyRows,
    performanceRows
  ] = await Promise.all([
    request('app_meta?meta_key=eq.current&select=payload&limit=1'),
    requestAll('prediction_records?select=predicted_at,game_name,prediction,is_evaluated,evaluation&order=predicted_at.asc'),
    requestAll('lotto_draws?game_name=eq.%E5%A4%A7%E6%A8%82%E9%80%8F&select=draw_id,draw_date,numbers,special_number&order=draw_date.asc'),
    requestAll('lotto_draws?game_name=eq.%E4%BB%8A%E5%BD%A9539&select=draw_id,draw_date,numbers,special_number&order=draw_date.asc'),
    request('performance_snapshots?snapshot_key=eq.current&select=payload&limit=1')
  ])

  if (!metaRows[0]?.payload || !lottoRows.length || !dailyRows.length) {
    throw new Error('Supabase data is empty')
  }

  return {
    meta: metaRows[0].payload,
    predictions: predictionRows.map(mapPrediction),
    history: {
      '大樂透': lottoRows.map(mapDraw),
      '今彩539': dailyRows.map(mapDraw)
    },
    performance: performanceRows[0]?.payload || null
  }
}
