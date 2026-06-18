import { ref } from 'vue'
import { fetchSupabaseLottoData, isSupabaseConfigured } from '../services/supabaseData'

export function useLottoData() {
  const meta = ref(null)
  const predictions = ref([])
  const history = ref({
    '大樂透': [],
    '今彩539': []
  })
  const performance = ref(null)
  const asiLearning = ref([])
  const loading = ref(true)
  const error = ref(null)

  // [修正] 使用相對基底路徑，確保 GitHub Pages 子目錄佈署時能正確解析 /data 路徑
  const dataBaseUrl = import.meta.env.VITE_DATA_URL || (import.meta.env.BASE_URL + 'data').replace(/\/+$/, '')

  const fetchJsonData = async () => {
    // 由於可能存在跨域或路徑問題，這裡加入時間戳防止快取
    const timestamp = new Date().getTime()

    const metaRes = await fetch(`${dataBaseUrl}/meta.json?t=${timestamp}`)
    if (metaRes.ok) {
      meta.value = await metaRes.json()
    }

    const predRes = await fetch(`${dataBaseUrl}/predictions.json?t=${timestamp}`)
    if (predRes.ok) {
      predictions.value = await predRes.json()
    }

    // 載入歷史資料供圖表使用
    const lottoRes = await fetch(`${dataBaseUrl}/lotto649.json?t=${timestamp}`)
    if (lottoRes.ok) {
      history.value['大樂透'] = await lottoRes.json()
    }

    const dailyRes = await fetch(`${dataBaseUrl}/daily539.json?t=${timestamp}`)
    if (dailyRes.ok) {
      history.value['今彩539'] = await dailyRes.json()
    }

    const perfRes = await fetch(`${dataBaseUrl}/performance.json?t=${timestamp}`)
    if (perfRes.ok) {
      performance.value = await perfRes.json()
    }

    asiLearning.value = []
  }

  const applySupabaseData = (payload) => {
    meta.value = payload.meta
    predictions.value = payload.predictions
    history.value = payload.history
    performance.value = payload.performance
    asiLearning.value = payload.asiLearning || []
  }

  const fetchData = async () => {
    loading.value = true
    error.value = null
    try {
      if (isSupabaseConfigured) {
        try {
          applySupabaseData(await fetchSupabaseLottoData())
          return
        } catch (supabaseError) {
          console.warn('Supabase data unavailable, falling back to static JSON:', supabaseError)
        }
      }

      await fetchJsonData()
      
    } catch (err) {
      console.error("Fetch Data Error:", err)
      error.value = err.message
    } finally {
      loading.value = false
    }
  }

  return {
    meta,
    predictions,
    history,
    performance,
    asiLearning,
    loading,
    error,
    fetchData
  }
}
