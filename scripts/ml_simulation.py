"""
LSTM + 馬可夫鏈 開獎模擬系統 (ML Simulation: LSTM + Markov Chain)
================================================================
依需求建構「完整模擬系統」：歷史數據抓取 → 機器學習候選號碼生成 → 回測(Backtesting)。

模型：
  A. 馬可夫鏈 (Markov Chain)：每個號碼的一階「出現/未出現」二態轉移機率，
     用 P(下一期出現 | 本期狀態) 給每個號碼打分，取 top-k 當候選。
  B. LSTM (長短期記憶網路)：以每期「多熱(multi-hot)向量」為輸入序列，預測下一期
     各號碼的出現機率(sigmoid 多標籤)，取 top-k 當候選。純 numpy 自行實作前向 +
     BPTT 反向傳播，啟動時做數值梯度檢查確保反向傳播正確。

回測：walk-forward、無洩漏(模型只用測試點之前的資料/權重)。逐期把各模型 top-k 候選
與實際開獎比對，累積命中率對「隨機基準 k/N」做顯著性檢定(Wilson 區間 + 單尾 p)。

⚠ 誠實前提：公正抽獎下每一組號碼中獎機率都相同。本程式不是要「贏過開獎機」，而是把
   LSTM/馬可夫攤在嚴謹回測上，誠實檢驗它們到底有沒有勝過隨機。結論以實測數字為準。
   （與本專案 randomness_audit.py / rolling_calibration.py / heartbeat_predict.py 同調。）

用法:
    python scripts/ml_simulation.py --game 539
    python scripts/ml_simulation.py --game 649 --test 300 --epochs 6
"""
import argparse
import json
import math
import os
import sys
import urllib.request

import numpy as np

sys.stdout.reconfigure(encoding="utf-8")

GAMES = {
    "539":   {"file": "daily539.json", "name": "今彩539", "N": 39, "k": 5},
    "649":   {"file": "lotto649.json", "name": "大樂透", "N": 49, "k": 6},
    "power": {"file": "power.json",    "name": "威力彩", "N": 38, "k": 6},
}
RAW_BASE = "https://raw.githubusercontent.com/tsanghung/lotto-predictions/main/data/"


# ── 歷史數據抓取 ──────────────────────────────────────────────────────────
def load_draws(game):
    cfg = GAMES[game]
    path = os.path.join("data", cfg["file"])
    if not os.path.exists(path):
        # 本地沒有就從 repo raw 抓取
        try:
            data = json.loads(urllib.request.urlopen(RAW_BASE + cfg["file"], timeout=20).read())
            os.makedirs("data", exist_ok=True)
            json.dump(data, open(path, "w"))
        except Exception as e:
            raise SystemExit(f"data fetch failed: {type(e).__name__} {e}")
    rows = json.load(open(path, encoding="utf-8"))
    rows = [r for r in rows if r.get("numbers")]
    rows.sort(key=lambda r: (r.get("date", ""), str(r.get("draw_id", ""))))
    N = cfg["N"]
    X = np.zeros((len(rows), N), dtype=np.float64)
    for t, r in enumerate(rows):
        for n in r["numbers"]:
            if 1 <= int(n) <= N:
                X[t, int(n) - 1] = 1.0
    return X


# ── 馬可夫鏈 ──────────────────────────────────────────────────────────────
def markov_scores(train_X, prev_vec, N):
    """一階二態(在/不在)轉移：回傳每個號碼下一期出現的機率分數。"""
    # counts[state][to_in] : state 0=未出現,1=出現
    trans = np.ones((N, 2, 2))  # Laplace 平滑
    for t in range(1, len(train_X)):
        prev = train_X[t - 1]
        cur = train_X[t]
        for n in range(N):
            trans[n, int(prev[n]), int(cur[n])] += 1
    scores = np.zeros(N)
    for n in range(N):
        s = int(prev_vec[n])
        scores[n] = trans[n, s, 1] / trans[n, s].sum()
    return scores


# ── LSTM（純 numpy，前向 + BPTT）───────────────────────────────────────────
def sigmoid(x):
    return 1.0 / (1.0 + np.exp(-np.clip(x, -30, 30)))


