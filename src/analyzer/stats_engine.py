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
        # 依照期數排序（由舊到新）
        df = df.sort_values("draw_id").reset_index(drop=True)
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

    def generate_full_report(self) -> str:
        """
        產出供 LLM 推理的 Context 字串
        """
        try:
            missing = self.get_missing_values()
            hot_cold_10 = self.get_hot_cold_stats(10)
            hot_cold_30 = self.get_hot_cold_stats(30)
            dist = self.get_distribution_features()
            
            # 挑出極端遺漏值 (超過 20 期未開)
            extreme_missing = {k: v for k, v in missing.items() if v >= 20}
            
            report = f"📊 統計分析報告 (基於最新期數 {dist['latest_draw_id']})\n"
            report += f"近 10 期熱門號碼: {hot_cold_10['hot']}\n"
            report += f"近 10 期冷門號碼: {hot_cold_10['cold']}\n"
            report += f"近 30 期熱門號碼: {hot_cold_30['hot']}\n"
            report += f"極端冷門 (遺漏 >= 20期) 號碼及期數: {extreme_missing}\n"
            report += f"上一期奇偶比: {dist['odd_even_ratio']}\n"
            report += f"上一期大小比: {dist['large_small_ratio']}\n"
            report += f"上一期同尾數特徵: {dist['same_tails_last_draw']}\n"
            
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
