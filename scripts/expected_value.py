"""
期望值真相 ① — 中獎機率（純組合數學，完全可驗證）
====================================================
這一段不需要任何外部資料，全部由遊戲規則用組合數精確算出。
EV 的金額部分需要『官方獎金表』，等你確認後再補上（見輸出末尾）。

模型：
  今彩539：39 選 5，玩家選 5。中 m 碼機率 = C(5,m)·C(34,5-m)/C(39,5)
  大樂透 ：49 選 6 + 特別號(自剩 43 抽 1)，玩家選 6。
          中 a 個一般號機率 = C(6,a)·C(43,6-a)/C(49,6)；
          特別號命中機率 = (6-a)/43（玩家未中一般號的號落在特別號上）
  威力彩 ：第一區 38 選 6、第二區 8 選 1，兩區獨立。
"""

from math import comb
import sys

sys.stdout.reconfigure(encoding="utf-8")


def odds_line(label, prob):
    inv = (1 / prob) if prob > 0 else float("inf")
    return f"    {label:<22} 機率 {prob:.3e}　≈ 1/{inv:,.0f}"


def daily539():
    N, k = 39, 5
    total = comb(N, k)
    print(f"\n今彩539（{N} 選 {k}）　總組合 C(39,5) = {total:,}")
    for m in range(k, 1, -1):
        p = comb(k, m) * comb(N - k, k - m) / total
        tier = {5: "頭獎 中5", 4: "貳獎 中4", 3: "參獎 中3", 2: "肆獎 中2"}.get(m, f"中{m}")
        print(odds_line(tier, p))


def lotto649():
    N, k, rem = 49, 6, 43
    total = comb(N, k)
    print(f"\n大樂透（{N} 選 {k} + 特別號）　總組合 C(49,6) = {total:,}")
    print(odds_line("頭獎 中6", 1 / total))
    for a in range(5, 1, -1):
        pa = comb(k, a) * comb(N - k, k - a) / total
        p_sp = (k - a) / rem
        if a in (5, 4, 3):
            print(odds_line(f"中{a}＋特別號", pa * p_sp))
        print(odds_line(f"中{a}（無特）", pa * (1 - p_sp)))


def power():
    N1, k1, N2 = 38, 6, 8
    total1 = comb(N1, k1)
    total = total1 * N2
    print(f"\n威力彩（第一區 {N1} 選 {k1}、第二區 {N2} 選 1）　總組合 = C(38,6)×8 = {total:,}")
    print(odds_line("頭獎 第一區6＋第二區", 1 / total))
    for a in range(6, 1, -1):
        pa = comb(k1, a) * comb(N1 - k1, k1 - a) / total1
        if a < 6:
            print(odds_line(f"第一區中{a}＋第二區", pa * (1 / N2)))
        print(odds_line(f"第一區中{a}（無第二區）", pa * (1 - 1 / N2)))


def main():
    print("=" * 64)
    print("  期望值真相 ①：中獎機率（exact combinatorics）")
    print("=" * 64)
    daily539()
    lotto649()
    power()
    print("\n" + "=" * 64)
    print("  三大頭獎機率對照（讓數字自己說話）")
    print("=" * 64)
    j539 = comb(39, 5)
    j649 = comb(49, 6)
    jpow = comb(38, 6) * 8
    print(f"    今彩539 頭獎  1/{j539:,}")
    print(f"    大樂透 頭獎   1/{j649:,}")
    print(f"    威力彩 頭獎   1/{jpow:,}")
    lightning = 15000  # 這輩子被閃電擊中的終生機率約 1/15,000
    print(f"\n    參考：這輩子被閃電擊中的機率約 1/{lightning:,}。換算下來，買一張：")
    print(f"      今彩539 中頭獎 ≈ 比被閃電擊中還難 {j539/lightning:,.0f} 倍")
    print(f"      大樂透 中頭獎   ≈ 比被閃電擊中還難 {j649/lightning:,.0f} 倍")
    print(f"      威力彩 中頭獎   ≈ 比被閃電擊中還難 {jpow/lightning:,.0f} 倍")
    print("\n  下一步（需要你確認）：")
    print("    要算出『每 100 元平均返還多少、莊家抽成多少』的精確 EV，")
    print("    我需要各遊戲的【官方現行獎金表】(每個獎項的固定獎金/票價)。")
    print("    你提供，或我去抓官方公布值 —— 確認後我就把 EV 與 house edge 補完。")


if __name__ == "__main__":
    main()