class LSTM:
    def __init__(self, N, H, seed=0):
        rng = np.random.default_rng(seed)
        Z = N + H
        s = 1.0 / math.sqrt(Z)
        self.N, self.H = N, H
        self.p = {
            "Wf": rng.uniform(-s, s, (H, Z)), "bf": np.zeros(H),
            "Wi": rng.uniform(-s, s, (H, Z)), "bi": np.zeros(H),
            "Wg": rng.uniform(-s, s, (H, Z)), "bg": np.zeros(H),
            "Wo": rng.uniform(-s, s, (H, Z)), "bo": np.zeros(H),
            "Wy": rng.uniform(-1.0 / math.sqrt(H), 1.0 / math.sqrt(H), (N, H)), "by": np.zeros(N),
        }
        self.p["bf"] += 1.0  # forget-gate 偏置設 1，初期較好記憶

    def forward(self, X, h0=None, c0=None, cache=False):
        H = self.H
        h = np.zeros(H) if h0 is None else h0.copy()
        c = np.zeros(H) if c0 is None else c0.copy()
        ys, caches = [], []
        for x in X:
            z = np.concatenate([x, h])
            f = sigmoid(self.p["Wf"] @ z + self.p["bf"])
            i = sigmoid(self.p["Wi"] @ z + self.p["bi"])
            g = np.tanh(self.p["Wg"] @ z + self.p["bg"])
            o = sigmoid(self.p["Wo"] @ z + self.p["bo"])
            c_new = f * c + i * g
            tc = np.tanh(c_new)
            h = o * tc
            y = sigmoid(self.p["Wy"] @ h + self.p["by"])
            ys.append(y)
            if cache:
                caches.append((z, f, i, g, o, c, c_new, tc, h, y))
            c = c_new
        return np.array(ys), (caches, h, c)

    def loss_and_grad(self, X, Y):
        """BCE 損失與所有參數梯度（單一序列 BPTT）。"""
        ys, (caches, _, _) = self.forward(X, cache=True)
        eps = 1e-12
        loss = float(-np.sum(Y * np.log(ys + eps) + (1 - Y) * np.log(1 - ys + eps)))
        grads = {kk: np.zeros_like(v) for kk, v in self.p.items()}
        N, H = self.N, self.H
        dh_next = np.zeros(H)
        dc_next = np.zeros(H)
        for t in reversed(range(len(X))):
            z, f, i, g, o, c_prev, c_new, tc, h, y = caches[t]
            dpre_y = (y - Y[t])
            grads["Wy"] += np.outer(dpre_y, h)
            grads["by"] += dpre_y
            dh = self.p["Wy"].T @ dpre_y + dh_next
            do = dh * tc
            do_pre = do * o * (1 - o)
            dc = dh * o * (1 - tc * tc) + dc_next
            df = dc * c_prev
            df_pre = df * f * (1 - f)
            di = dc * g
            di_pre = di * i * (1 - i)
            dg = dc * i
            dg_pre = dg * (1 - g * g)
            dz = np.zeros(N + H)
            for name, gp in (("f", df_pre), ("i", di_pre), ("g", dg_pre), ("o", do_pre)):
                grads["W" + name] += np.outer(gp, z)
                grads["b" + name] += gp
                dz += self.p["W" + name].T @ gp
            dh_next = dz[N:]
            dc_next = dc * f
        return loss, grads


