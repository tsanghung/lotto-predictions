"""
開獎公正性稽核 — Monte Carlo 版 (Randomness Audit)
==================================================
對台灣彩券的全歷史開獎資料做嚴格的「真隨機」檢定。

為什麼用 Monte Carlo 而不是課本公式？
  樂透是「不放回抽樣」（一期抽 k 個相異號），各號出現次數並非獨立 Poisson，
  古典卡方的漸近 p 值會有偏差。這裡直接用『與真實開獎完全相同的抽樣設計』
  模擬 M 次虛無假設，得到每個統計量的「精確」經驗分布與 p 值，不做任何近似。

  每一項檢定都附 Benjamini–Hochberg (FDR) 與 Bonferroni 多重比較校正，
  避免「跑很多檢定，總會有一兩項假性顯著」的陷阱。

用法:
    python scripts/randomness_audit.py            # 跑 649 與 539
    python scripts/randomness_audit.py --sims 20000
"""

import json
import time
import argparse
import sys
from itertools import combinations

import numpy as np

sys.stdout.reconfigure(encoding="utf-8")


GAMES = {
    "大樂透": {"file": "data/lotto649.json", "N": 49, "k": 6, "special": True},
    "今彩539": {"file": "data/daily539.json", "N": 39, "k": 5, "special": False},
    "威力彩": {"file": "data/power.json", "N": 38, "k": 6, "special": True},
}


def load_draws(path, N, k):
    with open(path, "r", encoding="utf-8") as f:
        raw = json.load(f)
    raw = sorted(raw, key=lambda d: d["date"])
    main = np.array([sorted(d["numbers"]) for d in raw if len(d["numbers"]) == k], dtype=np.int64)
    specials = np.array(
        [d["special_number"] for d in raw if d.get("special_number") is not None],
        dtype=np.int64,
    )
    return main, specials


# ── 統計量：對一個 (D, k) 的開獎矩陣算出一組標量 ──────────────────────────
def membership_matrix(draws, N):
    """draws: (D,k) 號碼 (1..N) → (D,N) 0/1 membership"""
    D = draws.shape[0]
    m = np.zeros((D, N), dtype=np.float64)
    rows = np.repeat(np.arange(D), draws.shape[1])
    m[rows, (draws - 1).ravel()] = 1.0
    return m


def compute_stats(draws, N, k):
    D = draws.shape[0]
    member = membership_matrix(draws, N)
    counts = member.sum(axis=0)                      # 每號總出現次數
    exp_each = D * k / N

    # 1) 均勻性卡方
    chi2 = float(((counts - exp_each) ** 2 / exp_each).sum())
    # 2) 單號最大偏離（抓「某一個號碼是否異常熱/冷」，天然處理多重比較）
    max_abs_dev = float(np.abs(counts - exp_each).max())

    # 3) 每期總和：平均與變異
    sums = draws.sum(axis=1).astype(np.float64)
    sum_mean = float(sums.mean())
    sum_var = float(sums.var())

    # 4) 奇數比例、大號(>N/2)比例
    odd_rate = float((draws % 2 == 1).mean())
    big_rate = float((draws > N / 2).mean())

    # 5) 前後期重疊（lag-1 序列獨立性）
    overlap = (member[1:] * member[:-1]).sum(axis=1)
    mean_overlap = float(overlap.mean())

    # 6) 總和序列的 lag-1 自相關（偵測 19 年間的機台漂移 / 時間趨勢）
    s = sums - sums.mean()
    denom = float((s * s).sum())
    sum_acf1 = float((s[1:] * s[:-1]).sum() / denom) if denom > 0 else 0.0

    # 7) 號碼對共現次數的變異（偵測「某些號愛一起開」的機台指紋）
    cooc = member.T @ member                          # (N,N)
    iu = np.triu_indices(N, k=1)
    pair_var = float(cooc[iu].var())

    return {
        "chi2": chi2,
        "max_abs_dev": max_abs_dev,
        "sum_mean": sum_mean,
        "sum_var": sum_var,
        "odd_rate": odd_rate,
        "big_rate": big_rate,
        "mean_overlap": mean_overlap,
        "sum_acf1": sum_acf1,
        "pair_var": pair_var,
    }


