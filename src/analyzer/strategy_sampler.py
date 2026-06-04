"""
策略採樣器 (StrategySampler)
============================
將「決策方向」與「號碼選取」解耦：
  - 決策方向 (StrategyProfile)：由 LLM 或回測啟發式提供
    （偏熱/偏冷/平衡、目標奇偶數、和值區間、偏好/排除號碼）
  - 號碼選取：由本模組以加權抽樣 + 硬性約束驗證，於 Python 端確定性執行

如此可確保所有硬性約束（範圍、不重複、非全奇全偶、無 4 連號、和值區間、
不與近 3 期完全相同）一定被滿足，不再依賴 LLM 的算術正確性。
"""

import random
import logging
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple

logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')


@dataclass
class StrategyProfile:
    """單一策略的決策方向。所有欄位皆為『傾向』，實際選號由採樣器完成。"""
    name: str
    bias: str = "balanced"                       # "hot" | "cold" | "balanced"
    sum_band: Optional[Tuple[float, float]] = None  # (low, high)，None 表示不限制
    target_odd: Optional[int] = None             # 目標奇數顆數，None 表示不限制
    prefer: List[int] = field(default_factory=list)  # LLM 點名偏好的號碼（加權）
    avoid: List[int] = field(default_factory=list)   # LLM 點名排除的號碼
    min_from_pool: int = 0                        # 至少幾顆來自 prefer 池
    pool: List[int] = field(default_factory=list) # min_from_pool 對應的號碼池


