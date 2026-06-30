<script setup>
import { computed, onMounted, ref } from 'vue'
import { useLottoData } from './composables/useLottoData'
import PredictionCard from './components/PredictionCard.vue'
import StatsPanel from './components/StatsPanel.vue'
import HotColdChart from './components/HotColdChart.vue'
import PerformanceChart from './components/PerformanceChart.vue'
import AttributionReport from './components/AttributionReport.vue'
import PredictionHistoryPanel from './components/PredictionHistoryPanel.vue'
import AsiLearningPanel from './components/AsiLearningPanel.vue'
import HeatmapChart from './components/HeatmapChart.vue'
import IntervalAnalysis from './components/IntervalAnalysis.vue'
import RandomnessAudit from './components/RandomnessAudit.vue'
import DistributionChart from './components/DistributionChart.vue'
import SectionHeader from './components/SectionHeader.vue'

const { meta, predictions, history, performance, asiLearning, loading, error, fetchData } = useLottoData()
const activeTab = ref('649')

const pageThemes = {
  '649': {
    background: 'linear-gradient(145deg,#031015 0%,#071827 46%,#09111f 100%)',
    orbA: 'radial-gradient(circle,rgba(45,212,191,0.16) 0%,rgba(45,212,191,0.04) 36%,transparent 72%)',
    orbB: 'radial-gradient(circle,rgba(14,116,144,0.18) 0%,rgba(59,130,246,0.05) 42%,transparent 72%)',
    orbC: 'radial-gradient(circle,rgba(34,197,94,0.08) 0%,transparent 68%)',
    liveColor: '#2dd4bf',
    liveGlow: 'rgba(45,212,191,0.85)',
    headline: 'linear-gradient(135deg,#5eead4 0%,#38bdf8 48%,#60a5fa 100%)',
  },
  '539': {
    background: 'linear-gradient(145deg,#12091a 0%,#1c1027 42%,#19111c 100%)',
    orbA: 'radial-gradient(circle,rgba(167,139,250,0.18) 0%,rgba(167,139,250,0.05) 38%,transparent 72%)',
    orbB: 'radial-gradient(circle,rgba(236,72,153,0.16) 0%,rgba(251,191,36,0.05) 44%,transparent 74%)',
    orbC: 'radial-gradient(circle,rgba(251,191,36,0.11) 0%,transparent 68%)',
    liveColor: '#fbbf24',
    liveGlow: 'rgba(251,191,36,0.78)',
    headline: 'linear-gradient(135deg,#fbbf24 0%,#ec4899 46%,#a78bfa 100%)',
  },
  'power': {
    background: 'linear-gradient(145deg,#120807 0%,#1f1213 45%,#211506 100%)',
    orbA: 'radial-gradient(circle,rgba(245,158,11,0.18) 0%,rgba(245,158,11,0.05) 38%,transparent 72%)',
    orbB: 'radial-gradient(circle,rgba(225,29,72,0.16) 0%,rgba(251,191,36,0.05) 44%,transparent 74%)',
    orbC: 'radial-gradient(circle,rgba(251,113,133,0.10) 0%,transparent 68%)',
    liveColor: '#f59e0b',
    liveGlow: 'rgba(245,158,11,0.82)',
    headline: 'linear-gradient(135deg,#fde68a 0%,#f59e0b 44%,#fb7185 100%)',
  },
}

const activeTheme = computed(() => pageThemes[activeTab.value])

onMounted(() => {
  fetchData()
})

const formatDate = (iso) => {
  if (!iso) return '--'
  return new Date(iso).toLocaleString('zh-TW', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit'
  })
}
</script>

