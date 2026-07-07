<script setup>
import { computed, onMounted, ref } from 'vue'
import { useLottoData } from './composables/useLottoData'
import PredictionCard from './components/PredictionCard.vue'
import StatsPanel from './components/StatsPanel.vue'
import HotColdChart from './components/HotColdChart.vue'
import HeatmapChart from './components/HeatmapChart.vue'
import IntervalAnalysis from './components/IntervalAnalysis.vue'
import DistributionChart from './components/DistributionChart.vue'
import RandomnessAudit from './components/RandomnessAudit.vue'
import SectionHeader from './components/SectionHeader.vue'
import NumberEcgChart from './components/NumberEcgChart.vue'
import MethodologyPanel from './components/MethodologyPanel.vue'
import HonestyDisclosure from './components/HonestyDisclosure.vue'
import BacktestDashboard from './components/BacktestDashboard.vue'

const { meta, predictions, history, performance, asiLearning, loading, error, fetchData } = useLottoData()
const activeTab = ref('649')

// 每個彩種：資料設定 + 主題（背景漸層由 pageThemes 保留；accent 三色注入為 CSS 變數）。
const GAMES = [
  { key: '649', name: '大樂透', max: 49, balls: 6, special: true, tab: '🎯 大樂透', accent: '#2dd4bf', accentSoft: 'rgba(45,212,191,0.10)', accentGlow: 'rgba(45,212,191,0.35)' },
  { key: '539', name: '今彩539', max: 39, balls: 5, special: false, tab: '⚡ 今彩539', accent: '#a78bfa', accentSoft: 'rgba(167,139,250,0.10)', accentGlow: 'rgba(167,139,250,0.35)' },
  { key: 'power', name: '威力彩', max: 38, balls: 6, special: true, tab: '威力彩', accent: '#f59e0b', accentSoft: 'rgba(245,158,11,0.10)', accentGlow: 'rgba(245,158,11,0.35)' },
]

const pageThemes = {
  '649': {
    background: 'linear-gradient(145deg,#031015 0%,#071827 46%,#09111f 100%)',
    orbA: 'radial-gradient(circle,rgba(45,212,191,0.16) 0%,rgba(45,212,191,0.04) 36%,transparent 72%)',
    orbB: 'radial-gradient(circle,rgba(14,116,144,0.18) 0%,rgba(59,130,246,0.05) 42%,transparent 72%)',
    orbC: 'radial-gradient(circle,rgba(34,197,94,0.08) 0%,transparent 68%)',
    liveColor: '#2dd4bf', liveGlow: 'rgba(45,212,191,0.85)',
    headline: 'linear-gradient(135deg,#5eead4 0%,#38bdf8 48%,#60a5fa 100%)',
  },
  '539': {
    background: 'linear-gradient(145deg,#12091a 0%,#1c1027 42%,#19111c 100%)',
    orbA: 'radial-gradient(circle,rgba(167,139,250,0.18) 0%,rgba(167,139,250,0.05) 38%,transparent 72%)',
    orbB: 'radial-gradient(circle,rgba(236,72,153,0.16) 0%,rgba(251,191,36,0.05) 44%,transparent 74%)',
    orbC: 'radial-gradient(circle,rgba(251,191,36,0.11) 0%,transparent 68%)',
    liveColor: '#fbbf24', liveGlow: 'rgba(251,191,36,0.78)',
    headline: 'linear-gradient(135deg,#fbbf24 0%,#ec4899 46%,#a78bfa 100%)',
  },
  'power': {
    background: 'linear-gradient(145deg,#120807 0%,#1f1213 45%,#211506 100%)',
    orbA: 'radial-gradient(circle,rgba(245,158,11,0.18) 0%,rgba(245,158,11,0.05) 38%,transparent 72%)',
    orbB: 'radial-gradient(circle,rgba(225,29,72,0.16) 0%,rgba(251,191,36,0.05) 44%,transparent 74%)',
    orbC: 'radial-gradient(circle,rgba(251,113,133,0.10) 0%,transparent 68%)',
    liveColor: '#f59e0b', liveGlow: 'rgba(245,158,11,0.82)',
    headline: 'linear-gradient(135deg,#fde68a 0%,#f59e0b 44%,#fb7185 100%)',
  },
}

