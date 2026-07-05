<script setup>
import { ref } from 'vue'

// 折疊式學術方法論卡片。每個方法對應後端真實實作，並附可查證的文獻。
const open = ref(false)

const methods = [
  {
    icon: '📐',
    title: '卡方均勻性檢定（Chi-square goodness-of-fit）',
    impl: '對應後端 fairnessDiagnostic：統計每個號碼的出現次數，與理論期望值 T·k/N 比較，計算 χ² 與 p 值。',
    body: '若開獎為公正隨機，各號碼長期出現頻率應趨於一致。卡方檢定量化「觀測頻率」與「均勻期望」的偏離；p ≥ 0.05 表示偏離量在隨機波動範圍內、與真隨機無法區分。這正是各國彩券公信力稽核採用的標準方法。',
  },
  {
    icon: '🔗',
    title: '前後期獨立性檢定（Serial independence, z-test）',
    impl: '對應後端 fairnessDiagnostic：計算相鄰兩期的重號數，與理論期望 k²/N 做 z 檢定。',
    body: '公正抽獎是「無記憶」過程——上一期開什麼，不影響這一期。獨立性檢定驗證前後期之間沒有可利用的關聯；p ≥ 0.05 表示找不到序列相依，符合真隨機。',
  },
  {
    icon: '🧪',
    title: 'Walk-forward 無洩漏回測（校正回歸）',
    impl: '對應後端 heartbeatCalibration：只用「當期之前」的資料產生排名，再用當期實際開獎驗證，逐期滾動累積命中率，對隨機基準 k/N 做顯著性檢定。',
    body: '這是時間序列預測的黃金標準——嚴禁用未來資料回頭調參（look-ahead bias）。心跳明牌以此方式逐期自我驗證，實測命中率長期 ≈ 隨機基準，誠實揭露「贏不過隨機」。',
  },
  {
    icon: '🚫',
    title: '為什麼「預測號碼」在數學上不可行',
    impl: '這是本站的核心立場：號碼照出、但誠實揭露不提高中獎機率。',
    body: 'LSTM / 機器學習實驗一致顯示：在真隨機序列上，模型只會過擬合、對新資料無泛化，AI 選號與隨機選號頻率無顯著差異。跨 17 彩種、20,031 期的統計審計亦未發現持續性偏差。歷史上唯一被數學證明能長期獲利的案例（麻州 Cash WinFall），靠的是「遊戲滾存下放的正期望值結構」，而非預測號碼。',
  },
]

const refs = [
  { label: 'Finding good bets in the lottery, and why you shouldn\'t take them (arXiv 2507.01993)', url: 'https://arxiv.org/pdf/2507.01993' },
  { label: 'Does it Pay to Buy the Pot in the Canadian 6/49 Lotto? (arXiv 1801.02959)', url: 'https://arxiv.org/pdf/1801.02959' },
  { label: 'Patterns in manually selected numbers in the Israeli lottery (SJDM)', url: 'https://dlab.sauder.ubc.ca/sjdm/journal/21/210322/jdm210322.pdf' },
  { label: '2026 Statistical Audit of U.S. & World Lotteries (20,031 draws)', url: 'https://luckypicks.io/research/statistical-fairness/' },
  { label: 'How MIT Students Won $8M in the Massachusetts Lottery (Cash WinFall)', url: 'https://newsfeed.time.com/2012/08/07/how-mit-students-scammed-the-massachusetts-lottery-for-8-million/' },
]
</script>

<template>
  <div class="card">
    <button class="disclosure-toggle" @click="open = !open" :aria-expanded="open">
      <span style="display:flex;align-items:center;gap:8px;">
        🎓 統計方法論與學術依據
        <span style="font-size:0.82rem;font-weight:400;color:var(--text-faint);">為什麼這些數字可信、以及為什麼預測不可能</span>
      </span>
      <span :style="{ transition:'transform 0.2s', transform: open ? 'rotate(180deg)' : 'none', color:'var(--text-mute)' }">▾</span>
    </button>

    <div v-show="open" style="margin-top:18px;display:flex;flex-direction:column;gap:14px;">
      <div v-for="m in methods" :key="m.title"
        style="background:var(--surface-2);border:1px solid var(--border-soft);border-radius:var(--radius);padding:16px;">
        <h4 style="font-size:1rem;font-weight:700;color:var(--text);display:flex;align-items:center;gap:8px;margin-bottom:8px;">
          <span>{{ m.icon }}</span> {{ m.title }}
        </h4>
        <p style="font-size:0.92rem;color:var(--text-dim);line-height:1.7;margin-bottom:8px;">{{ m.body }}</p>
        <p style="font-size:0.82rem;color:var(--text-mute);line-height:1.6;border-left:2px solid var(--accent);padding-left:10px;">
          <strong style="color:var(--text-dim);">實作對應：</strong>{{ m.impl }}
        </p>
      </div>

      <!-- 文獻引用 -->
      <div style="background:var(--surface-2);border:1px solid var(--border-soft);border-radius:var(--radius);padding:16px;">
        <p class="eyebrow" style="margin-bottom:12px;">References</p>
        <ul style="list-style:none;display:flex;flex-direction:column;gap:9px;">
          <li v-for="r in refs" :key="r.url" style="font-size:0.85rem;line-height:1.5;">
            <a :href="r.url" target="_blank" rel="noopener noreferrer"
              style="color:var(--info);text-decoration:none;border-bottom:1px solid rgba(96,165,250,0.3);">
              {{ r.label }} ↗
            </a>
          </li>
        </ul>
      </div>
    </div>
  </div>
</template>
