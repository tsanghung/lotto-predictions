import pandas as pd
import json
from typing import Dict, List, Any
import logging

logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')

class StatsEngine:
    def __init__(self, data_file: str, max_number: int):
        self.data_file = data_file
        self.max_number = max_number # 大樂透為 49, 539 為 39
        self.df = self._load_data()

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

    def get_sum_stats(self, periods: int) -> Dict[str, Any]:
        """
        近 N 期開獎號碼總和的統計：平均、最小、最大、區間
        """
        if len(self.df) < periods:
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

    def get_odd_even_stats(self, periods: int) -> Dict[str, Any]:
        """
        近 N 期每期平均奇偶顆數
        """
        if len(self.df) < periods:
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
        return {
            "period_count": periods,
            "avg_odd_per_draw": odd_total / len(recent_df),
            "avg_even_per_draw": even_total / len(recent_df),
        }

    def generate_full_report(self) -> str:
        """
        產出供 LLM 推理的 Context 字串
        """
        try:
            missing = self.get_missing_values()
            hot_cold_10 = self.get_hot_cold_stats(10)
            hot_cold_100 = self.get_hot_cold_stats(100)
            sum_stats_100 = self.get_sum_stats(100)
            oe_stats_100 = self.get_odd_even_stats(100)
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
            # 近 10 期出現 >= 2 次的熱門池
            hot_pool_10_freq2 = {n: c for n, c in hot_cold_10["frequencies"].items() if c >= 2}
            # 近 100 期熱門前 10（含次數）
            top_100 = sorted(hot_cold_100["frequencies"].items(), key=lambda x: x[1], reverse=True)[:10]

            report = f"📊 統計分析報告 (基於 2007 至今共 {all_time['total_draws']} 期累計數據)\n"
            report += f"史上最熱門前 10 (號碼,次數): {all_time['top_all_time']}\n"
            report += f"史上最冷門前 10 (號碼,次數): {all_time['bottom_all_time']}\n"
            report += f"理論平均出現次數: {all_time['average_frequency']:.2f}\n\n"
            report += f"近 100 期熱門前 10 (號碼,次數): {top_100}\n"
            report += (
                f"近 100 期和值: 平均={sum_stats_100['average']:.1f}, "
                f"範圍 {sum_stats_100['min']}~{sum_stats_100['max']}, "
                f"±10% 區間=[{sum_stats_100['band_minus_10pct']:.1f}, {sum_stats_100['band_plus_10pct']:.1f}], "
                f"±20% 區間=[{sum_stats_100['band_minus_20pct']:.1f}, {sum_stats_100['band_plus_20pct']:.1f}]\n"
            )
            report += (
                f"近 100 期平均奇偶比 (每期): 奇={oe_stats_100['avg_odd_per_draw']:.2f}, "
                f"偶={oe_stats_100['avg_even_per_draw']:.2f}\n\n"
            )
            report += f"冷門池 (號碼:遺漏期數){pool_note}: {cold_pool}\n"
            report += f"近 10 期出現 >= 2 次的熱門池 (號碼:次數): {hot_pool_10_freq2}\n\n"
            report += (
                f"上一期 ({dist['latest_draw_id']}) 奇偶比: {dist['odd_even_ratio']}, "
                f"大小比: {dist['large_small_ratio']}\n"
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
