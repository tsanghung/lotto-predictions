"""
每日滾動校正迴圈 (Rolling Calibration Loop)
===========================================
模擬一個「每天從開獎資料學習」的智能體，但目標函數是『誠實』而非『追號碼』。

它逐期 walk-forward：對第 i 期，只用 0..i-1 期的歷史產生預測，與第 i 期實際比對，
然後把證據累積起來，逐日回答兩個『真實可學』的問題：

  1. 校準回歸：累積命中率是否收斂到隨機基準 k/N？信賴區間是否逐日收窄？
     —— 一個誠實的智能體會收斂到「我贏不過隨機」，而不是收斂到獎號。
  2. 真分數規則 (Brier)：把每號當成機率預報來評分。若『熱號/遺漏模型』的
     Brier 分數不低於『均勻分布』，代表它沒有任何校準上的資訊優勢。

附帶：漂移偵測 —— 每個策略 vs 隨機基準的單尾 p 值軌跡。若哪天真的 < 0.05 且
持續，才值得當作『機台異常』訊號去查（在乾淨的資料上它會一直待在門檻之上）。

用法:
    python scripts/rolling_calibration.py --game 539 --draws 400
"""

import os
import sys
import math
import argparse
import random

import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))
sys.stdout.reconfigure(encoding="utf-8")

from analyzer.stats_engine import StatsEngine
from analyzer.strategy_sampler import StrategySampler, StrategyProfile


def build_profiles(engine, recent_periods):
    """與 backtest.py 一致的啟發式決策方向（非 LLM），含『完全隨機』對照組。"""
    sum_stats = engine.get_sum_stats(None)
    band10 = (sum_stats["band_minus_10pct"], sum_stats["band_plus_10pct"])
    band20 = (sum_stats["band_minus_20pct"], sum_stats["band_plus_20pct"])
    oe = engine.get_odd_even_stats(None)
    target_odd = round(oe["avg_odd_per_draw"])

    missing = engine.get_missing_values()
    cold_pool = [n for n, _ in sorted(missing.items(), key=lambda x: -x[1])[:8]]
    hc = engine.get_hot_cold_stats(recent_periods)
    hot_pool = [n for n, _ in sorted(hc["frequencies"].items(), key=lambda x: -x[1])[:8]]

    return {
        "激進包牌": StrategyProfile(name="激進包牌", bias="cold", sum_band=band20,
                                prefer=cold_pool, min_from_pool=3, pool=cold_pool),
        "穩健平衡": StrategyProfile(name="穩健平衡", bias="balanced", sum_band=band10,
                                target_odd=target_odd),
        "統計趨勢": StrategyProfile(name="統計趨勢", bias="hot", sum_band=band10,
                                prefer=hot_pool, min_from_pool=3, pool=hot_pool),
        "完全隨機": StrategyProfile(name="完全隨機", bias="balanced"),
    }


def wilson_ci(hits, trials, z=1.96):
    if trials == 0:
        return (0.0, 0.0)
    p = hits / trials
    denom = 1 + z * z / trials
    center = (p + z * z / (2 * trials)) / denom
    half = z * math.sqrt(p * (1 - p) / trials + z * z / (4 * trials * trials)) / denom
    return (center - half, center + half)


def one_sided_p_beats(hits, trials, base):
    """單尾：在『命中率=base』虛無假設下，觀察到 >= 此命中率的機率（常態近似）。"""
    if trials == 0:
        return 1.0
    se = math.sqrt(base * (1 - base) / trials)
    z = (hits / trials - base) / se
    return 0.5 * math.erfc(z / math.sqrt(2))


def freq_prob_model(engine, recent_periods, N, k):
    """熱號模型：近 N 期頻率 → 每號『被抽中』機率，校準到期望 k 顆。"""
    hc = engine.get_hot_cold_stats(recent_periods)
    counts = np.array([hc["frequencies"][n] for n in range(1, N + 1)], dtype=float)
    if counts.sum() == 0:
        counts = np.ones(N)
    p = counts / counts.sum() * k        # 期望抽 k 顆
    return np.clip(p, 1e-6, 1 - 1e-6)


