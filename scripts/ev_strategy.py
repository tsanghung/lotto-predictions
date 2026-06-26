"""
Direction 2 — 期望值最佳化（博弈論：避開大眾號碼、降低均分風險）
==================================================================
前提（已由 Direction 1 證實）：號碼不可預測、每組組合中獎機率完全相同。
因此唯一可動的槓桿不是「機率」，而是「中獎後的分配」：

  pari-mutuel 頭獎（大樂透、威力彩 第一區頭獎）會由所有同號中獎者平分。
  你的對手不是開獎機，是其他投注者。大眾系統性地偏好生日號(1–31)、
  等差數列、連號、規則圖形。刻意避開這些 → 你中頭獎時與人均分的機率下降
  → 「中獎後的期望分得金額」上升。

  ⚠ 鐵律：這【不】提高中獎機率，【不】讓期望值翻正（莊家抽成仍在）。
     它只在『你真的中了頭獎』時，讓你少跟人分。且只對 pari-mutuel 獎項有效；
     固定獎金獎項（今彩539 多數獎項）無此效果。

本程式：① 算出各遊戲精確頭獎機率（提醒機率不變）
        ② 用「大眾選號偏好模型」給任一組合一個 popularity index（越高越易被均分）
        ③ 對照熱門組合 vs 低人氣組合，並產生一組低人氣示範號
"""

from math import comb
from itertools import combinations as iter_comb
import sys

sys.stdout.reconfigure(encoding="utf-8")

GAMES = {
    "大樂透": {"N": 49, "k": 6, "pari_mutuel_jackpot": True},
    "今彩539": {"N": 39, "k": 5, "pari_mutuel_jackpot": False},  # 多為固定獎金，槓桿無效
    "威力彩": {"N": 38, "k": 6, "pari_mutuel_jackpot": True},
}


def pick_weight(n):
    """大眾單號偏好權重：生日效應讓 1–31 被超選，32+ 被冷落。"""
    if 1 <= n <= 12:
        return 3.0   # 可當月份也可當日 → 最常被選
    if 13 <= n <= 31:
        return 2.0   # 只能當日
    return 1.0       # 無日曆意義 → 大眾冷落


def popularity_index(combo):
    """0~100：估計一組號碼「被其他投注者選中」的相對傾向（越高越易均分）。"""
    score = sum(pick_weight(n) for n in combo) / (3.0 * len(combo))  # 0.33~1 的日曆成分

    s = sorted(combo)
    # 連號/等差：規則圖形被大眾與「機巧型」玩家偏好
    diffs = [s[i + 1] - s[i] for i in range(len(s) - 1)]
    if len(set(diffs)) == 1:
        score += 0.4                       # 完美等差(含連號)
    run = 1
    for i in range(1, len(s)):
        run = run + 1 if s[i] == s[i - 1] + 1 else 1
        if run >= 3:
            score += 0.2
            break
    if all(n <= 31 for n in combo):
        score += 0.3                       # 全生日號
    tails = [n % 10 for n in combo]
    if len(set(tails)) <= len(combo) - 2:
        score += 0.1                       # 多個同尾(規則感)
    return round(min(score, 1.5) / 1.5 * 100, 1)


def low_popularity_pick(N, k):
    """產生一組『正常但低人氣』示範號：偏 32+ 冷落區、不連號、尾數分散。"""
    pool = list(range(32, N + 1)) + list(range(13, 32))  # 先冷落區，再非生日熱區
    chosen = []
    for n in pool:
        if len(chosen) >= k:
            break
        if all(abs(n - c) != 1 for c in chosen) and (n % 10) not in [c % 10 for c in chosen]:
            chosen.append(n)
    for n in pool:  # 補滿(放寬尾數限制)
        if len(chosen) >= k:
            break
        if n not in chosen and all(abs(n - c) != 1 for c in chosen):
            chosen.append(n)
    return sorted(chosen[:k])


def main():
    print("=" * 72)
    print("  Direction 2：期望值最佳化（博弈論 — 避開大眾號碼，降低均分風險）")
    print("=" * 72)

    for name, cfg in GAMES.items():
        N, k = cfg["N"], cfg["k"]
        jackpot_odds = comb(N, k) * (8 if name == "威力彩" else 1)
        print(f"\n{name}（{N} 選 {k}）　頭獎機率 1/{jackpot_odds:,}（任何組合都一樣，槓桿不動這個）")

        if not cfg["pari_mutuel_jackpot"]:
            print("  ⚠ 此遊戲頭獎多為固定獎金、非均分 → 避開大眾號碼【無 EV 效果】，略過。")
            continue

        # 對照組
        birthday = sorted(list(iter_comb([4, 8, 15, 16, 23, 31], k))[0])  # 典型生日 + 名數列
        sequence = list(range(7, 7 + k))                                   # 等差/連號
        lowpop = low_popularity_pick(N, k)

        rows = [
            ("生日/幸運號", birthday),
            ("連號/等差", sequence),
            ("低人氣示範", lowpop),
        ]
        print(f"  {'組合類型':<14}{'號碼':<26}{'popularity':>11}{'中獎機率':>12}")
        print(f"  {'-'*62}")
        for label, combo in rows:
            pi = popularity_index(combo)
            print(f"  {label:<14}{str(combo):<26}{pi:>10.1f}%{'1/'+format(jackpot_odds, ','):>14}")
        pop_pi = popularity_index(birthday)
        low_pi = popularity_index(lowpop)
        if low_pi > 0:
            print(f"  → 低人氣組合的『被均分傾向』約為生日組合的 {low_pi/pop_pi:.0%}"
                  f"（中獎機率完全相同，差別只在中獎後少跟人分）")

    print("\n" + "=" * 72)
    print("  誠實邊界：")
    print("   • 中獎機率不變、期望值仍為負（莊家抽成 ~一半）—— 這不是會賺錢的系統。")
    print("   • popularity index 用的是『生日/圖形偏好』的通用模型，非台灣實際投注分布；")
    print("     方向與排序可靠，絕對倍數需要官方投注資料才能精算。")
    print("   • 唯一真實效果：pari-mutuel 頭獎中獎時，期望分得金額較高。如此而已。")
    print("=" * 72)


if __name__ == "__main__":
    main()