<template>
  <div
    class="min-h-screen"
    :style="{
      background: activeTheme.background,
      fontFamily: `'Inter', 'Noto Sans TC', system-ui, sans-serif`,
      transition: 'background 260ms ease-out'
    }"
  >

    <!-- Ambient background blobs -->
    <div class="fixed inset-0 overflow-hidden pointer-events-none">
      <div :style="{ position:'absolute', top:'-15%', left:'-10%', width:'55%', height:'55%', background:activeTheme.orbA, filter:'blur(60px)', transition:'background 260ms ease-out' }"></div>
      <div :style="{ position:'absolute', top:'40%', right:'-10%', width:'55%', height:'55%', background:activeTheme.orbB, filter:'blur(60px)', transition:'background 260ms ease-out' }"></div>
      <div :style="{ position:'absolute', bottom:'-10%', left:'30%', width:'40%', height:'40%', background:activeTheme.orbC, filter:'blur(60px)', transition:'background 260ms ease-out' }"></div>
    </div>

    <div class="relative" style="max-width:1200px;margin:0 auto;padding:40px 20px 80px;">

      <!-- ══ HEADER ══ -->
      <header style="text-align:center;margin-bottom:48px;">
        <div style="display:inline-flex;align-items:center;gap:10px;margin-bottom:16px;">
          <div :style="{ width:'10px', height:'10px', borderRadius:'50%', background:activeTheme.liveColor, boxShadow:`0 0 12px ${activeTheme.liveGlow}`, animation:'pulse 2s infinite' }"></div>
          <span style="font-size:16px;font-weight:600;color:#64748b;letter-spacing:0.15em;text-transform:uppercase;">Live Dashboard</span>
        </div>
        <h1 :style="{ fontSize:'clamp(2rem,5vw,3.5rem)', fontWeight:'900', background:activeTheme.headline, WebkitBackgroundClip:'text', WebkitTextFillColor:'transparent', backgroundClip:'text', margin:'0 0 12px', lineHeight:'1.1', transition:'background 260ms ease-out' }">
          小賽 AI 樂透預測
        </h1>
        <p style="color:#64748b;font-size:1.05rem;max-width:560px;margin:0 auto 24px;line-height:1.6;">
          結合公正性統計檢定 × 博弈論期望值最佳化，全自動、不預測號碼的誠實樂透儀表板
        </p>

        <!-- Status badges -->
        <div style="display:flex;flex-wrap:wrap;justify-content:center;gap:10px;">
          <div style="display:inline-flex;align-items:center;gap:8px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);border-radius:100px;padding:6px 16px;">
            <span style="font-size:15px;color:#94a3b8;">系統狀態</span>
            <span v-if="loading" style="display:flex;align-items:center;gap:6px;color:#f59e0b;font-size:15px;">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="animation:spin 1s linear infinite;"><path d="M21 12a9 9 0 11-6.219-8.56"/></svg>
              同步中...
            </span>
            <span v-else-if="error" style="color:#f43f5e;font-size:15px;">⚠ 連線失敗</span>
            <span v-else style="display:flex;align-items:center;gap:6px;color:#10b981;font-size:15px;">
              <span style="width:6px;height:6px;border-radius:50%;background:#10b981;box-shadow:0 0 8px #10b981;"></span>
              在線且最新
            </span>
          </div>
          <div v-if="meta && !loading" style="display:inline-flex;align-items:center;gap:8px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);border-radius:100px;padding:6px 16px;">
            <span style="font-size:15px;color:#94a3b8;">最後更新</span>
            <span style="font-size:15px;color:#cbd5e1;">{{ formatDate(meta.last_updated) }}</span>
          </div>
          <div v-if="meta && !loading" style="display:inline-flex;align-items:center;gap:8px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);border-radius:100px;padding:6px 16px;">
            <span style="font-size:15px;color:#94a3b8;">大樂透期數</span>
            <span style="font-size:15px;font-weight:700;color:#2dd4bf;">{{ meta.lotto649_total }} 期</span>
          </div>
          <div v-if="meta && !loading" style="display:inline-flex;align-items:center;gap:8px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);border-radius:100px;padding:6px 16px;">
            <span style="font-size:15px;color:#94a3b8;">今彩539期數</span>
            <span style="font-size:15px;font-weight:700;color:#a78bfa;">{{ meta.daily539_total }} 期</span>
          </div>
          <div v-if="meta && !loading" style="display:inline-flex;align-items:center;gap:8px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);border-radius:100px;padding:6px 16px;">
            <span style="font-size:15px;color:#94a3b8;">威力彩期數</span>
            <span style="font-size:15px;font-weight:700;color:#f59e0b;">{{ meta.power_total }} 期</span>
          </div>
        </div>
      </header>

      <!-- ══ LOADING STATE ══ -->
      <div v-if="loading" style="text-align:center;padding:80px 0;">
        <div style="display:inline-block;width:48px;height:48px;border:3px solid rgba(45,212,191,0.2);border-top-color:#2dd4bf;border-radius:50%;animation:spin 0.8s linear infinite;margin-bottom:20px;"></div>
        <p style="color:#475569;">正在載入預測數據...</p>
      </div>

      <!-- ══ ERROR STATE ══ -->
      <div v-else-if="error" style="background:rgba(244,63,94,0.08);border:1px solid rgba(244,63,94,0.3);border-radius:16px;padding:32px;text-align:center;margin-bottom:32px;">
        <p style="color:#f43f5e;margin-bottom:16px;">無法載入資料：{{ error }}</p>
        <button @click="fetchData" style="background:rgba(244,63,94,0.15);color:#f87171;border:1px solid rgba(244,63,94,0.3);border-radius:8px;padding:8px 20px;cursor:pointer;font-size:17px;">重新嘗試</button>
      </div>

      <!-- ══ MAIN CONTENT ══ -->
      <div v-else>

        <!-- Tab switcher -->
        <div style="display:flex;gap:4px;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.07);border-radius:14px;padding:4px;margin-bottom:32px;width:fit-content;">
          <button @click="activeTab='649'"
            :style="{
              padding:'10px 28px', borderRadius:'10px', border:'none', cursor:'pointer',
              fontWeight:'700', fontSize:'17px', transition:'all 0.2s',
              background: activeTab==='649' ? 'linear-gradient(135deg,#0e7490,#1d4ed8)' : 'transparent',
              color: activeTab==='649' ? '#fff' : '#64748b',
              boxShadow: activeTab==='649' ? '0 2px 12px rgba(45,212,191,0.25)' : 'none'
            }">
            🎯 大樂透
          </button>
          <button @click="activeTab='539'"
            :style="{
              padding:'10px 28px', borderRadius:'10px', border:'none', cursor:'pointer',
              fontWeight:'700', fontSize:'17px', transition:'all 0.2s',
              background: activeTab==='539' ? 'linear-gradient(135deg,#6d28d9,#9333ea)' : 'transparent',
              color: activeTab==='539' ? '#fff' : '#64748b',
              boxShadow: activeTab==='539' ? '0 2px 12px rgba(167,139,250,0.25)' : 'none'
            }">
            ⚡ 今彩539
          </button>
          <button @click="activeTab='power'"
            :style="{
              padding:'10px 28px', borderRadius:'10px', border:'none', cursor:'pointer',
              fontWeight:'700', fontSize:'17px', transition:'all 0.2s',
              background: activeTab==='power' ? 'linear-gradient(135deg,#b45309,#e11d48)' : 'transparent',
              color: activeTab==='power' ? '#fff' : '#64748b',
              boxShadow: activeTab==='power' ? '0 2px 12px rgba(245,158,11,0.28)' : 'none'
            }">
            威力彩
          </button>
        </div>

        <!-- 大樂透 -->
        <div v-show="activeTab==='649'" style="display:flex;flex-direction:column;gap:56px;">

          <!-- 區塊一：AI 預測與統計 -->
          <section>
            <SectionHeader label="Fairness & Strategy" title="公正性健診 + 博弈選號"
              desc="每期公正性統計健診，並提供避開大眾號的博弈低均分選號" accent="#2dd4bf" />
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:24px;" class="responsive-grid">
              <PredictionCard game-name="大樂透" :prediction-data="predictions"
                :history-data="history['大樂透']" accent="#2dd4bf" />
              <StatsPanel game-name="大樂透" :history-data="history['大樂透']"
                :max-number="49" accent="#2dd4bf" />
            </div>
          </section>

          <!-- 區塊二：號碼分析 -->
          <section>
            <SectionHeader label="Number Analysis" title="號碼熱度與分佈"
              desc="從全歷史與近期視窗觀察號碼頻率、熱力分佈與奇偶大小結構" accent="#2dd4bf" />
            <div style="display:flex;flex-direction:column;gap:24px;">
              <HotColdChart game-name="大樂透" :history-data="history['大樂透']"
                :max-number="49" accent="#2dd4bf" />
              <HeatmapChart game-name="大樂透" :history-data="history['大樂透']" />
              <IntervalAnalysis game-name="大樂透" :history-data="history['大樂透']"
                :max-number="49" accent="#2dd4bf" />
              <DistributionChart game-name="大樂透" :history-data="history['大樂透']" />
            </div>
          </section>

          <!-- 區塊三：成效追蹤 -->
          <section>
            <SectionHeader label="Performance" title="選號成效追蹤"
              desc="歷次對獎的命中率與走勢（與隨機基準對照）" accent="#2dd4bf" />
            <div style="display:flex;flex-direction:column;gap:24px;">
              <AttributionReport
                :prediction="[...predictions].reverse().find(p => p.game_name === '大樂透')" />
              <PredictionHistoryPanel game-name="大樂透" :prediction-data="predictions" accent="#2dd4bf" />
              <AsiLearningPanel game-name="大樂透" :records="asiLearning" accent="#2dd4bf" />
              <PerformanceChart game-name="大樂透" :performance-data="performance" />
            </div>
          </section>

          <!-- 區塊四：公正性稽核 -->
          <section>
            <SectionHeader label="Fairness Audit" title="開獎公正性稽核"
              desc="用多種統計檢定，從全歷史資料驗證開獎是否真隨機、有無人為操控指紋" accent="#2dd4bf" />
            <RandomnessAudit game-name="大樂透" :history-data="history['大樂透']"
              :max-number="49" :balls-per-draw="6" :has-special="true" accent="#2dd4bf" />
          </section>
        </div>

        <!-- 今彩539 -->
        <div v-show="activeTab==='539'" style="display:flex;flex-direction:column;gap:56px;">

          <!-- 區塊一：AI 預測與統計 -->
          <section>
            <SectionHeader label="Fairness & Strategy" title="公正性健診 + 博弈選號"
              desc="每期公正性統計健診，並提供避開大眾號的博弈低均分選號" accent="#a78bfa" />
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:24px;" class="responsive-grid">
              <PredictionCard game-name="今彩539" :prediction-data="predictions"
                :history-data="history['今彩539']" accent="#a78bfa" />
              <StatsPanel game-name="今彩539" :history-data="history['今彩539']"
                :max-number="39" accent="#a78bfa" />
            </div>
          </section>

          <!-- 區塊二：號碼分析 -->
          <section>
            <SectionHeader label="Number Analysis" title="號碼熱度與分佈"
              desc="從全歷史與近期視窗觀察號碼頻率、熱力分佈與奇偶大小結構" accent="#a78bfa" />
            <div style="display:flex;flex-direction:column;gap:24px;">
              <HotColdChart game-name="今彩539" :history-data="history['今彩539']"
                :max-number="39" accent="#a78bfa" />
              <HeatmapChart game-name="今彩539" :history-data="history['今彩539']" />
              <IntervalAnalysis game-name="今彩539" :history-data="history['今彩539']"
                :max-number="39" accent="#a78bfa" />
              <DistributionChart game-name="今彩539" :history-data="history['今彩539']" />
            </div>
          </section>

          <!-- 區塊三：成效追蹤 -->
          <section>
            <SectionHeader label="Performance" title="選號成效追蹤"
              desc="歷次對獎的命中率與走勢（與隨機基準對照）" accent="#a78bfa" />
            <div style="display:flex;flex-direction:column;gap:24px;">
              <AttributionReport
                :prediction="[...predictions].reverse().find(p => p.game_name === '今彩539')" />
              <PredictionHistoryPanel game-name="今彩539" :prediction-data="predictions" accent="#a78bfa" />
              <AsiLearningPanel game-name="今彩539" :records="asiLearning" accent="#a78bfa" />
              <PerformanceChart game-name="今彩539" :performance-data="performance" />
            </div>
          </section>

          <!-- 區塊四：公正性稽核 -->
          <section>
            <SectionHeader label="Fairness Audit" title="開獎公正性稽核"
              desc="用多種統計檢定，從全歷史資料驗證開獎是否真隨機、有無人為操控指紋" accent="#a78bfa" />
            <RandomnessAudit game-name="今彩539" :history-data="history['今彩539']"
              :max-number="39" :balls-per-draw="5" :has-special="false" accent="#a78bfa" />
          </section>
        </div>

        <!-- 威力彩 -->
        <div v-show="activeTab==='power'" style="display:flex;flex-direction:column;gap:56px;">

          <!-- 區塊一：AI 預測與統計 -->
          <section>
            <SectionHeader label="Fairness & Strategy" title="公正性健診 + 博弈選號"
              desc="每期公正性統計健診，並提供第一區與第二區的博弈低均分選號" accent="#f59e0b" />
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:24px;" class="responsive-grid">
              <PredictionCard game-name="威力彩" :prediction-data="predictions"
                :history-data="history['威力彩']" accent="#f59e0b" />
              <StatsPanel game-name="威力彩" :history-data="history['威力彩']"
                :max-number="38" accent="#f59e0b" />
            </div>
          </section>

          <!-- 區塊二：號碼分析 -->
          <section>
            <SectionHeader label="Number Analysis" title="號碼熱度與分佈"
              desc="從全歷史與近期視窗觀察第一區號碼頻率、熱力分佈與奇偶大小結構" accent="#f59e0b" />
            <div style="display:flex;flex-direction:column;gap:24px;">
              <HotColdChart game-name="威力彩" :history-data="history['威力彩']"
                :max-number="38" accent="#f59e0b" />
              <HeatmapChart game-name="威力彩" :history-data="history['威力彩']" />
              <IntervalAnalysis game-name="威力彩" :history-data="history['威力彩']"
                :max-number="38" accent="#f59e0b" />
              <DistributionChart game-name="威力彩" :history-data="history['威力彩']" />
            </div>
          </section>

          <!-- 區塊三：成效追蹤 -->
          <section>
            <SectionHeader label="Performance" title="選號成效追蹤"
              desc="歷次對獎的命中率與走勢（與隨機基準對照）" accent="#f59e0b" />
            <div style="display:flex;flex-direction:column;gap:24px;">
              <AttributionReport
                :prediction="[...predictions].reverse().find(p => p.game_name === '威力彩')" />
              <PredictionHistoryPanel game-name="威力彩" :prediction-data="predictions" accent="#f59e0b" />
              <AsiLearningPanel game-name="威力彩" :records="asiLearning" accent="#f59e0b" />
              <PerformanceChart game-name="威力彩" :performance-data="performance" />
            </div>
          </section>

          <!-- 區塊四：公正性稽核 -->
          <section>
            <SectionHeader label="Fairness Audit" title="開獎公正性稽核"
              desc="用多種統計檢定，從全歷史資料驗證威力彩第一區是否真隨機、有無人為操控指紋" accent="#f59e0b" />
            <RandomnessAudit game-name="威力彩" :history-data="history['威力彩']"
              :max-number="38" :balls-per-draw="6" :has-special="true" accent="#f59e0b" />
          </section>
        </div>
      </div>

      <!-- Footer -->
      <footer style="text-align:center;margin-top:60px;padding-top:32px;border-top:1px solid rgba(255,255,255,0.06);">
        <p style="font-size:15px;color:#334155;">
          ⚠️ 本系統僅供娛樂參考，不構成任何投注建議。請理性投注，勿過度沉迷。
        </p>
        <p style="font-size:14px;color:#1e293b;margin-top:8px;">
          由 公正性統計檢定 × 博弈論 × Supabase Edge Functions 全自動驅動 · 資料來源：台灣彩券官方網站
        </p>
        <p style="font-size:14px;color:#334155;margin-top:12px;line-height:2.2;">
          <a href="/guides.html" style="color:#64748b;text-decoration:none;border-bottom:1px solid rgba(100,116,139,0.35);margin-right:14px;">
            方法與文章
          </a>
          <a href="/game-lotto649.html" style="color:#64748b;text-decoration:none;border-bottom:1px solid rgba(100,116,139,0.35);margin-right:14px;">
            大樂透
          </a>
          <a href="/game-daily539.html" style="color:#64748b;text-decoration:none;border-bottom:1px solid rgba(100,116,139,0.35);margin-right:14px;">
            今彩539
          </a>
          <a href="/game-superlotto.html" style="color:#64748b;text-decoration:none;border-bottom:1px solid rgba(100,116,139,0.35);margin-right:14px;">
            威力彩
          </a>
          <a href="/faq.html" style="color:#64748b;text-decoration:none;border-bottom:1px solid rgba(100,116,139,0.35);margin-right:14px;">
            常見問題
          </a>
          <a href="/about.html" style="color:#64748b;text-decoration:none;border-bottom:1px solid rgba(100,116,139,0.35);margin-right:14px;">
            關於
          </a>
          <a href="/contact.html" style="color:#64748b;text-decoration:none;border-bottom:1px solid rgba(100,116,139,0.35);margin-right:14px;">
            聯絡
          </a>
          <a href="/privacy" style="color:#64748b;text-decoration:none;border-bottom:1px solid rgba(100,116,139,0.35);">
            隱私權政策
          </a>
        </p>
      </footer>
    </div>
  </div>
</template>

<style>
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;900&display=swap');

* { box-sizing: border-box; margin: 0; padding: 0; }

@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.3; }
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

@media (max-width: 768px) {
  .responsive-grid {
    grid-template-columns: 1fr !important;
  }
}
</style>
