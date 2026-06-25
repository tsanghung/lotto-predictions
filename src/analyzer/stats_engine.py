"""Legacy offline statistics engine.

Production predictions do not run this module. Supabase Edge Function
`lotto-predict-notify` owns the live prediction path. Keep this module only for
local research, backtests, attribution experiments, and migration reference.
"""

import pandas as pd
import json
from itertools import combinations
from collections import Counter
from typing import Dict, List, Any, Tuple
import logging

logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')

class StatsEngine:
    def __init__(self, data_file: str | None = None, max_number: int = 49, df: pd.DataFrame | None = None):
        """
        data_file : JSON 歷史檔路徑（df 未提供時由此載入）
        max_number: 號碼上限（大樂透 49, 今彩539 為 39）
        df        : 直接注入已排序的 DataFrame（供回測切片重用，避免重複讀檔）
        """
        self.data_file = data_file
        self.max_number = max_number
        if df is not None:
            # 直接重用既有 DataFrame（回測時切片用）
            self.df = df.reset_index(drop=True)
        else:
            self.df = self._load_data()

    def head(self, n: int) -> "StatsEngine":
        """回傳僅含『最舊 n 期』的新 StatsEngine（回測時模擬當下可見的歷史）。"""
        return StatsEngine(max_number=self.max_number, df=self.df.head(n).copy())

    def _load_data(self) -> pd.DataFrame:
        with open(self.data_file, 'r', encoding='utf-8') as f:
            data = json.load(f)
        
        # 展開 numbers 陣列，讓分析更容易
        records = []
        for draw in data:
            row = {
                "draw_id": str(draw["draw_id"]),
                "date": draw["date"],
                "special_number": draw.get("special_number")
            }
            # 存成 list
            row["numbers"] = draw["numbers"]
            records.append(row)
            
        df = pd.DataFrame(records)
        # 依照開獎日期排序（由舊到新）— 不可用 draw_id 字串排序，會把 "99xxx" 排到 "115xxx" 之後
        df = df.sort_values("date").reset_index(drop=True)
        return df

    def get_missing_values(self) -> Dict[int, int]:
        """
        精確計算每個號碼目前連續未開出的期數 (遺漏值)。
        """
        missing_dict = {i: 0 for i in range(1, self.max_number + 1)}
        
        # 從最後一期往回推，紀錄最後一次出現的 index
        # 或者直接正向掃描，每次未出現就 +1，出現就歸 0
        for nums in self.df["numbers"]:
            # 所有號碼先 +1
            for i in range(1, self.max_number + 1):
                missing_dict[i] += 1
            # 有出現的歸 0
            for n in nums:
                missing_dict[n] = 0

        return missing_dict

    def get_average_intervals(self) -> Dict[int, float]:
        """
        每個號碼歷史平均開出間隔（期數）。
        以相鄰兩次出現的期序差取平均；出現 < 2 次者以 總期數/出現次數 估計。
        """
        total = len(self.df)
        last_idx: Dict[int, int | None] = {i: None for i in range(1, self.max_number + 1)}
        counts: Dict[int, int] = {i: 0 for i in range(1, self.max_number + 1)}
        gap_sum: Dict[int, int] = {i: 0 for i in range(1, self.max_number + 1)}
        gap_cnt: Dict[int, int] = {i: 0 for i in range(1, self.max_number + 1)}

        for idx, nums in enumerate(self.df["numbers"]):
            for n in nums:
                if 1 <= n <= self.max_number:
                    counts[n] += 1
                    if last_idx[n] is not None:
                        gap_sum[n] += idx - last_idx[n]
                        gap_cnt[n] += 1
                    last_idx[n] = idx

        avg: Dict[int, float] = {}
        for i in range(1, self.max_number + 1):
            if gap_cnt[i] > 0:
                avg[i] = gap_sum[i] / gap_cnt[i]
            elif counts[i] > 0:
                avg[i] = total / counts[i]
            else:
                avg[i] = float(total) if total else 1.0
        return avg

    def get_overdue_index(self) -> Dict[int, float]:
        """
        即將開出指數 = 目前遺漏期數 ÷ 該號平均間隔。
        > 1 代表已超過自身平均週期（相對「久未開出」）；數值越高越 overdue。
        注意：此為描述性統計，各期開獎在機率上仍為獨立事件。
        """
        missing = self.get_missing_values()
        avg = self.get_average_intervals()
        return {
            i: (missing[i] / avg[i] if avg.get(i) else 0.0)
            for i in range(1, self.max_number + 1)
        }

    def get_number_profiles(self, recent_periods: int | None = None) -> Dict[int, Dict[str, Any]]:
        """
        彙整每個號碼的完整檔案，供「選號理由」說明使用：
          appearances（史上出現次數）、recent_freq（近 N 期次數）、
          gap_draws / gap_days（目前已隔期數 / 天數）、
          avg_interval_draws / avg_interval_days（平均間隔 期 / 天）、
          overdue_index（即將開出指數 = gap_draws ÷ avg_interval_draws）。
        """
        from datetime import datetime

        total = len(self.df)
        if total == 0:
            return {}

        def pdate(s):
            return datetime.strptime(str(s)[:10], "%Y-%m-%d").date()

        dates = [pdate(d) for d in self.df["date"]]
        last_date_overall = dates[-1]
        rp = min(recent_periods or total, total)
        recent_start = total - rp

        idxs_map: Dict[int, List[int]] = {i: [] for i in range(1, self.max_number + 1)}
        recent_freq: Dict[int, int] = {i: 0 for i in range(1, self.max_number + 1)}
        for idx, nums in enumerate(self.df["numbers"]):
            for n in nums:
                if 1 <= n <= self.max_number:
                    idxs_map[n].append(idx)
                    if idx >= recent_start:
                        recent_freq[n] += 1

        out: Dict[int, Dict[str, Any]] = {}
        for n in range(1, self.max_number + 1):
            idxs = idxs_map[n]
            app = len(idxs)
            if not idxs:
                out[n] = {
                    "appearances": 0, "recent_freq": 0,
                    "gap_draws": total, "gap_days": None,
                    "avg_interval_draws": float(total), "avg_interval_days": None,
                    "overdue_index": 99.0,
                }
                continue
            gaps = [idxs[k] - idxs[k - 1] for k in range(1, len(idxs))]
            avg_draw = sum(gaps) / len(gaps) if gaps else total / app
            last_app_idx = idxs[-1]
            gap_draws = (total - 1) - last_app_idx
            avg_days = (dates[last_app_idx] - dates[idxs[0]]).days / (app - 1) if app > 1 else None
            gap_days = (last_date_overall - dates[last_app_idx]).days
            overdue = gap_draws / avg_draw if avg_draw else 0.0
            out[n] = {
                "appearances": app,
                "recent_freq": recent_freq[n],
                "gap_draws": gap_draws,
                "gap_days": gap_days,
                "avg_interval_draws": round(avg_draw, 1),
                "avg_interval_days": round(avg_days, 1) if avg_days is not None else None,
                "overdue_index": round(overdue, 2),
            }
        return out

    def get_hot_cold_stats(self, periods: int) -> Dict[str, Any]:
        """
        計算近 N 期的熱門與冷門號碼
        """
        if len(self.df) < periods:
            periods = len(self.df)
            
        recent_df = self.df.tail(periods)
        
        # 計算出現次數
        counts = {i: 0 for i in range(1, self.max_number + 1)}
        for nums in recent_df["numbers"]:
            for n in nums:
                counts[n] += 1
                
        # 排序
        sorted_counts = sorted(counts.items(), key=lambda x: x[1], reverse=True)
        
        return {
            "period_count": periods,
            "hot": [num for num, count in sorted_counts[:5]], # 前 5 名熱門
            "cold": [num for num, count in sorted_counts[-5:]], # 後 5 名冷門
            "frequencies": counts
        }

    def get_all_time_stats(self) -> Dict[str, Any]:
        """
        計算自資料起始（2007年）以來的完整頻率統計
        """
        counts = {i: 0 for i in range(1, self.max_number + 1)}
        for nums in self.df["numbers"]:
            for n in nums:
                counts[n] += 1
        
        sorted_counts = sorted(counts.items(), key=lambda x: x[1], reverse=True)
        
        return {
            "total_draws": len(self.df),
            "top_all_time": sorted_counts[:10], # 史上最常出現前 10 名
            "bottom_all_time": sorted_counts[-10:], # 史上最少出現前 10 名
            "average_frequency": len(self.df) * (len(self.df.iloc[0]["numbers"]) / self.max_number)
        }

    def get_distribution_features(self) -> Dict[str, Any]:
        """
        分佈統計：奇偶比、大小比 (以總數一半為界)、同尾數
        取最新一期的特徵，或近期趨勢。這裡我們計算最後一期的特徵。
        """
        latest_nums = self.df.iloc[-1]["numbers"]
        
        # 奇偶比 (奇:偶)
        odd_count = sum(1 for n in latest_nums if n % 2 != 0)
        even_count = len(latest_nums) - odd_count
        
        # 大小比 (>= max_number/2 為大)
        mid_point = self.max_number / 2
        large_count = sum(1 for n in latest_nums if n > mid_point)
        small_count = len(latest_nums) - large_count
        
        # 同尾數分析
        tails = [n % 10 for n in latest_nums]
        tail_counts = {t: tails.count(t) for t in set(tails)}
        same_tails = {t: c for t, c in tail_counts.items() if c > 1}

        return {
            "latest_draw_id": self.df.iloc[-1]["draw_id"],
            "odd_even_ratio": f"{odd_count}:{even_count}",
            "large_small_ratio": f"{large_count}:{small_count}",
            "same_tails_last_draw": same_tails
        }

    def get_sum_stats(self, periods: int | None = None) -> Dict[str, Any]:
        """
        開獎號碼總和統計：平均、最小、最大、±10%/±20% 區間。
        periods=None 表示使用全部歷史資料。
        """
        if periods is None:
            periods = len(self.df)
        elif len(self.df) < periods:
            periods = len(self.df)
        recent_df = self.df.tail(periods)
        sums = [sum(nums) for nums in recent_df["numbers"]]
        avg = sum(sums) / len(sums)
        return {
            "period_count": periods,
            "average": avg,
            "min": min(sums),
            "max": max(sums),
            "band_minus_10pct": avg * 0.9,
            "band_plus_10pct": avg * 1.1,
            "band_minus_20pct": avg * 0.8,
            "band_plus_20pct": avg * 1.2,
        }

    def get_pair_frequencies(self, periods: int | None = None, top_k: int = 10) -> Dict[str, Any]:
        """
        號碼對 (pair) 共現頻率：哪些『兩號組合』最常同時開出。
        相較單號頻率，號碼對更能捕捉號碼間的連帶結構。
        periods=None 表示使用全部歷史資料。
        """
        if periods is None:
            periods = len(self.df)
        elif len(self.df) < periods:
            periods = len(self.df)
        recent_df = self.df.tail(periods)

        pair_counter: Counter = Counter()
        for nums in recent_df["numbers"]:
            for a, b in combinations(sorted(nums), 2):
                pair_counter[(a, b)] += 1

        # 同時快取一份 frozenset -> count，供 StrategySampler 取用
        self.pair_freq_cache = {frozenset(k): v for k, v in pair_counter.items()}

        return {
            "period_count": periods,
            "top_pairs": [(list(k), v) for k, v in pair_counter.most_common(top_k)],
        }

    def get_triplet_frequencies(self, periods: int | None = None, top_k: int = 8) -> Dict[str, Any]:
        """
        三聯 (triplet) 共現頻率：哪些『三號組合』最常同時開出。
        periods=None 表示使用全部歷史資料。
        """
        if periods is None:
            periods = len(self.df)
        elif len(self.df) < periods:
            periods = len(self.df)
        recent_df = self.df.tail(periods)

        trip_counter: Counter = Counter()
        for nums in recent_df["numbers"]:
            for combo in combinations(sorted(nums), 3):
                trip_counter[combo] += 1

        return {
            "period_count": periods,
            "top_triplets": [(list(k), v) for k, v in trip_counter.most_common(top_k)],
        }

    def get_odd_even_stats(self, periods: int | None = None) -> Dict[str, Any]:
        """
        奇偶統計：每期平均奇/偶顆數，以及累計奇:偶比。
        periods=None 表示使用全部歷史資料。
        """
        if periods is None:
            periods = len(self.df)
        elif len(self.df) < periods:
            periods = len(self.df)
        recent_df = self.df.tail(periods)
        odd_total = 0
        even_total = 0
        for nums in recent_df["numbers"]:
            for n in nums:
                if n % 2 != 0:
                    odd_total += 1
                else:
                    even_total += 1
        draw_count = len(recent_df)
        return {
            "period_count": periods,
            "avg_odd_per_draw": odd_total / draw_count,
            "avg_even_per_draw": even_total / draw_count,
            "aggregate_odd_even_ratio": f"{odd_total}:{even_total}",
        }

    def generate_full_report(self) -> str:
        """
        產出供 LLM 推理的 Context 字串
        """
        try:
            missing = self.get_missing_values()
            sum_stats_all = self.get_sum_stats(None)
            oe_stats_all = self.get_odd_even_stats(None)
            all_time = self.get_all_time_stats()
            dist = self.get_distribution_features()

            # 冷門池：先取遺漏 >= 30 期的嚴格冷門，若不足 MIN_POOL_SIZE 顆，依遺漏期數補齊
            MIN_POOL_SIZE = 5
            strict_cold = {k: v for k, v in missing.items() if v >= 30}
            if len(strict_cold) < MIN_POOL_SIZE:
                sorted_missing = sorted(missing.items(), key=lambda x: x[1], reverse=True)
                cold_pool = dict(sorted_missing[:MIN_POOL_SIZE])
                pool_note = f"（嚴格冷門池僅 {len(strict_cold)} 顆，已擴充為遺漏 Top {MIN_POOL_SIZE}）"
            else:
                cold_pool = strict_cold
                pool_note = ""
            # 統計趨勢策略熱門池：
            #   大樂透(49)：近 100 期（約一年）≥ 15 次
            #   今彩539   ：近 300 期（約一年）≥ 40 次
            if self.max_number == 49:
                trend_periods, trend_min_freq = 100, 15
                recent_periods = 100   # 近期報告用的期數
            else:
                trend_periods, trend_min_freq = 300, 40
                recent_periods = 300   # 近期報告用的期數

            hot_cold_recent = self.get_hot_cold_stats(recent_periods)
            sum_stats_recent = self.get_sum_stats(recent_periods)
            oe_stats_recent = self.get_odd_even_stats(recent_periods)

            hot_cold_trend = self.get_hot_cold_stats(trend_periods)
            trend_hot_pool = {
                n: c for n, c in hot_cold_trend["frequencies"].items() if c >= trend_min_freq
            }
            # 近 recent_periods 期熱門前 10（含次數）
            top_recent = sorted(hot_cold_recent["frequencies"].items(), key=lambda x: x[1], reverse=True)[:10]

            report = f"📊 統計分析報告 (基於 2007 至今共 {all_time['total_draws']} 期累計數據)\n"
            report += f"史上最熱門前 10 (號碼,次數): {all_time['top_all_time']}\n"
            report += f"史上最冷門前 10 (號碼,次數): {all_time['bottom_all_time']}\n"
            report += f"理論平均出現次數: {all_time['average_frequency']:.2f}\n\n"
            report += (
                f"【全歷史和值】共 {sum_stats_all['period_count']} 期: "
                f"平均={sum_stats_all['average']:.1f}, "
                f"範圍 {sum_stats_all['min']}~{sum_stats_all['max']}, "
                f"±10% 區間=[{sum_stats_all['band_minus_10pct']:.1f}, {sum_stats_all['band_plus_10pct']:.1f}], "
                f"±20% 區間=[{sum_stats_all['band_minus_20pct']:.1f}, {sum_stats_all['band_plus_20pct']:.1f}]\n"
            )
            report += (
                f"【全歷史奇偶比】每期平均: 奇={oe_stats_all['avg_odd_per_draw']:.2f}, "
                f"偶={oe_stats_all['avg_even_per_draw']:.2f}; "
                f"累計開出顆數比 奇:偶={oe_stats_all['aggregate_odd_even_ratio']}\n\n"
            )
            report += f"近 {recent_periods} 期熱門前 10 (號碼,次數): {top_recent}\n"
            report += (
                f"近 {recent_periods} 期和值: 平均={sum_stats_recent['average']:.1f}, "
                f"範圍 {sum_stats_recent['min']}~{sum_stats_recent['max']}, "
                f"±10% 區間=[{sum_stats_recent['band_minus_10pct']:.1f}, {sum_stats_recent['band_plus_10pct']:.1f}], "
                f"±20% 區間=[{sum_stats_recent['band_minus_20pct']:.1f}, {sum_stats_recent['band_plus_20pct']:.1f}]\n"
            )
            report += (
                f"近 {recent_periods} 期平均奇偶比 (每期): 奇={oe_stats_recent['avg_odd_per_draw']:.2f}, "
                f"偶={oe_stats_recent['avg_even_per_draw']:.2f}\n\n"
            )
            report += f"冷門池 (號碼:遺漏期數){pool_note}: {cold_pool}\n"
            # 即將開出指數 = 目前遺漏 ÷ 該號平均間隔（>1 代表超過自身週期，相對 overdue）
            overdue = self.get_overdue_index()
            top_overdue = sorted(overdue.items(), key=lambda x: x[1], reverse=True)[:8]
            report += (
                f"【即將開出指數】目前遺漏÷平均間隔 Top8 (號碼:指數): "
                f"{[(n, round(v, 2)) for n, v in top_overdue]}\n"
            )
            report += (
                f"【統計趨勢熱門池】近 {trend_periods} 期出現 >= {trend_min_freq} 次 "
                f"(號碼:次數): {trend_hot_pool}\n\n"
            )
            report += (
                f"上一期 ({dist['latest_draw_id']}) 奇偶比: {dist['odd_even_ratio']}, "
                f"大小比: {dist['large_small_ratio']}\n\n"
            )

            # 號碼對 / 三聯共現頻率（捕捉號碼間的連帶結構）
            pairs = self.get_pair_frequencies(recent_periods, top_k=10)
            triplets = self.get_triplet_frequencies(recent_periods, top_k=8)
            report += (
                f"近 {recent_periods} 期【最常同開號碼對】Top10 (號碼對,次數): "
                f"{pairs['top_pairs']}\n"
            )
            report += (
                f"近 {recent_periods} 期【最常同開三聯】Top8 (三號,次數): "
                f"{triplets['top_triplets']}\n"
            )

            return report

        except Exception as e:
            logging.error(f"產出統計報告失敗: {e}")
            raise

if __name__ == "__main__":
    # 測試
    import sys
    sys.stdout.reconfigure(encoding='utf-8')
    try:
        engine = StatsEngine("data/lotto649.json", 49)
        print("【大樂透 649 分析結果】")
        print(engine.generate_full_report())
        
        print("\n" + "="*30 + "\n")
        
        engine_539 = StatsEngine("data/daily539.json", 39)
        print("【今彩 539 分析結果】")
        print(engine_539.generate_full_report())
    except FileNotFoundError:
        print("找不到資料檔，請確認是否已執行 Task 1.3 建檔。")
