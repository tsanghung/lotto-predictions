"""
號碼心跳 / 節奏推算 (Heartbeat Predictor)
==========================================
依使用者構想：從歷史開獎找出每個號碼的「脈動」——以**天數**計的平均間隔
(average inter-arrival in days)，再用「目前已隔幾天 / 自身平均週期」這個
overdue 比值當作節奏訊號，推算當期最可能開出的號碼。

本程式做兩件事：
  ① 推算：用全歷史替每個號碼算出心跳(平均間隔天數)，輸出當期 overdue 比值
     最高(最「該開」)的前 k 個號碼 —— 這就是使用者要的「心跳明牌」。
  ② 檢定：把同一套排名做 walk-forward 回測(只用過去資料預測下一期)，比對
     隨機基準 k/N，並列出「overdue 比值 vs 實際開出率」校準表，直接檢驗
     『越久沒開越容易開』這個假設在資料上到底成不成立。

⚠ 機率前提：公正抽獎中，號碼出現是「無記憶」過程——等越久並不會讓它更可能開
   (P(下一期出現 | 已等 N 天) = P(下一期出現))。本程式不假裝預測，只把使用者的
   假設攤在資料上量化檢驗。回測結論以實測數字為準。

用法:
    python scripts/heartbeat_predict.py                # 三個遊戲都跑
    python scripts/heartbeat_predict.py --game power   # 只跑威力彩
    python scripts/heartbeat_predict.py --backtest 1500
"""
import argparse
import json
import math
import sys
from datetime import date

sys.stdout.reconfigure(encoding="utf-8")

GAMES = {
    "539":   {"file": "data/daily539.json", "name": "今彩539", "N": 39, "k": 5, "second": None},
    "649":   {"file": "data/lotto649.json", "name": "大樂透", "N": 49, "k": 6, "second": None},
    "power": {"file": "data/power.json",    "name": "威力彩", "N": 38, "k": 6, "second": 8},
}


def load_draws(path):
    rows = json.load(open(path, encoding="utf-8"))
    out = []
    for r in rows:
        try:
            y, m, d = (int(x) for x in r["date"].split("-"))
            out.append({"date": date(y, m, d), "numbers": [int(n) for n in r["numbers"]],
                        "special": r.get("special_number")})
        except Exception:
            continue
    out.sort(key=lambda x: x["date"])
    return out


class Heartbeat:
    """逐期增量維護每個號碼的心跳：last_date、間隔天數的累計與計次。"""

    def __init__(self, N):
        self.N = N
        self.last = {n: None for n in range(1, N + 1)}
        self.sum_gap = {n: 0 for n in range(1, N + 1)}
        self.n_gap = {n: 0 for n in range(1, N + 1)}

    def mean_days(self, n):
        return self.sum_gap[n] / self.n_gap[n] if self.n_gap[n] > 0 else None

    def ratio(self, n, today):
        """overdue 比值 = 目前已隔天數 / 自身平均間隔天數。"""
        last = self.last[n]
        mean = self.mean_days(n)
        if last is None or mean is None or mean <= 0:
            return None, None
        gap = (today - last).days
        return gap / mean, gap

    def rank(self, today, k):
        """回傳 overdue 比值最高的前 k 個號碼（無心跳者用目前 gap 補位）。"""
        scored, fallback = [], []
        for n in range(1, self.N + 1):
            r, gap = self.ratio(n, today)
            if r is not None:
                scored.append((r, gap, n))
            else:
                last = self.last[n]
                g = (today - last).days if last else 10 ** 6
                fallback.append((g, n))
        scored.sort(key=lambda x: (-x[0], -x[1], x[2]))
        picks = [n for _, _, n in scored[:k]]
        if len(picks) < k:
            fallback.sort(key=lambda x: (-x[0], x[1]))
            picks += [n for _, n in fallback if n not in picks][: k - len(picks)]
        return picks, {n: (r, g) for r, g, n in scored}

    def update(self, today, numbers):
        for n in numbers:
            if 1 <= n <= self.N:
                if self.last[n] is not None:
                    self.sum_gap[n] += (today - self.last[n]).days
                    self.n_gap[n] += 1
                self.last[n] = today


def wilson_ci(hits, trials, z=1.96):
    if trials == 0:
        return (0.0, 0.0)
    p = hits / trials
    denom = 1 + z * z / trials
    center = (p + z * z / (2 * trials)) / denom
    half = z * math.sqrt(p * (1 - p) / trials + z * z / (4 * trials * trials)) / denom
    return (center - half, center + half)


def one_sided_p_beats(hits, trials, base):
    if trials == 0:
        return 1.0
    se = math.sqrt(base * (1 - base) / trials)
    z = (hits / trials - base) / se
    return 0.5 * math.erfc(z / math.sqrt(2))


