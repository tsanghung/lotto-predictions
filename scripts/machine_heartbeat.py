"""
開獎機心跳偵測 (Machine Heartbeat / Time-Series Signal Detection)
=================================================================
把開獎史當成一段『訊號』，用聽診器找這台機器的脈搏、節律、記憶。

如果開獎機真有「心跳」—— 任何時間上的規律、記憶、週期 —— 它必然以下列形式現身：
  1. 自相關 (ACF)：今天的開獎會不會「記得」幾期前的自己？任一 lag 有顯著相關 = 有記憶。
  2. 功率頻譜 (Periodogram)：序列裡藏著週期節律嗎？任一頻率有突出尖峰 = 有節拍。
  3. Ljung–Box Q：前 m 個 lag 的自相關「整體」是否為零？這是『序列有無記憶』的總檢定。

虛無假設（公平機台）下這些統計量的分布，用『與真實開獎完全相同的抽樣設計』
Monte Carlo 模擬出來，得到精確經驗 p 值（不靠漸近近似、不需 scipy）。

用法:
    python scripts/machine_heartbeat.py --sims 3000
"""

import json
import time
import argparse
import sys

import numpy as np

sys.stdout.reconfigure(encoding="utf-8")

GAMES = {
    "大樂透": {"file": "data/lotto649.json", "N": 49, "k": 6},
    "今彩539": {"file": "data/daily539.json", "N": 39, "k": 5},
    "威力彩": {"file": "data/power.json", "N": 38, "k": 6},
}

K_LAGS = 40        # 觀察的自相關 lag 數
LB_M = 20          # Ljung-Box 納入的 lag 數


def load_series(path, k):
    with open(path, "r", encoding="utf-8") as f:
        raw = sorted(json.load(f), key=lambda d: d["date"])
    draws = np.array([sorted(d["numbers"]) for d in raw if len(d["numbers"]) == k], dtype=np.int64)
    sums = draws.sum(axis=1).astype(np.float64)
    odd = (draws % 2 == 1).sum(axis=1).astype(np.float64)
    return sums, odd


def acf(x, K):
    x = x - x.mean()
    denom = float((x * x).sum())
    if denom == 0:
        return np.zeros(K)
    return np.array([float((x[j:] * x[:-j]).sum()) / denom for j in range(1, K + 1)])


def ljung_box(r, n, m):
    j = np.arange(1, m + 1)
    return float(n * (n + 2) * np.sum(r[:m] ** 2 / (n - j)))


def spectral_peak_ratio(x):
    """最大頻譜尖峰 / 平均功率（Fisher's g 風格）；越大代表越像有週期節律。"""
    x = x - x.mean()
    power = np.abs(np.fft.rfft(x)) ** 2
    power = power[1:]                      # 去掉 0 頻（直流）
    if power.size == 0 or power.mean() == 0:
        return 0.0, 0
    idx = int(np.argmax(power))
    return float(power[idx] / power.mean()), idx + 1   # +1 因為切掉了 index 0


def sim_sum_odd(D, N, k, rng):
    order = np.argpartition(rng.random((D, N)), kth=k - 1, axis=1)[:, :k] + 1
    return order.sum(axis=1).astype(np.float64), (order % 2 == 1).sum(axis=1).astype(np.float64)