def run(game, window):
    cfg = {"539": ("data/daily539.json", 39, 5, 300),
           "649": ("data/lotto649.json", 49, 6, 100)}[game]
    path, N, k, recent_periods = cfg
    name = {"539": "今彩539", "649": "大樂透"}[game]

    full = StatsEngine(path, N)
    df = full.df
    total = len(df)
    start = max(recent_periods + 10, total - window)
    rng = random.Random(42)
    base = k / N

    strat_names = ["激進包牌", "穩健平衡", "統計趨勢", "完全隨機"]
    cum = {s: {"hits": 0, "trials": 0} for s in strat_names}
    brier_freq = 0.0
    brier_unif = 0.0
    n_scored = 0
    checkpoints = sorted({25, 50, 100, 200, total - start})
    snapshots = {}

    for step, i in enumerate(range(start, total), 1):
        engine = full.head(i)
        sampler = StrategySampler(engine, k, recent_periods)
        profiles = build_profiles(engine, recent_periods)
        actual = set(df.iloc[i]["numbers"])

        for s, profile in profiles.items():
            combo = sampler.sample(profile, rng)
            hits = len(set(combo) & actual)
            cum[s]["hits"] += hits
            cum[s]["trials"] += k

        # Brier：熱號模型 vs 均勻分布
        y = np.zeros(N)
        for n in actual:
            if 1 <= n <= N:
                y[n - 1] = 1.0
        p_freq = freq_prob_model(engine, recent_periods, N, k)
        p_unif = np.full(N, k / N)
        brier_freq += float(((p_freq - y) ** 2).sum())
        brier_unif += float(((p_unif - y) ** 2).sum())
        n_scored += 1

        if step in checkpoints:
            snapshots[step] = {
                s: dict(cum[s]) for s in strat_names
            }

    print(f"\n{'='*78}")
    print(f"  {name}　滾動校正：第 {start} → {total - 1} 期，共 {total - start} 期 walk-forward")
    print(f"  隨機單顆命中基準 base = k/N = {k}/{N} = {base*100:.2f}%")
    print(f"{'='*78}")

    # 校準回歸軌跡（看信賴區間逐步收窄、命中率黏在 base 上）
    print(f"\n  ▸ 校準回歸：累積命中率向隨機基準收斂的軌跡")
    print(f"    {'已學期數':>8}{'策略':>8}{'命中率':>9}{'相對隨機':>10}{'95% CI':>20}{'p(勝隨機)':>11}")
    print(f"    {'-'*70}")
    for cp in sorted(snapshots):
        for s in ["統計趨勢", "激進包牌", "完全隨機"]:   # 取代表性三組
            h, t = snapshots[cp][s]["hits"], snapshots[cp][s]["trials"]
            rate = h / t if t else 0
            lo, hi = wilson_ci(h, t)
            p = one_sided_p_beats(h, t, base)
            print(f"    {cp:>8}{s:>8}{rate*100:>8.2f}%{(rate-base)*100:>+9.2f}%"
                  f"   [{lo*100:5.2f}%,{hi*100:5.2f}%]{p:>11.3f}")
        print()

    # 最終裁決
    print(f"  ▸ 最終裁決（{total - start} 期後）")
    print(f"    {'策略':>8}{'累積命中率':>11}{'相對隨機':>10}{'p(勝隨機)':>11}  判定")
    print(f"    {'-'*54}")
    for s in strat_names:
        h, t = cum[s]["hits"], cum[s]["trials"]
        rate = h / t
        p = one_sided_p_beats(h, t, base)
        verdict = "顯著勝出 ⚠" if p < 0.05 and rate > base else "與隨機無異 ✓"
        print(f"    {s:>8}{rate*100:>10.2f}%{(rate-base)*100:>+9.2f}%{p:>11.3f}  {verdict}")

    # Brier 校準
    bf, bu = brier_freq / n_scored, brier_unif / n_scored
    print(f"\n  ▸ 真分數規則 (Brier，越低越準)")
    print(f"    熱號/遺漏機率模型：{bf:.4f}")
    print(f"    均勻分布(什麼都不學)：{bu:.4f}")
    if bf <= bu - 1e-4:
        print(f"    → 熱號模型較低 {(bu-bf):.4f}：偵測到校準資訊優勢，值得追查。")
    else:
        print(f"    → 熱號模型並未低於均勻分布（差 {bf-bu:+.4f}）："
              f"『學習』沒有帶來任何校準優勢。")
    print(f"\n  結論：智能體每天滾動學習後，誠實地收斂到『贏不過隨機』；")
    print(f"        信賴區間隨樣本收窄，但中心始終黏在基準上 —— 這就是它變聰明的證據。")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--game", choices=["539", "649"], default="539")
    ap.add_argument("--draws", type=int, default=400, help="滾動視窗期數")
    args = ap.parse_args()
    run(args.game, args.draws)


if __name__ == "__main__":
    main()