const activeGame = computed(() => GAMES.find((g) => g.key === activeTab.value))
const activeTheme = computed(() => pageThemes[activeTab.value])

// 錨點導覽（指向當前 active game 的區塊 id，避免 v-show 隱藏副本 id 衝突）
const navItems = [
  { id: 'pick', label: '選號' },
  { id: 'ecg', label: '心電圖' },
  { id: 'method', label: '方法論' },
  { id: 'analysis', label: '號碼分析' },
  { id: 'performance', label: '成效' },
  { id: 'audit', label: '公正性' },
]

onMounted(() => { fetchData() })

const formatDate = (iso) => {
  if (!iso) return '--'
  return new Date(iso).toLocaleString('zh-TW', {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  })
}
</script>

<template>
  <div
    class="min-h-screen"
    :style="{
      background: activeTheme.background,
      fontFamily: `'Inter', 'Noto Sans TC', system-ui, sans-serif`,
      transition: 'background 260ms ease-out',
      '--accent': activeGame.accent,
      '--accent-soft': activeGame.accentSoft,
      '--accent-glow': activeGame.accentGlow,
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
      <header style="text-align:center;margin-bottom:40px;">
        <div style="display:inline-flex;align-items:center;gap:10px;margin-bottom:16px;">
          <div :style="{ width:'10px', height:'10px', borderRadius:'50%', background:activeTheme.liveColor, boxShadow:`0 0 12px ${activeTheme.liveGlow}`, animation:'pulse 2s infinite' }"></div>
          <span class="eyebrow" style="font-size:0.9rem;">Live Statistical Dashboard</span>
        </div>
        <h1 :style="{ fontSize:'clamp(2rem,5vw,3.5rem)', fontWeight:'900', background:activeTheme.headline, WebkitBackgroundClip:'text', WebkitTextFillColor:'transparent', backgroundClip:'text', margin:'0 0 12px', lineHeight:'1.1', transition:'background 260ms ease-out' }">
          小賽 AI 樂透預測
        </h1>
        <p style="color:var(--text-mute);font-size:1.05rem;max-width:600px;margin:0 auto 24px;line-height:1.6;">
          結合公正性統計檢定 × walk-forward 校正回歸的誠實樂透儀表板——號碼照出，但據實揭露：各法回測均 ≈ 隨機、不保證命中、不提高中獎機率。
        </p>

        <!-- Status badges -->
        <div style="display:flex;flex-wrap:wrap;justify-content:center;gap:10px;">
          <div class="badge">
            <span style="color:var(--text-dim);">系統狀態</span>
            <span v-if="loading" style="display:flex;align-items:center;gap:6px;color:var(--warn);">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="animation:spin 1s linear infinite;"><path d="M21 12a9 9 0 11-6.219-8.56"/></svg>
              同步中...
            </span>
            <span v-else-if="error" style="color:#f43f5e;">⚠ 連線失敗</span>
            <span v-else style="display:flex;align-items:center;gap:6px;color:#10b981;">
              <span style="width:6px;height:6px;border-radius:50%;background:#10b981;box-shadow:0 0 8px #10b981;"></span>
              在線且最新
            </span>
          </div>
          <div v-if="meta && !loading" class="badge">
            <span style="color:var(--text-dim);">最後更新</span>
            <span style="color:#cbd5e1;">{{ formatDate(meta.last_updated) }}</span>
          </div>
          <div v-if="meta && !loading" class="badge">
            <span style="color:var(--text-dim);">大樂透期數</span>
            <span style="font-weight:700;color:#2dd4bf;">{{ meta.lotto649_total }} 期</span>
          </div>
          <div v-if="meta && !loading" class="badge">
            <span style="color:var(--text-dim);">今彩539期數</span>
            <span style="font-weight:700;color:#a78bfa;">{{ meta.daily539_total }} 期</span>
          </div>
          <div v-if="meta && !loading" class="badge">
            <span style="color:var(--text-dim);">威力彩期數</span>
            <span style="font-weight:700;color:#f59e0b;">{{ meta.power_total }} 期</span>
          </div>
        </div>
      </header>

      <!-- ══ LOADING ══ -->
      <div v-if="loading" style="text-align:center;padding:80px 0;">
        <div style="display:inline-block;width:48px;height:48px;border:3px solid rgba(45,212,191,0.2);border-top-color:#2dd4bf;border-radius:50%;animation:spin 0.8s linear infinite;margin-bottom:20px;"></div>
        <p style="color:var(--text-faint);">正在載入預測數據...</p>
      </div>

      <!-- ══ ERROR ══ -->
      <div v-else-if="error" style="background:rgba(244,63,94,0.08);border:1px solid rgba(244,63,94,0.3);border-radius:16px;padding:32px;text-align:center;margin-bottom:32px;">
        <p style="color:#f43f5e;margin-bottom:16px;">無法載入資料：{{ error }}</p>
        <button @click="fetchData" style="background:rgba(244,63,94,0.15);color:#f87171;border:1px solid rgba(244,63,94,0.3);border-radius:8px;padding:8px 20px;cursor:pointer;font-size:17px;">重新嘗試</button>
      </div>

      <!-- ══ MAIN ══ -->
      <div v-else>
        <!-- Tab switcher -->
        <div style="display:flex;gap:4px;background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:4px;margin-bottom:16px;width:fit-content;">
          <button v-for="g in GAMES" :key="g.key" @click="activeTab = g.key"
            :style="{
              padding:'10px 24px', borderRadius:'10px', border:'none', cursor:'pointer',
              fontWeight:'700', fontSize:'17px', transition:'all 0.2s',
              background: activeTab === g.key ? g.accent : 'transparent',
              color: activeTab === g.key ? '#0b0f16' : 'var(--text-mute)',
              boxShadow: activeTab === g.key ? `0 2px 14px ${g.accentGlow}` : 'none',
            }">
            {{ g.tab }}
          </button>
        </div>

        <!-- 錨點導覽 -->
        <nav class="anchor-nav">
          <a v-for="n in navItems" :key="n.id" :href="`#${n.id}-${activeTab}`">{{ n.label }}</a>
        </nav>

        <!-- 單一區塊模板，依 GAMES 迭代切換，消除原本三份重複。
             注意：用「template v-for + 子層 v-if」而非「同元素 v-for + v-show」——
             後者在切換 tab 時 v-show 不會重新反應，會卡在預設彩種（大樂透）。 -->
        <template v-for="g in GAMES" :key="g.key">
        <div v-if="activeTab === g.key"
          style="display:flex;flex-direction:column;gap:48px;">

          <!-- 誠實揭露帶 -->
          <HonestyDisclosure :game-name="g.name" :prediction-data="predictions" />

          <!-- 選號 -->
          <section :id="`pick-${g.key}`">
            <SectionHeader label="Fairness & Strategy" title="公正性健診 + 選號"
              :desc="`每期公正性統計健診，並提供穩健平衡與心跳明牌兩組${g.key === 'power' ? '（含第二區）' : ''}選號參考`" :accent="g.accent" />
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:24px;" class="responsive-grid">
              <PredictionCard :game-name="g.name" :prediction-data="predictions" :history-data="history[g.name]" :accent="g.accent" />
              <StatsPanel :game-name="g.name" :history-data="history[g.name]" :max-number="g.max" :accent="g.accent" />
            </div>
          </section>

          <!-- 號碼心電圖 -->
          <section :id="`ecg-${g.key}`">
            <SectionHeader label="Number Rhythm" title="號碼心電圖"
              desc="把每個號碼的開出節奏畫成心跳波形，依 overdue 比由高到低排序（節奏觀察，不提高中獎機率）" :accent="g.accent" />
            <NumberEcgChart :game-name="g.name" :history-data="history[g.name]" :max-number="g.max" />
          </section>

          <!-- 方法論 -->
          <section :id="`method-${g.key}`">
            <SectionHeader label="Methodology" title="統計方法論與學術依據"
              desc="每個數字背後的統計方法、對應的後端實作，以及可查證的學術文獻" :accent="g.accent" />
            <MethodologyPanel />
          </section>

          <!-- 號碼分析 -->
          <section :id="`analysis-${g.key}`">
            <SectionHeader label="Number Analysis" title="號碼熱度與分佈"
              desc="從全歷史與近期視窗觀察號碼頻率、熱力分佈與奇偶大小結構" :accent="g.accent" />
            <div style="display:flex;flex-direction:column;gap:24px;">
              <HotColdChart :game-name="g.name" :history-data="history[g.name]" :max-number="g.max" :accent="g.accent" />
              <HeatmapChart :game-name="g.name" :history-data="history[g.name]" />
              <IntervalAnalysis :game-name="g.name" :history-data="history[g.name]" :max-number="g.max" :accent="g.accent" />
              <DistributionChart :game-name="g.name" :history-data="history[g.name]" />
            </div>
          </section>

          <!-- 成效／回測 -->
          <section :id="`performance-${g.key}`">
            <SectionHeader label="Performance" title="選號成效追蹤"
              desc="歷次對獎的命中率與走勢（與隨機基準對照）" :accent="g.accent" />
            <BacktestDashboard :game-name="g.name" :prediction-data="predictions"
              :performance-data="performance" :asi-learning="asiLearning" />
          </section>

          <!-- 公正性稽核 -->
          <section :id="`audit-${g.key}`">
            <SectionHeader label="Fairness Audit" title="開獎公正性稽核"
              desc="用多種統計檢定，從全歷史資料驗證開獎是否真隨機、有無人為操控指紋" :accent="g.accent" />
            <RandomnessAudit :game-name="g.name" :history-data="history[g.name]"
              :max-number="g.max" :balls-per-draw="g.balls" :has-special="g.special" :accent="g.accent" />
          </section>
        </div>
        </template>
      </div>

      <!-- Footer -->
      <footer style="text-align:center;margin-top:60px;padding-top:32px;border-top:1px solid var(--border-soft);">
        <p style="font-size:15px;color:var(--text-faint);">
          ⚠️ 本系統僅供娛樂參考，不構成任何投注建議。請理性投注，勿過度沉迷。
        </p>
        <p style="font-size:14px;color:#1e293b;margin-top:8px;">
          由 公正性統計檢定 × walk-forward 校正 × Supabase Edge Functions 全自動驅動 · 資料來源：台灣彩券官方網站
        </p>
        <p style="font-size:14px;color:var(--text-faint);margin-top:12px;line-height:2.2;">
          <a href="/guides.html" style="color:var(--text-mute);text-decoration:none;border-bottom:1px solid rgba(100,116,139,0.35);margin-right:14px;">方法與文章</a>
          <a href="/game-lotto649.html" style="color:var(--text-mute);text-decoration:none;border-bottom:1px solid rgba(100,116,139,0.35);margin-right:14px;">大樂透</a>
          <a href="/game-daily539.html" style="color:var(--text-mute);text-decoration:none;border-bottom:1px solid rgba(100,116,139,0.35);margin-right:14px;">今彩539</a>
          <a href="/game-superlotto.html" style="color:var(--text-mute);text-decoration:none;border-bottom:1px solid rgba(100,116,139,0.35);margin-right:14px;">威力彩</a>
          <a href="/faq.html" style="color:var(--text-mute);text-decoration:none;border-bottom:1px solid rgba(100,116,139,0.35);margin-right:14px;">常見問題</a>
          <a href="/about.html" style="color:var(--text-mute);text-decoration:none;border-bottom:1px solid rgba(100,116,139,0.35);margin-right:14px;">關於</a>
          <a href="/contact.html" style="color:var(--text-mute);text-decoration:none;border-bottom:1px solid rgba(100,116,139,0.35);margin-right:14px;">聯絡</a>
          <a href="/privacy" style="color:var(--text-mute);text-decoration:none;border-bottom:1px solid rgba(100,116,139,0.35);">隱私權政策</a>
        </p>
      </footer>
    </div>
  </div>
</template>

<style>
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;900&display=swap');

* { box-sizing: border-box; margin: 0; padding: 0; }
</style>
