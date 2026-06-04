import os
import json
import re
import time
import logging
from datetime import datetime
from dotenv import load_dotenv
from google import genai
from google.genai import types

from .stats_engine import StatsEngine
from .strategy_sampler import StrategySampler, StrategyProfile
from .web_search import WebSearcher
from .gemini_config import get_prediction_model, is_api_key_configured, is_gemma_model

logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')

class AIPredictor:
    def __init__(self, game_name: str, data_file: str, max_number: int, num_picks: int):
        self.game_name = game_name
        self.num_picks = num_picks # 大樂透為 6 碼，今彩 539 為 5 碼
        
        load_dotenv()
        self.api_key = os.getenv("GEMINI_API_KEY")
        self.model = get_prediction_model()
        if is_api_key_configured():
            self.client = genai.Client(api_key=self.api_key)
        else:
            self.client = None
            logging.warning("未設定 GEMINI_API_KEY，將啟用離線模擬預測模式。")
            
        self.stats_engine = StatsEngine(data_file, max_number)
        self.web_searcher = WebSearcher()

    def _generate_mock_prediction(self, stats_context: str, reason: str = "未提供有效的 Gemini API Key") -> dict:
        """
        當沒有 API Key 或呼叫失敗時的離線備援方案 (Fallback)。
        回傳結果帶有 is_offline=True 旗標，供上層決定是否跳過推播。
        """
        logging.info("執行離線模擬預測...")
        import random
        nums = list(range(1, self.stats_engine.max_number + 1))
        recent_periods = 100 if self.stats_engine.max_number == 49 else 300

        combinations = {
            "激進包牌": sorted(random.sample(nums, self.num_picks)),
            "穩健平衡": sorted(random.sample(nums, self.num_picks)),
            "統計趨勢": sorted(random.sample(nums, self.num_picks))
        }
        return {
            "is_offline": True,           # ← 離線旗標，上層用來判斷是否推播
            "offline_reason": reason,
            "reasoning": f"此為離線模擬預測。原因：{reason}",
            "risk_warning": "這只是隨機亂數，沒有任何 AI 推理。",
            "combinations": combinations,
            # 即便是離線亂數，仍附上各號碼的客觀統計理由（標示為統計事實，非 AI 推理）
            "number_insights": self._build_number_insights(combinations, recent_periods),
        }

    def _build_number_insights(self, combinations: dict, recent_periods: int) -> dict:
        """
        為每個被選中的號碼產生資料驅動的『選號理由』。
        依該號最突出的統計特徵分類：久未開出(overdue) / 近期熱門(hot) /
        剛開出(fresh) / 週期均衡(balanced)，並引用具體天數與次數。
        """
        try:
            profiles = self.stats_engine.get_number_profiles(recent_periods)
        except Exception as e:
            logging.warning(f"產生選號理由失敗：{e}")
            return {}

        picked = sorted({int(n) for nums in combinations.values() for n in nums})
        # 近 N 期單號理論平均出現次數，作為「熱門」門檻基準
        avg_recent = recent_periods * self.num_picks / self.stats_engine.max_number

        insights = {}
        for n in picked:
            p = profiles.get(n)
            if not p:
                continue
            gap_days = p["gap_days"]
            gap_draws = p["gap_draws"]
            avg_days = p["avg_interval_days"]
            idx = p["overdue_index"]
            rf = p["recent_freq"]
            app = p["appearances"]
            avg_days_txt = f"{avg_days:.0f} 天" if avg_days else f"{p['avg_interval_draws']:.0f} 期"

            if idx >= 1.5 and gap_days is not None:
                tag = "overdue"
                reason = (
                    f"久未開出：已隔 {gap_days} 天（{gap_draws} 期未開），"
                    f"約為自身平均週期 {avg_days_txt}的 {idx:.1f} 倍，醞釀反彈"
                )
            elif rf >= avg_recent * 1.3:
                tag = "hot"
                reason = (
                    f"近期熱門：近 {recent_periods} 期開出 {rf} 次"
                    f"（高於平均約 {avg_recent:.0f} 次），史上累計 {app} 次，氣勢正盛"
                )
            elif gap_draws <= 1:
                tag = "fresh"
                if gap_days is None or gap_days == 0:
                    reason = "剛開出：上一期才剛開出，短期氣勢延續"
                else:
                    reason = f"剛開出：{gap_days} 天前才開出，短期氣勢延續"
            else:
                tag = "balanced"
                base = f"週期均衡：已隔 {gap_days} 天" if gap_days is not None else f"已隔 {gap_draws} 期"
                if avg_days:
                    base += f"，貼近平均 {avg_days:.0f} 天"
                reason = base + f"，近 {recent_periods} 期開出 {rf} 次，結構穩定"

            insights[str(n)] = {
                "reason": reason,
                "tag": tag,
                "gap_days": gap_days,
                "gap_draws": gap_draws,
                "avg_interval_days": avg_days,
                "overdue_index": idx,
                "recent_freq": rf,
            }
        return insights

    def _sample_from_profiles(self, llm_strategies: dict, recent_periods: int) -> dict:
        """
        將 LLM 提供的『決策方向』轉為實際號碼。
        和值區間、min_from_pool 等數值約束由 Python 端依統計決定，不依賴 LLM。
        """
        import random as _random

        sampler = StrategySampler(self.stats_engine, self.num_picks, recent_periods)
        sum_stats = self.stats_engine.get_sum_stats(None)
        oe = self.stats_engine.get_odd_even_stats(None)
        band10 = (sum_stats["band_minus_10pct"], sum_stats["band_plus_10pct"])
        band20 = (sum_stats["band_minus_20pct"], sum_stats["band_plus_20pct"])
        target_odd = round(oe["avg_odd_per_draw"])

        # 各策略的 Python 端參數（和值區間、奇偶目標、冷熱門池）
        defaults = {
            "激進包牌": dict(bias="cold", sum_band=band20),
            "穩健平衡": dict(bias="balanced", sum_band=band10, target_odd=target_odd),
            "統計趨勢": dict(bias="hot", sum_band=band10),
        }
        rng = _random.Random()
        combinations = {}
        for name, cfg in defaults.items():
            spec = llm_strategies.get(name, {}) if isinstance(llm_strategies, dict) else {}
            prefer = [int(n) for n in spec.get("prefer", []) if isinstance(n, (int, float))]
            avoid = [int(n) for n in spec.get("avoid", []) if isinstance(n, (int, float))]
            profile = StrategyProfile(
                name=name,
                bias=cfg["bias"],
                sum_band=cfg.get("sum_band"),
                target_odd=cfg.get("target_odd"),
                prefer=prefer,
                avoid=avoid,
                min_from_pool=3 if prefer else 0,
                pool=prefer,
            )
            combinations[name] = sampler.sample(profile, rng)
        return combinations

    def generate_prediction(self) -> dict:
        """
        獲取統計特徵與輿情，然後交給 LLM 推理
        """
        logging.info(f"開始 {self.game_name} 的 AI 預測流程...")
        
        # 1. 取得 Context
        stats_context = self.stats_engine.generate_full_report()
        news_context = self.web_searcher.get_lottery_news_context(self.game_name)
        
        full_context = f"{stats_context}\n{news_context}"
        
        if not self.client:
            return self._generate_mock_prediction(full_context)

        # 近期基準期數：大樂透近 100 期、今彩539 近 300 期
        recent_periods = 100 if self.stats_engine.max_number == 49 else 300

        # 2. 定義 System Prompt 與 User Prompt
        #    重要變更：LLM 只負責「決策方向」，實際選號由 Python 端 StrategySampler 完成，
        #    徹底消除 LLM 算術錯誤（和值/奇偶/連號）導致的無效組合。
        system_instruction = (
            "你是一位『頂級博弈精算師』，精通機率論、統計學與大數據分析。"
            "請基於提供的『自 2007 年至今超過 10 年』的歷史累計數據與最新網路輿情，進行深度推估。"
            "你的任務不是直接報出號碼，而是為每種策略決定『選號方向』"
            "（偏熱門/偏冷門/平衡、想要的奇偶結構、特別看好或想避開的號碼）。"
            "實際選號將由系統依你的方向自動完成並驗證所有硬性約束。"
            "分析結果必須嚴格遵守 JSON 格式回傳，不可包含任何額外字串或 Markdown 標記。"
        )

        prompt = (
            f"任務：為【{self.game_name}】（從 1 到 {self.stats_engine.max_number} 選 {self.num_picks} 個）"
            "決定三種策略的『選號方向』。\n\n"
            "== 三種策略的定位 ==\n"
            "- 激進包牌：偏好冷門/久未開出的號碼，搏冷門反彈（bias=cold）\n"
            "- 穩健平衡：奇偶與冷熱兼顧，追求穩定結構（bias=balanced）\n"
            "- 統計趨勢：偏好近期熱門號碼，順勢操作（bias=hot）\n\n"
            "== 你要為每種策略提供 ==\n"
            "- bias: 固定為上述對應值（cold / balanced / hot）\n"
            f"- prefer: 1~6 個你特別看好的號碼（須在 1~{self.stats_engine.max_number}），並在 reasoning 引用其統計依據\n"
            "- avoid: 0~4 個你建議避開的號碼（可留空陣列）\n"
            "（和值區間、不重複、非全奇全偶、無連號等硬性約束由系統自動處理，你無需計算）\n\n"
            "== 推理要求（寫在 reasoning，須引用背景資料的具體數字）==\n"
            f"列出近 {recent_periods} 期最熱與最冷的號碼及其次數/遺漏期數，"
            "並說明各策略 prefer 號碼的挑選理由。\n\n"
            f"== 背景資料 ==\n{full_context}\n\n"
            "== 輸出格式（嚴格 JSON，不可有 Markdown）==\n"
            "{\n"
            '  "reasoning": "依背景資料的具體數字說明三種策略的選號方向與理由",\n'
            '  "risk_warning": "一句風險提示",\n'
            '  "strategies": {\n'
            '    "激進包牌": {"bias": "cold", "prefer": [數字...], "avoid": [數字...]},\n'
            '    "穩健平衡": {"bias": "balanced", "prefer": [數字...], "avoid": [數字...]},\n'
            '    "統計趨勢": {"bias": "hot", "prefer": [數字...], "avoid": [數字...]}\n'
            "  }\n"
            "}"
        )

        if is_gemma_model(self.model):
            # Gemma 不支援 system_instruction / JSON mode，角色設定併入主 prompt
            contents = f"{system_instruction}\n\n{prompt}"
            config = types.GenerateContentConfig(temperature=0.5)
        else:
            contents = prompt
            config = types.GenerateContentConfig(
                system_instruction=system_instruction,
                temperature=0.5,
                response_mime_type="application/json",
            )

        MAX_RETRIES = 3
        last_error = None

        for attempt in range(1, MAX_RETRIES + 1):
            try:
                logging.info(f"正在呼叫 {self.model} 進行推理（第 {attempt}/{MAX_RETRIES} 次）...")

                response = self.client.models.generate_content(
                    model=self.model,
                    contents=contents,
                    config=config,
                )

                raw_text = response.text.strip()
                try:
                    result = json.loads(raw_text)
                except json.JSONDecodeError:
                    json_match = re.search(r'(\{.*\})', raw_text, re.DOTALL)
                    clean_text = json_match.group(1) if json_match else raw_text
                    clean_text = re.sub(r'\\(?!["\\/bfnrtu])', '', clean_text)
                    result = json.loads(clean_text)

                # 驗證結構：新版要求 strategies（決策方向）
                if "strategies" not in result or "reasoning" not in result:
                    raise ValueError("LLM 回傳的 JSON 缺少必要的欄位（strategies / reasoning）。")

                # 由 Python 端依 LLM 決策方向確定性選號，保證滿足所有硬性約束
                combinations = self._sample_from_profiles(result["strategies"], recent_periods)
                result["combinations"] = combinations
                # 為每個選中號碼附上資料驅動的選號理由
                result["number_insights"] = self._build_number_insights(combinations, recent_periods)

                logging.info(f"{self.model} 推理完成，號碼由採樣器確定性產生！")
                return result

            except Exception as e:
                last_error = e
                # 500 / 503 / 429 都值得重試；其他錯誤也重試，最多 MAX_RETRIES 次
                if attempt < MAX_RETRIES:
                    wait_sec = 2 ** (attempt - 1)  # 1s → 2s → 4s 指數退避
                    logging.warning(
                        f"第 {attempt} 次呼叫失敗（{e}），{wait_sec}s 後重試..."
                    )
                    time.sleep(wait_sec)
                else:
                    logging.error(f"已重試 {MAX_RETRIES} 次，全部失敗。最後錯誤：{e}")

        logging.warning("啟動容錯機制，使用模擬預測。")
        return self._generate_mock_prediction(
            full_context, reason=f"API 發生錯誤（重試 {MAX_RETRIES} 次仍失敗）: {last_error}"
        )