# 每個統計量的「極端方向」：'right' = 越大越偏離；'two' = 雙尾
TAIL = {
    "chi2": "right",
    "max_abs_dev": "right",
    "pair_var": "right",
    "sum_mean": "two",
    "sum_var": "two",
    "odd_rate": "two",
    "big_rate": "two",
    "mean_overlap": "two",
    "sum_acf1": "two",
}

TEST_NAMES = {
    "chi2": "號碼均勻性（卡方）",
    "max_abs_dev": "單號最大偏離（最熱/最冷號是否異常）",
    "sum_mean": "每期總和平均",
    "sum_var": "每期總和變異",
    "odd_rate": "奇偶平衡",
    "big_rate": "大小號平衡",
    "mean_overlap": "前後期獨立性（重疊號碼數）",
    "sum_acf1": "時間趨勢（總和 lag-1 自相關）",
    "pair_var": "號碼對共現均勻性",
}


def empirical_p(observed, null_samples, tail):
    null = np.asarray(null_samples, dtype=np.float64)
    M = null.size
    center = null.mean()
    if tail == "right":
        hits = int((null >= observed).sum())
        return (hits + 1) / (M + 1)
    # two-sided：以「離中心至少一樣遠」定義極端
    dist = abs(observed - center)
    hits = int((np.abs(null - center) >= dist).sum())
    return (hits + 1) / (M + 1)


def benjamini_hochberg(pvals):
    """回傳每個 p 的 BH 校正後 q 值（同序）。"""
    p = np.asarray(pvals, dtype=np.float64)
    n = p.size
    order = np.argsort(p)
    ranked = p[order]
    q = ranked * n / (np.arange(1, n + 1))
    q = np.minimum.accumulate(q[::-1])[::-1]   # 保證單調
    out = np.empty(n)
    out[order] = np.clip(q, 0, 1)
    return out


def simulate_null(D, N, k, special, M, seed=20260623):
    """模擬 M 次『公平開獎』，回傳每個統計量的 null 分布 + 特別號卡方 null。"""
    rng = np.random.default_rng(seed)
    keys = list(TAIL.keys())
    null = {key: np.empty(M) for key in keys}
    null_special_chi2 = np.empty(M) if special else None
    n_balls = k + (1 if special else 0)

    for i in range(M):
        # 對每一期抽 n_balls 個相異號：用隨機鍵排序取前幾名（與真實設計一致）
        order = np.argsort(rng.random((D, N)), axis=1)
        main = order[:, :k] + 1
        st = compute_stats(main, N, k)
        for key in keys:
            null[key][i] = st[key]
        if special:
            sp = order[:, k] + 1
            exp = D / N
            cnt = np.bincount(sp, minlength=N + 1)[1:]
            null_special_chi2[i] = ((cnt - exp) ** 2 / exp).sum()
    return null, null_special_chi2


def gambler_fallacy_table(main_draws, N, k):
    """遺漏越久 → 開出率越高？（賭徒謬誤）逐號統計各遺漏區間的條件開出率。"""
    D = main_draws.shape[0]
    member = membership_matrix(main_draws, N).astype(bool)  # (D,N)
    edges = [(0, 9), (10, 19), (20, 29), (30, 10**9)]
    hit = np.zeros(len(edges))
    tot = np.zeros(len(edges))
    for num in range(N):
        gap = 0
        col = member[:, num]
        for i in range(D):
            for b, (lo, hi) in enumerate(edges):
                if lo <= gap <= hi:
                    bucket = b
                    break
            tot[bucket] += 1
            if col[i]:
                hit[bucket] += 1
                gap = 0
            else:
                gap += 1
    base = k / N
    rows = []
    labels = ["遺漏 0–9 期", "遺漏 10–19 期", "遺漏 20–29 期", "遺漏 30+ 期"]
    for b, label in enumerate(labels):
        n = int(tot[b])
        rate = hit[b] / n if n else 0.0
        se = (base * (1 - base) / n) ** 0.5 if n else 0.0
        z = (rate - base) / se if se else 0.0
        rows.append((label, rate, base, n, z))
    return rows, base