def audit(name, cfg, M, seed=20260623):
    sums, odd = load_series(cfg["file"], cfg["k"])
    N, k = cfg["N"], cfg["k"]
    D = sums.size

    print(f"\n{'='*72}")
    print(f"  {name}　序列長度 {D} 期　—— 對『每期總和』聽診")
    print(f"{'='*72}")

    # 觀測統計量
    r_obs = acf(sums, K_LAGS)
    lb_obs = ljung_box(r_obs, D, LB_M)
    peak_obs, peak_idx = spectral_peak_ratio(sums)
    peak_period = D / peak_idx

    # Monte Carlo 虛無分布
    rng = np.random.default_rng(seed)
    t0 = time.time()
    lb_null = np.empty(M)
    peak_null = np.empty(M)
    band_hits_null = np.empty(M)
    band = 1.96 / np.sqrt(D)
    for i in range(M):
        s, _ = sim_sum_odd(D, N, k, rng)
        r = acf(s, K_LAGS)
        lb_null[i] = ljung_box(r, D, LB_M)
        peak_null[i] = spectral_peak_ratio(s)[0]
        band_hits_null[i] = int((np.abs(r) > band).sum())
    secs = time.time() - t0

    p_lb = (int((lb_null >= lb_obs).sum()) + 1) / (M + 1)
    p_peak = (int((peak_null >= peak_obs).sum()) + 1) / (M + 1)

    # ACF 超出 95% 白雜訊帶的 lag
    exceed = [(j + 1, r_obs[j]) for j in range(K_LAGS) if abs(r_obs[j]) > band]
    big_lag = int(np.argmax(np.abs(r_obs))) + 1
    big_val = r_obs[big_lag - 1]

    print(f"  Monte Carlo {M} 次（{secs:.1f}s）　白雜訊 95% 帶 = ±{band:.4f}\n")

    print(f"  ① 自相關 (ACF) — 機台會不會『記得』前幾期？")
    print(f"     最強自相關落在 lag {big_lag}：ρ = {big_val:+.4f}"
          f"（白雜訊帶 ±{band:.4f}）")
    print(f"     40 個 lag 中超出帶外：{len(exceed)} 個"
          f"（純隨機預期約 {0.05*K_LAGS:.0f} 個）")
    if exceed[:6]:
        shown = "、".join(f"lag{j}({v:+.3f})" for j, v in exceed[:6])
        print(f"     超出者：{shown}{' …' if len(exceed) > 6 else ''}")

    print(f"\n  ② 功率頻譜 — 序列裡藏著週期節律嗎？")
    print(f"     最強尖峰：週期 ≈ {peak_period:.1f} 期，強度比 = {peak_obs:.2f}× 平均功率")
    print(f"     對照隨機最強尖峰均值 {peak_null.mean():.2f}×　→　p = {p_peak:.4f}")

    print(f"\n  ③ Ljung–Box Q（前 {LB_M} lag 整體記憶檢定）")
    print(f"     Q = {lb_obs:.2f}　隨機均值 {lb_null.mean():.2f}　→　p = {p_lb:.4f}")

    flat = p_lb >= 0.05 and p_peak >= 0.05 and len(exceed) <= 0.05 * K_LAGS + 2
    print(f"\n  心電圖判讀：", end="")
    if flat:
        print("─────────  平直線（flatline）。沒有脈搏、沒有記憶、沒有節律。")
    else:
        print("偵測到疑似訊號,需提高 sims 與樣本複查是否為殘餘雜訊。")
    return flat


def main():
    import os
    ap = argparse.ArgumentParser()
    ap.add_argument("--sims", type=int, default=3000)
    args = ap.parse_args()
    print(f"開獎機心跳偵測 (Monte Carlo, sims={args.sims})")
    all_flat = True
    for name, cfg in GAMES.items():
        if not os.path.exists(cfg["file"]):
            print(f"\n[略過] {name}：找不到 {cfg['file']}")
            continue
        all_flat &= audit(name, cfg, args.sims)
    print(f"\n{'='*72}")
    if all_flat:
        print("  結論：聽診器貼上去了。19 年的開獎序列，心電圖是一條平直線。")
        print("        這不是『沒找到心跳』—— 在通過認證的公平機台上，平直線『就是』")
        print("        它的心跳。沒有節律可感知，因為節律正是工程上被刻意消除、")
        print("        並反覆送驗的東西。可被感知的脈搏，從一開始就不在機器裡。")
    print(f"{'='*72}")


if __name__ == "__main__":
    main()