def run_game(key, backtest_window):
    cfg = GAMES[key]
    draws = load_draws(cfg["file"])
    N, k = cfg["N"], cfg["k"]
    base = k / N
    T = len(draws)
    warmup = min(300, T // 3)

    # ── walk-forward 回測 + overdue 校準桶 ───────────────────────────────
    hb = Heartbeat(N)
    for i in range(warmup):
        hb.update(draws[i]["date"], draws[i]["numbers"])

    start = max(warmup, T - backtest_window) if backtest_window else warmup
    # 把前面跳過的期數先吃進心跳狀態
    for i in range(warmup, start):
        hb.update(draws[i]["date"], draws[i]["numbers"])

    hits = trials = 0
    rand_hits = 0  # 對照：固定選 1..k 之外的隨機？改用理論 base，下方直接比
    bins = [(0, 0.5), (0.5, 1.0), (1.0, 1.5), (1.5, 2.0), (2.0, 3.0), (3.0, 1e9)]
    bucket = {b: [0, 0] for b in bins}  # ratio 區間 -> [出現次數, 機會次數]

    for i in range(start, T):
        today = draws[i]["date"]
        actual = set(draws[i]["numbers"])
        picks, scores = hb.rank(today, k)
        hits += len(set(picks) & actual)
        trials += k
        # 校準桶：每個有心跳的號碼，記錄它的 overdue 比值與是否真的開出
        for n, (r, _g) in scores.items():
            for b in bins:
                if b[0] <= r < b[1]:
                    bucket[b][1] += 1
                    if n in actual:
                        bucket[b][0] += 1
                    break
        hb.update(today, actual)

    rate = hits / trials if trials else 0
    lo, hi = wilson_ci(hits, trials)
    p = one_sided_p_beats(hits, trials, base)
    verdict = "顯著勝過隨機 ⚠" if (p < 0.05 and rate > base) else "與隨機無異 ✓"

    # ── 當期推算（用全歷史）────────────────────────────────────────────
    hb_full = Heartbeat(N)
    for d in draws:
        hb_full.update(d["date"], d["numbers"])
    last_date = draws[-1]["date"]
    picks, scores = hb_full.rank(last_date, k)
    detail = sorted(((scores[n][0], scores[n][1], hb_full.mean_days(n), n) for n in picks),
                    key=lambda x: -x[0])

    print(f"\n{'='*72}")
    print(f"  {cfg['name']}　號碼心跳推算（{cfg['N']} 選 {cfg['k']}）　歷史 {T} 期")
    print(f"{'='*72}")
    print(f"  ① 當期心跳明牌（overdue 比值最高 = 最「該開」的 {k} 號）：")
    print(f"     {sorted(picks)}")
    print(f"     {'號碼':>4}{'平均間隔(天)':>12}{'已隔(天)':>10}{'overdue比值':>12}")
    for r, g, mean, n in detail:
        print(f"     {n:>4}{mean:>12.1f}{g:>10}{r:>12.2f}")

    print(f"\n  ② walk-forward 回測（最近 {T - start} 期，只用過去預測下一期）")
    print(f"     隨機單顆基準 base = k/N = {k}/{N} = {base*100:.2f}%")
    print(f"     心跳排名命中率 = {rate*100:.2f}%  (相對隨機 {(rate-base)*100:+.2f}%)")
    print(f"     95% CI = [{lo*100:.2f}%, {hi*100:.2f}%]   p(勝隨機) = {p:.3f}")
    print(f"     判定：{verdict}")

    print(f"\n  ③ 「越久沒開越容易開？」校準表（直接檢驗心跳假設）")
    print(f"     {'overdue比值':>12}{'實際開出率':>12}{'相對隨機':>10}{'樣本數':>10}")
    for b in bins:
        appear, chance = bucket[b]
        if chance == 0:
            continue
        prate = appear / chance
        tag = f"[{b[0]:.1f}, {b[1]:.0f})" if b[1] < 1e8 else f"[{b[0]:.1f}+    )"
        print(f"     {tag:>12}{prate*100:>11.2f}%{(prate-base)*100:>+9.2f}%{chance:>10}")
    print(f"     (若假設成立，開出率應隨 overdue 比值上升；若各列都黏在 {base*100:.2f}% 附近，"
          f"代表『無記憶』——等再久也不會更可能開。)")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--game", choices=list(GAMES) + ["all"], default="all")
    ap.add_argument("--backtest", type=int, default=1500, help="回測期數(0=全歷史)")
    args = ap.parse_args()
    keys = list(GAMES) if args.game == "all" else [args.game]
    for key in keys:
        run_game(key, args.backtest)


if __name__ == "__main__":
    main()