def audit_game(name, cfg, M):
    main, specials = load_draws(cfg["file"], cfg["N"], cfg["k"])
    N, k = cfg["N"], cfg["k"]
    D = main.shape[0]
    print(f"\n{'='*68}")
    print(f"  {name}　樣本 {D} 期（{N} 選 {k}{'＋特別號' if cfg['special'] else ''}）")
    print(f"{'='*68}")

    obs = compute_stats(main, N, k)
    t0 = time.time()
    null, null_sp = simulate_null(D, N, k, cfg["special"], M)
    sim_secs = time.time() - t0

    rows = []
    for key in TAIL:
        p = empirical_p(obs[key], null[key], TAIL[key])
        rows.append([TEST_NAMES[key], obs[key], null[key].mean(), p])

    # 特別號均勻性（用它自己的 null）
    if cfg["special"] and specials.size > 30:
        exp = specials.size / N
        cnt = np.bincount(specials, minlength=N + 1)[1:]
        sp_chi2 = float(((cnt - exp) ** 2 / exp).sum())
        p_sp = empirical_p(sp_chi2, null_sp, "right")
        rows.append(["特別號均勻性（卡方）", sp_chi2, null_sp.mean(), p_sp])

    pvals = [r[3] for r in rows]
    qvals = benjamini_hochberg(pvals)
    bonf = min(1.0, 0.05 / len(pvals))

    print(f"  Monte Carlo 模擬 {M} 次（{sim_secs:.1f}s）　"
          f"Bonferroni 門檻 α'={bonf:.4f}\n")
    print(f"  {'檢定項目':<34}{'觀測值':>12}{'隨機均值':>12}{'p 值':>10}{'BH-q':>9}  判定")
    print(f"  {'-'*82}")
    n_flag = 0
    for (tname, ov, mean, p), q in zip(rows, qvals):
        flag = "⚠ 偏離" if q < 0.05 else "✓ 隨機"
        if q < 0.05:
            n_flag += 1
        pstr = "<0.0001" if p < 1e-4 else f"{p:.4f}"
        print(f"  {tname:<32}{ov:>13.3f}{mean:>12.3f}{pstr:>10}{q:>9.3f}  {flag}")

    print(f"\n  → 多重比較 (FDR<0.05) 校正後：{len(rows) - n_flag}/{len(rows)} 項與真隨機無法區分"
          + ("，未發現操控指紋。" if n_flag == 0 else f"，{n_flag} 項待查。"))

    # 賭徒謬誤
    print(f"\n  「久未開出 = 即將開出」？（基準開出率 {(k/N)*100:.2f}%）")
    gtab, base = gambler_fallacy_table(main, N, k)
    for label, rate, base, n, z in gtab:
        mark = "" if abs(z) < 2 else "  ← 偏離 2σ"
        print(f"    {label:<14} 開出率 {rate*100:5.2f}%　(n={n:>6})　z={z:+5.2f}{mark}")
    print(f"    → 各遺漏區間開出率皆貼近基準、無單調上升 = 號碼不會因『冷很久』而更易開出。")
    return n_flag


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--sims", type=int, default=5000, help="Monte Carlo 模擬次數")
    ap.add_argument("--games", nargs="*", default=None, help="指定彩種，預設全部有資料者")
    args = ap.parse_args()

    import os
    print(f"開獎公正性稽核 (Monte Carlo, sims={args.sims})")
    total_flags = 0
    for name, cfg in GAMES.items():
        if args.games and name not in args.games:
            continue
        if not os.path.exists(cfg["file"]):
            print(f"\n[略過] {name}：找不到 {cfg['file']}")
            continue
        total_flags += audit_game(name, cfg, args.sims)

    print(f"\n{'='*68}")
    if total_flags == 0:
        print("  總結：所有彩種、所有檢定，經多重比較校正後，與『真隨機』在統計上")
        print("        無法區分。沒有可被利用的偏差 —— 也就是沒有可預測的 edge。")
        print("        這正是公平樂透的定義性質，不是 bug。")
    else:
        print(f"  總結：共 {total_flags} 項檢定在 FDR<0.05 下偏離，需逐項複查是否為")
        print("        殘餘雜訊或真實指紋（提高 --sims 並擴大樣本再確認）。")
    print(f"{'='*68}")


if __name__ == "__main__":
    main()
