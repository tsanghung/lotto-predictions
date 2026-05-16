import os
import json
import random
import logging
from datetime import datetime

from .scientific_attribution import AttributionAnalyzer

logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')

# ── 歸因閾值設定（按遊戲分開）──────────────────────────────────────────────
# 命中數「低於」此值時，視為表現不佳，強制觸發歸因
ATTRIBUTION_THRESHOLD = {
    "大樂透": 3,   # 選 6 個，命中 < 3 (< 50%) 才歸因
    "今彩539": 3,  # 選 5 個，命中 < 3 (< 60%) 才歸因
}
# 命中數「達到或超過」閾值時，仍有此機率隨機觸發歸因（分析成功案例）
SUCCESS_ATTRIBUTION_RATE = 0.2  # 20% 機率

class Evaluator:
    def __init__(self, predictions_file="data/predictions.json", data_dir="data"):
        self.predictions_file = predictions_file
        self.data_dir = data_dir
        
        # 由於需要上下文，我們初始化時順便備好分析器
        # 注意: max_number 這邊先預設，實際執行時會根據 game_name 決定是否需重新宣告，
        # 但為了簡化，可以每次遇到需要歸因時再建立或封裝在方法內。

    def _load_json(self, file_path):
        if not os.path.exists(file_path):
            return []
        with open(file_path, 'r', encoding='utf-8') as f:
            try:
                return json.load(f)
            except json.JSONDecodeError:
                return []

    def _save_json(self, file_path, data):
        with open(file_path, 'w', encoding='utf-8') as f:
            json.dump(data, f, ensure_ascii=False, indent=2)

    def _find_target_draw(self, game_name, pred_timestamp_str):
        """
        尋找對應的實際開獎期數。
        預測通常是在開獎當天中午產生，所以尋找開獎日期大於等於預測日期的最近一期。
        """
        history_file = os.path.join(self.data_dir, "lotto649.json" if game_name == "大樂透" else "daily539.json")
        history = self._load_json(history_file)
        if not history:
            return None
            
        pred_date = datetime.fromisoformat(pred_timestamp_str).date()
        
        # history 假設依日期由舊到新排序
        for draw in history:
            draw_date_str = draw.get("date")
            if not draw_date_str:
                continue
            draw_date = datetime.strptime(draw_date_str, "%Y-%m-%d").date()
            # 如果開獎日期在預測日期當天或之後
            if draw_date >= pred_date:
                return draw
                
        return None

    def evaluate_all(self):
        logging.info("開始執行自動對獎邏輯...")
        predictions = self._load_json(self.predictions_file)
        if not predictions:
            logging.info("沒有找到預測紀錄。")
            return False

        updated = False
        for record in predictions:
            if record.get("is_evaluated"):
                continue

            game_name = record.get("game_name")
            pred_time = record.get("timestamp")
            
            # 找尋對應開獎
            target_draw = self._find_target_draw(game_name, pred_time)
            if not target_draw:
                logging.info(f"預測 [{pred_time}] {game_name} 尚未有對應開獎資料，跳過。")
                continue

            actual_numbers = target_draw.get("numbers", [])
            draw_id = target_draw.get("draw_id")
            
            logging.info(f"正在對獎: [{pred_time}] {game_name} 對應期數: {draw_id}")
            
            evaluation = {
                "draw_id": draw_id,
                "actual_numbers": actual_numbers,
                "strategies": {},
                "attribution_report": None
            }
            
            # 計算各策略的命中情況
            actual_set = set(actual_numbers)
            combinations = record.get("prediction", {}).get("combinations", {})
            for strategy_name, predicted_nums in combinations.items():
                pred_set = set(predicted_nums)
                matches = list(pred_set.intersection(actual_set))
                misses = list(pred_set.difference(actual_set))
                
                evaluation["strategies"][strategy_name] = {
                    "hits": len(matches),
                    "matches": sorted(matches),
                    "miss_count": len(misses),
                    "missed_numbers": sorted(misses)
                }
            # ── 決定是否觸發科學歸因 ──────────────────────────────────────────
            max_hits = max((s["hits"] for s in evaluation["strategies"].values()), default=0)
            threshold = ATTRIBUTION_THRESHOLD.get(game_name, 3)
            num_picks = len(next(iter(combinations.values()), []))

            need_attribution = False
            attribution_trigger = ""

            if max_hits < threshold:
                # 表現不佳：強制歸因
                need_attribution = True
                hit_rate = f"{max_hits}/{num_picks}"
                attribution_trigger = f"表現不佳（最高命中 {hit_rate}，低於閾值 {threshold}）"
            elif random.random() < SUCCESS_ATTRIBUTION_RATE:
                # 表現良好：20% 機率隨機歸因，分析成功案例
                need_attribution = True
                attribution_trigger = f"成功案例隨機抽樣歸因（最高命中 {max_hits}/{num_picks}）"

            if need_attribution:
                logging.info(f"啟動科學歸因 AI — {attribution_trigger}")
                max_number = 49 if game_name == "大樂透" else 39
                history_file = os.path.join(
                    self.data_dir,
                    "lotto649.json" if game_name == "大樂透" else "daily539.json"
                )
                analyzer = AttributionAnalyzer(history_file, max_number)
                report = analyzer.generate_attribution_report(
                    game_name=game_name,
                    draw_id=draw_id,
                    predicted_combinations=combinations,
                    actual_numbers=actual_numbers
                )
                evaluation["attribution_report"] = report
                evaluation["attribution_trigger"] = attribution_trigger
            else:
                evaluation["attribution_report"] = (
                    f"命中表現良好（最高命中 {max_hits}/{num_picks}），本次跳過歸因分析。"
                )
                evaluation["attribution_trigger"] = "跳過"
                
            record["is_evaluated"] = True
            record["evaluation"] = evaluation
            updated = True
            logging.info(f"[{game_name}] 第 {draw_id} 期對獎完成！")

        if updated:
            self._save_json(self.predictions_file, predictions)
            logging.info("預測紀錄已更新對獎結果。")
            self._generate_performance_snapshot(predictions)
        else:
            logging.info("所有紀錄皆已對獎完成，無需更新。")
            
        return updated

    def _generate_performance_snapshot(self, predictions):
        """
        計算歷史對獎的累計中獎率與趨勢，並寫入 performance.json
        """
        logging.info("正在計算成效統計快照...")
        performance = {
            "last_updated": datetime.now().isoformat(),
            "games": {}
        }
        
        # 只取已完成對獎的紀錄
        evaluated = [p for p in predictions if p.get("is_evaluated")]
        
        for record in evaluated:
            game_name = record.get("game_name")
            if game_name not in performance["games"]:
                performance["games"][game_name] = {
                    "total_draws_evaluated": 0,
                    "strategies": {},
                    "trend": []
                }
                
            game_perf = performance["games"][game_name]
            game_perf["total_draws_evaluated"] += 1
            
            draw_id = record["evaluation"]["draw_id"]
            draw_date = record["timestamp"][:10]  # YYYY-MM-DD
            
            trend_data = {
                "date": draw_date,
                "draw_id": draw_id,
                "strategies": {}
            }
            
            for strategy, stats in record["evaluation"].get("strategies", {}).items():
                if strategy not in game_perf["strategies"]:
                    game_perf["strategies"][strategy] = {
                        "total_hits": 0,
                        "total_misses": 0
                    }
                    
                hits = stats.get("hits", 0)
                misses = stats.get("miss_count", 0)
                
                game_perf["strategies"][strategy]["total_hits"] += hits
                game_perf["strategies"][strategy]["total_misses"] += misses
                
                trend_data["strategies"][strategy] = hits
                
            game_perf["trend"].append(trend_data)
            
        # 計算最終的 win_rate
        for game_name, game_perf in performance["games"].items():
            for strategy, stats in game_perf["strategies"].items():
                total = stats["total_hits"] + stats["total_misses"]
                stats["win_rate"] = round(stats["total_hits"] / total, 4) if total > 0 else 0
                
        perf_file = os.path.join(self.data_dir, "performance.json")
        self._save_json(perf_file, performance)
        logging.info("成效統計快照已儲存至 performance.json")

if __name__ == "__main__":
    evaluator = Evaluator()
    evaluator.evaluate_all()