def save_predictions(
    game_name: str,
    prediction: dict,
    file_path: str = "data/predictions.json",
    archive_path: str = "data/predictions_archive.json",
    recent_limit: int = 50,
):
    """
    將預測結果同時寫入：
    - predictions.json        ← 最近 recent_limit 筆，供前端展示
    - predictions_archive.json ← 完整歷史，供長期績效分析（不截斷）

    離線模擬預測（is_offline=True）同樣儲存，但標記清楚。
    """
    record = {
        "timestamp": datetime.now().isoformat(),
        "game_name": game_name,
        "is_offline": prediction.get("is_offline", False),
        "prediction": prediction,
        "is_evaluated": False,
        "evaluation": {
            "draw_id": None,
            "actual_numbers": [],
            "strategies": {},
            "attribution_report": None
        }
    }

    # ── 1. 寫入近期快取（predictions.json，保留最近 N 筆）──
    recent = []
    if os.path.exists(file_path):
        with open(file_path, 'r', encoding='utf-8') as f:
            try:
                recent = json.load(f)
            except json.JSONDecodeError:
                pass
    recent.append(record)
    if len(recent) > recent_limit:
        recent = recent[-recent_limit:]
    with open(file_path, 'w', encoding='utf-8') as f:
        json.dump(recent, f, ensure_ascii=False, indent=2)
    logging.info(f"預測結果已儲存至 {file_path}（保留最近 {recent_limit} 筆）")

    # ── 2. 寫入完整歸檔（predictions_archive.json，永不截斷）──
    archive = []
    if os.path.exists(archive_path):
        with open(archive_path, 'r', encoding='utf-8') as f:
            try:
                archive = json.load(f)
            except json.JSONDecodeError:
                pass
    archive.append(record)
    with open(archive_path, 'w', encoding='utf-8') as f:
        json.dump(archive, f, ensure_ascii=False, indent=2)
    logging.info(f"預測結果已歸檔至 {archive_path}（共 {len(archive)} 筆）")

if __name__ == "__main__":
    # 測試大樂透 AI 預測
    predictor = AIPredictor(
        game_name="大樂透",
        data_file="data/lotto649.json",
        max_number=49,
        num_picks=6
    )
    result = predictor.generate_prediction()
    
    import sys
    sys.stdout.reconfigure(encoding='utf-8')
    print(json.dumps(result, ensure_ascii=False, indent=2))
    
    # 儲存測試
    save_predictions("大樂透", result)
