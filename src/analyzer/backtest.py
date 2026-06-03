"""
歷史資料批次回測系統 (Backtester)
==================================
以滾動視窗 (rolling / walk-forward) 方式驗證各策略的真實命中率：
  對第 i 期，只用第 0..i-1 期的歷史計算特徵 → 產生預測 → 與第 i 期實際比對。

關鍵價值：
  1. 不依賴 LLM，可在數百期上快速跑完，得到統計上有意義的樣本量。
  2. 內建『純隨機』基準，並以二項檢定計算 p-value，判斷策略是否真的優於隨機。
  3. 各策略共用 StrategySampler，與線上預測邏輯一致，回測結果具參考性。

用法:
    python -m src.analyzer.backtest --game 649 --draws 300
"""

import math
import random
import logging
import argparse
from typing import Dict, List

from .stats_engine import StatsEngine
from .strategy_sampler import StrategySampler, StrategyProfile

logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')


def _binom_p_value(hits: int, trials: int, p: float) -> float:
    """單尾二項檢定：在命中機率為 p 的虛無假設下，觀察到 >= hits 的機率。"""
    if trials == 0:
        return 1.0
    # P(X >= hits) = 1 - P(X <= hits-1)
    cdf = 0.0
    for k in range(0, hits):
        cdf += math.comb(trials, k) * (p ** k) * ((1 - p) ** (trials - k))
    return max(0.0, 1.0 - cdf)


class Backtester:
    def __init__(self, data_file: str, max_number: int, num_picks: int, recent_periods: int):
        self.full_engine = StatsEngine(data_file, max_number)
        self.max_number = max_number
        self.num_picks = num_picks
        self.recent_periods = recent_periods
        self.df = self.full_engine.df
        # 單顆號碼隨機命中的理論機率 = num_picks / max_number
        self.baseline_p = num_picks / max_number

    def _build_profiles(self, engine: StatsEngine) -> Dict[str, StrategyProfile]:
        """以啟發式（非 LLM）產生各策略的決策方向，模擬線上策略定義。"""
        sum_stats = engine.get_sum_stats(None)
        band10 = (sum_stats["band_minus_10pct"], sum_stats["band_plus_10pct"])
        band20 = (sum_stats["band_minus_20pct"], sum_stats["band_plus_20pct"])
        oe = engine.get_odd_even_stats(None)
        target_odd = round(oe["avg_odd_per_draw"])

        missing = engine.get_missing_values()
        cold_pool = [n for n, m in sorted(missing.items(), key=lambda x: -x[1])[:8]]
        hc_trend = engine.get_hot_cold_stats(self.recent_periods)
        hot_pool = [n for n, _ in sorted(hc_trend["frequencies"].items(), key=lambda x: -x[1])[:8]]

        return {
            "激進包牌": StrategyProfile(
                name="激進包牌", bias="cold", sum_band=band20,
                prefer=cold_pool, min_from_pool=3, pool=cold_pool,
            ),
            "穩健平衡": StrategyProfile(
                name="穩健平衡", bias="balanced", sum_band=band10, target_odd=target_odd,
            ),
            "統計趨勢": StrategyProfile(
                name="統計趨勢", bias="hot", sum_band=band10,
                prefer=hot_pool, min_from_pool=3, pool=hot_pool,
            ),
            "完全隨機": StrategyProfile(name="完全隨機", bias="balanced"),
        }

    def run(self, num_draws: int, seed: int = 42) -> Dict:
        total = len(self.df)
        min_history = max(self.recent_periods, 50)
        start = max(min_history, total - num_draws)
        rng = random.Random(seed)

        agg: Dict[str, Dict[str, int]] = {}
        logging.info(f"回測範圍：第 {start} ~ {total - 1} 期，共 {total - start} 期")

        for i in range(start, total):
            engine = self.full_engine.head(i)          # 只用 0..i-1 期
            sampler = StrategySampler(engine, self.num_picks, self.recent_periods)
            profiles = self._build_profiles(engine)
            actual = set(self.df.iloc[i]["numbers"])

            for name, profile in profiles.items():
                combo = sampler.sample(profile, rng)
                hits = len(set(combo).intersection(actual))
                a = agg.setdefault(name, {"hits": 0, "trials": 0, "draws": 0})
                a["hits"] += hits
                a["trials"] += self.num_picks
                a["draws"] += 1

        results = {
            "game_max_number": self.max_number,
            "num_picks": self.num_picks,
            "baseline_single_pick_prob": round(self.baseline_p, 4),
            "draws_tested": total - start,
            "strategies": {},
        }
        for name, a in agg.items():
            hit_rate = a["hits"] / a["trials"] if a["trials"] else 0
            p_value = _binom_p_value(a["hits"], a["trials"], self.baseline_p)
            results["strategies"][name] = {
                "total_hits": a["hits"],
                "total_trials": a["trials"],
                "hit_rate": round(hit_rate, 4),
                "lift_vs_random": round(hit_rate - self.baseline_p, 4),
                "p_value_vs_random": round(p_value, 4),
                "beats_random_significantly": p_value < 0.05 and hit_rate > self.baseline_p,
            }
        return results


def _print_report(name: str, res: Dict):
    print(f"\n===== {name} 回測結果 =====")
    print(f"回測期數: {res['draws_tested']}  | 隨機單顆命中基準: {res['baseline_single_pick_prob']:.2%}")
    print(f"{'策略':<10}{'命中率':>10}{'相對隨機':>12}{'p-value':>10}{'顯著勝出':>10}")
    for sname, s in sorted(res["strategies"].items(), key=lambda x: -x[1]["hit_rate"]):
        flag = "✅" if s["beats_random_significantly"] else "—"
        print(f"{sname:<10}{s['hit_rate']:>9.2%}{s['lift_vs_random']:>+12.2%}"
              f"{s['p_value_vs_random']:>10.4f}{flag:>10}")


if __name__ == "__main__":
    import sys
    sys.stdout.reconfigure(encoding='utf-8')
    parser = argparse.ArgumentParser(description="樂透策略歷史回測")
    parser.add_argument("--game", choices=["649", "539"], required=True)
    parser.add_argument("--draws", type=int, default=300, help="回測最近 N 期")
    args = parser.parse_args()

    if args.game == "649":
        bt = Backtester("data/lotto649.json", 49, 6, recent_periods=100)
        name = "大樂透"
    else:
        bt = Backtester("data/daily539.json", 39, 5, recent_periods=300)
        name = "今彩539"

    res = bt.run(args.draws)
    _print_report(name, res)