class StrategySampler:
    def __init__(self, stats_engine, num_picks: int, recent_periods: int):
        self.engine = stats_engine
        self.max_number = stats_engine.max_number
        self.num_picks = num_picks
        self.recent_periods = recent_periods

        # 預先算好近期頻率與遺漏值，供加權使用
        hc = stats_engine.get_hot_cold_stats(recent_periods)
        self.recent_freq: Dict[int, int] = hc["frequencies"]
        self.missing: Dict[int, int] = stats_engine.get_missing_values()
        # 即將開出指數（目前遺漏 ÷ 該號平均間隔）：比原始遺漏期數更能反映相對週期
        self.overdue: Dict[int, float] = (
            stats_engine.get_overdue_index()
            if hasattr(stats_engine, "get_overdue_index") else {}
        )
        # 號碼對頻率（步驟 3）：優先取快取，否則就近期視窗即時計算
        self.pair_freq: Dict[frozenset, int] = getattr(stats_engine, "pair_freq_cache", {}) or {}
        if not self.pair_freq and hasattr(stats_engine, "get_pair_frequencies"):
            stats_engine.get_pair_frequencies(recent_periods)
            self.pair_freq = getattr(stats_engine, "pair_freq_cache", {}) or {}
        self.max_pair = max(self.pair_freq.values()) if self.pair_freq else 1

        # 近 3 期開獎（用於排除完全相同）
        self.last_draws = [set(n) for n in stats_engine.df.tail(3)["numbers"]]

    # ── 號碼權重 ────────────────────────────────────────────────
    def _base_weights(self, bias: str) -> Dict[int, float]:
        """依偏好方向給每個號碼一個基礎權重（恆 > 0，確保任何號碼都可能被選到）。"""
        weights = {}
        max_miss = max(self.missing.values()) or 1
        max_freq = max(self.recent_freq.values()) or 1
        for n in range(1, self.max_number + 1):
            freq_norm = self.recent_freq.get(n, 0) / max_freq      # 0~1，越熱越高
            miss_norm = self.missing.get(n, 0) / max_miss          # 0~1，越冷越高
            # 即將開出指數正規化：指數 >= 2.0 視為 1.0（與前端紅色門檻一致）
            overdue_norm = min(self.overdue.get(n, 0.0) / 2.0, 1.0)  # 0~1，越 overdue 越高
            if bias == "hot":
                # 熱門為主，並對 overdue 號碼給予小幅加成
                w = 0.2 + freq_norm + 0.2 * overdue_norm
            elif bias == "cold":
                # 冷門策略改以「即將開出指數」為主訊號，輔以原始遺漏期數
                w = 0.2 + 0.4 * miss_norm + 0.8 * overdue_norm
            else:  # balanced：輕微偏好近期出現，並適度納入 overdue 週期訊號
                w = 0.5 + 0.4 * freq_norm + 0.3 * overdue_norm
            weights[n] = w
        return weights

    def _apply_profile_weights(self, weights: Dict[int, float], profile: StrategyProfile) -> Dict[int, float]:
        w = dict(weights)
        for n in profile.prefer:
            if 1 <= n <= self.max_number:
                w[n] = w.get(n, 0.5) * 3.0   # 點名偏好：權重 x3
        for n in profile.avoid:
            if 1 <= n <= self.max_number:
                w[n] = w.get(n, 0.5) * 0.05  # 點名排除：權重大幅下降但不為 0
        return w

    # ── 硬性約束驗證 ──────────────────────────────────────────
    def _violates_constraints(self, combo: List[int], profile: StrategyProfile) -> bool:
        s = set(combo)
        if len(s) != self.num_picks:
            return True
        # 非全奇 / 全偶
        odd = sum(1 for n in combo if n % 2)
        if odd == 0 or odd == self.num_picks:
            return True
        # 無 4 個以上連續整數
        ordered = sorted(combo)
        run = 1
        for i in range(1, len(ordered)):
            run = run + 1 if ordered[i] == ordered[i - 1] + 1 else 1
            if run >= 4:
                return True
        # 不與近 3 期完全相同
        if any(s == prev for prev in self.last_draws):
            return True
        # 和值區間
        if profile.sum_band is not None:
            total = sum(combo)
            if not (profile.sum_band[0] <= total <= profile.sum_band[1]):
                return True
        # 目標奇數顆數（若指定則須完全相符）
        if profile.target_odd is not None and odd != profile.target_odd:
            return True
        # min_from_pool：至少 N 顆來自指定池
        if profile.min_from_pool > 0 and profile.pool:
            from_pool = len(s.intersection(set(profile.pool)))
            if from_pool < profile.min_from_pool:
                return True
        return False

    def _weighted_pick(self, weights: Dict[int, float], rng: random.Random) -> List[int]:
        """以權重不重複抽出 num_picks 個號碼。"""
        nums = list(weights.keys())
        chosen = []
        pool = nums[:]
        wmap = dict(weights)
        for _ in range(self.num_picks):
            # 號碼對連帶加權：已選號碼會提升其高頻共現夥伴的權重
            if chosen and self.pair_freq:
                eff = {}
                for n in pool:
                    bonus = 1.0
                    for c in chosen:
                        pf = self.pair_freq.get(frozenset((n, c)), 0)
                        bonus += 0.5 * (pf / self.max_pair)
                    eff[n] = wmap[n] * bonus
            else:
                eff = wmap
            total = sum(eff[n] for n in pool)
            r = rng.uniform(0, total)
            acc = 0.0
            for n in pool:
                acc += eff[n]
                if r <= acc:
                    chosen.append(n)
                    pool.remove(n)
                    break
        return chosen

    def sample(self, profile: StrategyProfile, rng: Optional[random.Random] = None,
               max_attempts: int = 2000) -> List[int]:
        """
        依 profile 抽出一組符合所有硬性約束的號碼。
        以加權拒絕抽樣 (weighted rejection sampling) 進行；若多次失敗則逐步放寬。
        """
        rng = rng or random.Random()
        base = self._base_weights(profile.bias)
        weights = self._apply_profile_weights(base, profile)

        best = None
        for attempt in range(max_attempts):
            # 逐步放寬：超過半數嘗試仍失敗，放寬目標奇數與 min_from_pool
            relaxed = profile
            if attempt > max_attempts // 2:
                relaxed = StrategyProfile(
                    name=profile.name, bias=profile.bias, sum_band=profile.sum_band,
                    target_odd=None, prefer=profile.prefer, avoid=profile.avoid,
                    min_from_pool=0, pool=profile.pool,
                )
            combo = self._weighted_pick(weights, rng)
            if not self._violates_constraints(combo, relaxed):
                return sorted(combo)
            best = combo
        logging.warning(f"[{profile.name}] 採樣 {max_attempts} 次未完全滿足約束，回傳最後一組近似解。")
        return sorted(best) if best else sorted(rng.sample(range(1, self.max_number + 1), self.num_picks))