def gradient_check():
    """數值梯度檢查：確保 BPTT 反向傳播正確（相對誤差需 < 1e-4）。"""
    rng = np.random.default_rng(1)
    N, H, T = 4, 3, 5
    net = LSTM(N, H, seed=2)
    X = (rng.random((T, N)) < 0.5).astype(float)
    Y = (rng.random((T, N)) < 0.5).astype(float)
    _, grads = net.loss_and_grad(X, Y)
    worst = 0.0
    for name in net.p:
        flat = net.p[name].ravel()
        gflat = grads[name].ravel()
        for idx in range(0, flat.size, max(1, flat.size // 4)):
            orig = flat[idx]
            h = 1e-5
            flat[idx] = orig + h
            lp, _ = net.loss_and_grad(X, Y)
            flat[idx] = orig - h
            lm, _ = net.loss_and_grad(X, Y)
            flat[idx] = orig
            num = (lp - lm) / (2 * h)
            rel = abs(num - gflat[idx]) / max(1e-8, abs(num) + abs(gflat[idx]))
            worst = max(worst, rel)
    return worst


def train_lstm(net, X_train, seq, epochs, windows_per_epoch, lr=0.01, seed=0):
    rng = np.random.default_rng(seed)
    # Adam 狀態
    m = {k: np.zeros_like(v) for k, v in net.p.items()}
    v = {k: np.zeros_like(v) for k, v in net.p.items()}
    b1, b2, eps = 0.9, 0.999, 1e-8
    step = 0
    starts_all = np.arange(0, len(X_train) - seq - 1)
    for ep in range(epochs):
        rng.shuffle(starts_all)
        starts = starts_all[:windows_per_epoch]
        ep_loss = 0.0
        for s in starts:
            xs = X_train[s:s + seq]
            ys = X_train[s + 1:s + seq + 1]
            loss, grads = net.loss_and_grad(xs, ys)
            ep_loss += loss / seq
            step += 1
            for k in net.p:
                g = grads[k] / seq
                np.clip(g, -5, 5, out=g)
                m[k] = b1 * m[k] + (1 - b1) * g
                v[k] = b2 * v[k] + (1 - b2) * (g * g)
                mhat = m[k] / (1 - b1 ** step)
                vhat = v[k] / (1 - b2 ** step)
                net.p[k] -= lr * mhat / (np.sqrt(vhat) + eps)
        print(f"    epoch {ep + 1}/{epochs}  avg BCE/step {ep_loss / max(1, len(starts)):.3f}")


# ── 回測統計 ──────────────────────────────────────────────────────────────
def wilson_ci(hits, trials, z=1.96):
    if trials == 0:
        return (0.0, 0.0)
    p = hits / trials
    d = 1 + z * z / trials
    c = (p + z * z / (2 * trials)) / d
    half = z * math.sqrt(p * (1 - p) / trials + z * z / (4 * trials * trials)) / d
    return (c - half, c + half)


def one_sided_p(hits, trials, base):
    if trials == 0:
        return 1.0
    se = math.sqrt(base * (1 - base) / trials)
    zz = (hits / trials - base) / se if se > 0 else 0.0
    return 0.5 * math.erfc(zz / math.sqrt(2))


def topk(scores, k):
    return set((np.argsort(-scores)[:k] + 1).tolist())


def run(game, test_window, hidden, epochs, seq, windows, seed):
    cfg = GAMES[game]
    N, k = cfg["N"], cfg["k"]
    base = k / N
    X = load_draws(game)
    T = len(X)
    test_start = max(seq + 10, T - test_window)
    train_X = X[:test_start]

    print(f"\n{'=' * 76}\n  {cfg['name']}　LSTM + 馬可夫鏈 模擬回測（{N} 選 {k}）")
    print(f"  歷史 {T} 期；訓練 0..{test_start - 1}，回測 {test_start}..{T - 1}（{T - test_start} 期 walk-forward）")
    print(f"  隨機單顆基準 base = k/N = {k}/{N} = {base * 100:.2f}%\n{'=' * 76}")

    # LSTM：訓練(只用訓練段) → 全序列前向一次取得每期對「下一期」的預測（無洩漏）
    print("  [LSTM] 訓練中…")
    net = LSTM(N, hidden, seed=seed)
    train_lstm(net, train_X, seq, epochs, windows, seed=seed)
    preds, _ = net.forward(X, cache=False)   # preds[t] = 預測第 t+1 期

    models = {"LSTM": [], "Markov": [], "Frequency": []}
    freq_scores = train_X.sum(axis=0)        # 訓練段總頻率（靜態熱號基準）
    hits = {m: 0 for m in models}
    trials = 0
    for t in range(test_start, T):
        actual = set(np.where(X[t] == 1)[0] + 1)
        # LSTM 候選：用 preds[t-1]（只依賴 0..t-1）
        lstm_cand = topk(preds[t - 1], k)
        # Markov 候選：以 t-1 期狀態，轉移機率只用訓練段估計
        mk_scores = markov_scores(train_X, X[t - 1], N)
        mk_cand = topk(mk_scores, k)
        # 頻率(熱號)候選：靜態
        fq_cand = topk(freq_scores, k)
        hits["LSTM"] += len(lstm_cand & actual)
        hits["Markov"] += len(mk_cand & actual)
        hits["Frequency"] += len(fq_cand & actual)
        trials += k

    print(f"\n  ▸ 回測結果（{T - test_start} 期；trials={trials}）")
    print(f"    {'模型':>10}{'命中率':>9}{'相對隨機':>10}{'95% CI':>20}{'p(勝隨機)':>11}  判定")
    print(f"    {'-' * 72}")
    for m in ["LSTM", "Markov", "Frequency"]:
        h = hits[m]
        rate = h / trials
        lo, hi = wilson_ci(h, trials)
        p = one_sided_p(h, trials, base)
        verdict = "顯著勝出 ⚠" if (p < 0.05 and rate > base) else "與隨機無異 ✓"
        print(f"    {m:>10}{rate * 100:>8.2f}%{(rate - base) * 100:>+9.2f}%"
              f"   [{lo * 100:5.2f}%,{hi * 100:5.2f}%]{p:>11.3f}  {verdict}")

    # 當期候選（用全部資料）
    print(f"\n  ▸ 當期候選號碼（top-{k}，僅供模型展示，非中獎保證）")
    full_net_pred = preds[-1]
    print(f"    LSTM  ：{sorted(topk(full_net_pred, k))}")
    print(f"    Markov：{sorted(topk(markov_scores(X, X[-1], N), k))}")
    print(f"\n  結論：上述命中率若都落在 {base * 100:.2f}% 附近、p≥0.05，代表 LSTM 與馬可夫鏈"
          f"\n        在嚴謹 walk-forward 回測下『贏不過隨機』—— 開獎序列無可被學習的訊號。")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--game", choices=list(GAMES) + ["all"], default="539")
    ap.add_argument("--test", type=int, default=400, help="回測期數")
    ap.add_argument("--hidden", type=int, default=32, help="LSTM 隱藏層維度")
    ap.add_argument("--epochs", type=int, default=6)
    ap.add_argument("--seq", type=int, default=25, help="BPTT 視窗長度")
    ap.add_argument("--windows", type=int, default=300, help="每 epoch 訓練視窗數")
    ap.add_argument("--seed", type=int, default=42)
    args = ap.parse_args()

    rel = gradient_check()
    print(f"LSTM 梯度檢查：最差相對誤差 {rel:.2e}（< 1e-4 視為反向傳播正確）")
    if rel > 1e-4:
        raise SystemExit("gradient check failed — BPTT 反向傳播有誤")

    keys = list(GAMES) if args.game == "all" else [args.game]
    for game in keys:
        run(game, args.test, args.hidden, args.epochs, args.seq, args.windows, args.seed)


if __name__ == "__main__":
    main()
