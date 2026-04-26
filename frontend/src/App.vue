<script setup>
import { onMounted, ref } from 'vue'
import { useLottoData } from './composables/useLottoData'
import PredictionCard from './components/PredictionCard.vue'
import StatsPanel from './components/StatsPanel.vue'
import HotColdChart from './components/HotColdChart.vue'
import PerformanceChart from './components/PerformanceChart.vue'
import AttributionReport from './components/AttributionReport.vue'
import HeatmapChart from './components/HeatmapChart.vue'
import DistributionChart from './components/DistributionChart.vue'

const { meta, predictions, history, performance, loading, error, fetchData } = useLottoData()
const activeTab = ref('649')

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
  <div class="min-h-screen" style="background: #080c14; font-family: 'Inter', 'Noto Sans TC', system-ui, sans-serif;">

    <!-- Ambient background blobs -->
    <div class="fixed inset-0 overflow-hidden pointer-events-none">
      <div style="position:absolute;top:-15%;left:-10%;width:55%;height:55%;background:radial-gradient(circle,rgba(45,212,191,0.08) 0%,transparent 70%);filter:blur(60px);"></div>
      <div style="position:absolute;top:40%;right:-10%;width:55%;height:55%;background:radial-gradient(circle,rgba(139,92,246,0.08) 0%,transparent 70%);filter:blur(60px);"></div>
      <div style="position:absolute;bottom:-10%;left:30%;width:40%;height:40%;background:radial-gradient(circle,rgba(59,130,246,0.06) 0%,transparent 70%);filter:blur(60px);"></div>
    </div>

    <div class="relative" style="max-width:1200px;margin:0 auto;padding:40px 20px 80px;">

      <!-- ══ HEADER ══ -->
      <header style="text-align:center;margin-bottom:48px;">
        <div style="display:inline-flex;align-items:center;gap:10px;margin-bottom:16px;">
          <div style="width:10px;height:10px;border-radius:50%;background:#2dd4bf;box-shadow:0 0 12px rgba(45,212,191,0.8);animation:pulse 2s infinite;"></div>
          <span style="font-size:13px;font-weight:600;color:#64748b;letter-spacing:0.15em;text-transform:uppercase;">Live Dashboard</span>
        </div>
        <h1 style="font-size:clamp(2rem,5vw,3.5rem);font-weight:900;background:linear-gradient(135deg,#2dd4bf 0%,#3b82f6 50%,#a78bfa 100%);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;margin:0 0 12px;line-height:1.1;">
          小賽 AI 樂透預測
        </h1>
        <p style="color:#64748b;font-size:1.05rem;max-width:560px;margin:0 auto 24px;line-height:1.6;">
          結合 Gemini AI 深度推理 × 統計機率分析，全自動數據驅動的開獎預測儀表板
        </p>

        <!-- Status badges -->
        <div style="display:flex;flex-wrap:wrap;justify-content:center;gap:10px;">
          <div style="display:inline-flex;align-items:center;gap:8px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);border-radius:100px;padding:6px 16px;">
            <span style="font-size:12px;color:#94a3b8;">系統狀態</span>
            <span v-if="loading" style="display:flex;align-items:center;gap:6px;color:#f59e0b;font-size:12px;">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="animation:spin 1s linear infinite;"><path d="M21 12a9 9 0 11-6.219-8.56"/></svg>
              同步中...
            </span>
            <span v-else-if="error" style="color:#f43f5e;font-size:12px;">⚠ 連線失敗</span>
            <span v-else style="display:flex;align-items:center;gap:6px;color:#10b981;font-size:12px;">
              <span style="width:6px;height:6px;border-radius:50%;background:#10b981;box-shadow:0 0 8px #10b981;"></span>
              在線且最新
            </span>
          </div>
          <div v-if="meta && !loading" style="display:inline-flex;align-items:center;gap:8px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);border-radius:100px;padding:6px 16px;">
            <span style="font-size:12px;color:#94a3b8;">最後更新</span>
            <span style="font-size:12px;color:#cbd5e1;">{{ formatDate(meta.last_updated) }}</span>
          </div>
          <div v-if="meta && !loading" style="display:inline-flex;align-items:center;gap:8px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);border-radius:100px;padding:6px 16px;">
            <span style="font-size:12px;color:#94a3b8;">大樂透期數</span>
            <span style="font-size:12px;font-weight:700;color:#2dd4bf;">{{ meta.lotto649_total }} 期</span>
          </div>
          <div v-if="meta && !loading" style="display:inline-flex;align-items:center;gap:8px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);border-radius:100px;padding:6px 16px;">
            <span style="font-size:12px;color:#94a3b8;">今彩539期數</span>
            <span style="font-size:12px;font-weight:700;color:#a78bfa;">{{ meta.daily539_total }} 期</span>
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
        <button @click="fetchData" style="background:rgba(244,63,94,0.15);color:#f87171;border:1px solid rgba(244,63,94,0.3);border-radius:8px;padding:8px 20px;cursor:pointer;font-size:14px;">重新嘗試</button>
      </div>

      <!-- ══ MAIN CONTENT ══ -->
      <div v-else>

        <!-- Tab switcher -->
        <div style="display:flex;gap:4px;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.07);border-radius:14px;padding:4px;margin-bottom:32px;width:fit-content;">
          <button @click="activeTab='649'"
            :style="{
              padding:'10px 28px', borderRadius:'10px', border:'none', cursor:'pointer',
              fontWeight:'700', fontSize:'14px', transition:'all 0.2s',
              background: activeTab==='649' ? 'linear-gradient(135deg,#0e7490,#1d4ed8)' : 'transparent',
              color: activeTab==='649' ? '#fff' : '#64748b',
              boxShadow: activeTab==='649' ? '0 2px 12px rgba(45,212,191,0.25)' : 'none'
            }">
            🎯 大樂透
          </button>
          <button @click="activeTab='539'"
            :style="{
              padding:'10px 28px', borderRadius:'10px', border:'none', cursor:'pointer',
              fontWeight:'700', fontSize:'14px', transition:'all 0.2s',
              background: activeTab==='539' ? 'linear-gradient(135deg,#6d28d9,#9333ea)' : 'transparent',
              color: activeTab==='539' ? '#fff' : '#64748b',
              boxShadow: activeTab==='539' ? '0 2px 12px rgba(167,139,250,0.25)' : 'none'
            }">
            ⚡ 今彩539
          </button>
        </div>

        <!-- Main grid -->
        <div style="display:grid;grid-template-columns:1fr;gap:24px;">
          
          <!-- 大樂透 -->
          <div v-show="activeTab==='649'">
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:24px;" class="responsive-grid">
              <PredictionCard
                game-name="大樂透"
                :prediction-data="predictions"
                :history-data="history['大樂透']"
                accent="#2dd4bf"
              />
              <StatsPanel
                game-name="大樂透"
                :history-data="history['大樂透']"
                :max-number="49"
                accent="#2dd4bf"
              />
            </div>
            <div style="margin-top:24px;">
              <HotColdChart
                game-name="大樂透"
                :history-data="history['大樂透']"
                :max-number="49"
                accent="#2dd4bf"
              />
              <HeatmapChart
                game-name="大樂透"
                :history-data="history['大樂透']"
              />
              <DistributionChart
                game-name="大樂透"
                :history-data="history['大樂透']"
              />
              <AttributionReport
                :prediction="[...predictions].reverse().find(p => p.game_name === '大樂透')"
              />
              <PerformanceChart
                game-name="大樂透"
                :performance-data="performance"
              />
            </div>
          </div>

          <!-- 今彩539 -->
          <div v-show="activeTab==='539'">
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:24px;" class="responsive-grid">
              <PredictionCard
                game-name="今彩539"
                :prediction-data="predictions"
                :history-data="history['今彩539']"
                accent="#a78bfa"
              />
              <StatsPanel
                game-name="今彩539"
                :history-data="history['今彩539']"
                :max-number="39"
                accent="#a78bfa"
              />
            </div>
            <div style="margin-top:24px;">
              <HotColdChart
                game-name="今彩539"
                :history-data="history['今彩539']"
                :max-number="39"
                accent="#a78bfa"
              />
              <HeatmapChart
                game-name="今彩539"
                :history-data="history['今彩539']"
              />
              <DistributionChart
                game-name="今彩539"
                :history-data="history['今彩539']"
              />
              <AttributionReport
                :prediction="[...predictions].reverse().find(p => p.game_name === '今彩539')"
              />
              <PerformanceChart
                game-name="今彩539"
                :performance-data="performance"
              />
            </div>
          </div>

        </div>
      </div>

      <!-- Footer -->
      <footer style="text-align:center;margin-top:60px;padding-top:32px;border-top:1px solid rgba(255,255,255,0.06);">
        <p style="font-size:12px;color:#334155;">
          ⚠️ 本系統僅供娛樂參考，不構成任何投注建議。請理性投注，勿過度沉迷。
        </p>
        <p style="font-size:11px;color:#1e293b;margin-top:8px;">
          由 Gemini AI × GitHub Actions 全自動驅動 · 資料來源：台灣彩券官方網站
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
