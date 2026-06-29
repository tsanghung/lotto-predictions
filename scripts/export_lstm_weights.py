"""
離線訓練各彩種的小型 LSTM，並把權重匯出成 Edge Function 可用的 JS 模組。
（線上 Edge Function 不能訓練，只能做前向推論，故權重在此離線產生、定期重訓。）

輸出：supabase/functions/lotto-predict-notify/lib/mlWeights.js
      export const ML_WEIGHTS = { "539": {...}, "649": {...}, "power": {...} }

用法: python scripts/export_lstm_weights.py
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from ml_simulation import GAMES, LSTM, load_draws, train_lstm, gradient_check  # noqa: E402

HIDDEN = 12
EPOCHS = 4
SEQ = 25
WINDOWS = 250
SEED = 42
OUT = "supabase/functions/lotto-predict-notify/lib/mlWeights.js"


def rnd(a, nd=5):
    if hasattr(a, "tolist"):
        a = a.tolist()
    if isinstance(a, list):
        return [rnd(x, nd) for x in a]
    return round(float(a), nd)


def main():
    rel = gradient_check()
    if rel > 1e-4:
        raise SystemExit(f"gradient check failed: {rel}")
    print(f"gradient check ok ({rel:.1e})")

    out = {}
    for game, cfg in GAMES.items():
        X = load_draws(game)
        N = cfg["N"]
        print(f"[{cfg['name']}] training LSTM H={HIDDEN} on {len(X)} draws…")
        net = LSTM(N, HIDDEN, seed=SEED)
        train_lstm(net, X, SEQ, EPOCHS, WINDOWS, seed=SEED)
        out[game] = {
            "N": N, "H": HIDDEN,
            "Wf": rnd(net.p["Wf"]), "bf": rnd(net.p["bf"]),
            "Wi": rnd(net.p["Wi"]), "bi": rnd(net.p["bi"]),
            "Wg": rnd(net.p["Wg"]), "bg": rnd(net.p["bg"]),
            "Wo": rnd(net.p["Wo"]), "bo": rnd(net.p["bo"]),
            "Wy": rnd(net.p["Wy"]), "by": rnd(net.p["by"]),
        }

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    body = json.dumps(out, ensure_ascii=False, separators=(",", ":"))
    header = ("// 自動產生：scripts/export_lstm_weights.py（離線訓練的小型 LSTM 權重，供前向推論）。\n"
              "// 請勿手改；要更新就重跑該腳本。\n")
    with open(OUT, "w", encoding="utf-8") as f:
        f.write(header + "export const ML_WEIGHTS = " + body + ";\n")
    print(f"wrote {OUT} ({os.path.getsize(OUT)} bytes)")


if __name__ == "__main__":
    main()
