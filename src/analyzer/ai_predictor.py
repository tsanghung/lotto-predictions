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

        return {
            "is_offline": True,           # ← 離線旗標，上層用來判斷是否推播
            "offline_reason": reason,
            "reasoning": f"此為離線模擬預測。原因：{reason}",
            "risk_warning": "這只是隨機亂數，沒有任何 AI 推理。",
            "combinations": {
                "激進包牌": sorted(random.sample(nums, self.num_picks)),
                "穩健平衡": sorted(random.sample(nums, self.num_picks)),
                "統計趨勢": sorted(random.sample(nums, self.num_picks))
            }
        }

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

        if self.stats_engine.max_number == 49:
            # 大樂透：近 100 期（約一年）為基準
            recent_periods = 100
            trend_strategy_rule = (
                "- 統計趨勢：至少 3 個號碼來自【近 100 期出現 15 次以上】的熱門池\n"
            )
            reasoning_example = (
                '  "reasoning": "依 Step1-4 推理，須引用具體數字，'
                "例如『全歷史和值平均 X、奇偶比 Y；號碼 7 在近 100 期出現 Z 次』\",\n"
            )
        else:
            # 今彩539：近 300 期（約一年）為基準
            recent_periods = 300
            trend_strategy_rule = (
                "- 統計趨勢：至少 3 個號碼來自【近 300 期出現 40 次以上】的熱門池\n"
            )
            reasoning_example = (
                '  "reasoning": "依 Step1-4 推理，須引用具體數字，'
                "例如『全歷史和值平均 X、奇偶比 Y；號碼 7 在近 300 期出現 Z 次』\",\n"
            )
            
        # 2. 定義 System Prompt 與 User Prompt
        system_instruction = (
            "你是一位『頂級博弈精算師』，精通機率論、統計學與大數據分析。"
            "請基於提供的『自 2007 年至今超過 10 年』的歷史累計數據與最新網路輿情，進行深度推估。"
            "你必須綜合考量長期的規律性與短期的熱冷門趨勢，提供具備科學依據的預測。"
            "分析結果必須嚴格遵守 JSON 格式回傳，不可包含任何額外字串或 Markdown 標記。"
        )
        
        prompt = (
            f"任務：為【{self.game_name}】預測下一期號碼（從 1 到 {self.stats_engine.max_number} 選 {self.num_picks} 個）\n\n"
            "== 必須遵守的硬性約束（違反任何一條視為無效，必須重新選號）==\n"
            f"1. 每個號碼必須在 1 到 {self.stats_engine.max_number} 之間，不可重複\n"
            f"2. 每組必須剛好 {self.num_picks} 個號碼\n"
            "3. 禁止全奇或全偶；禁止 4 個以上連續整數\n"
            "4. 三種策略之間，重複號碼不得超過 2 個（確保差異化）\n"
            "5. 禁止與近 3 期開獎號碼完全相同\n"
            "6. 【激進包牌】和值必須落在全歷史平均的 ±20% 區間內（背景資料已提供區間）\n"
            "7. 【穩健平衡】和值必須落在全歷史平均的 ±10% 區間內（背景資料已提供區間）\n"
            "8. 【統計趨勢】和值必須落在全歷史平均的 ±10% 區間內（背景資料已提供區間）\n\n"
            "== 推理步驟（請依序在 reasoning 欄說明）==\n"
            f"Step 1: 從統計資料中，列出近 {recent_periods} 期【最熱】3 個號碼與【最冷】3 個號碼（須引用實際出現次數或隔期數）\n"
            "Step 2: 從背景資料讀取全歷史【和值平均】與【奇偶比】，以及 ±10%/±20% 區間數值\n"
            "Step 3: 根據三種策略的定義（見下方），各別選號，並計算每組和值確認落在規定區間\n"
            "Step 4: 自我檢查：每組是否符合所有硬性約束？和值是否在規定區間？是否與近 3 期開獎號完全相同？\n\n"
            "== 三種策略的明確定義 ==\n"
            "- 激進包牌：至少 3 個號碼來自背景資料中的【冷門池】；和值必須在全歷史平均 ±20% 區間內\n"
            "- 穩健平衡：奇偶比接近全歷史每期平均或 3:3/3:2；和值落在全歷史平均 ±10% 區間內；冷熱門各半\n"
            f"{trend_strategy_rule}\n"
            f"== 背景資料 ==\n{full_context}\n\n"
            "== 輸出格式（嚴格 JSON，不可有 Markdown）==\n"
            "{\n"
            f"{reasoning_example}"
            '  "risk_warning": "一句風險提示",\n'
            '  "self_check": {\n'
            '    "和值": [激進和值, 穩健和值, 趨勢和值],\n'
            '    "奇偶比": ["激進X:Y", "穩健X:Y", "趨勢X:Y"],\n'
            '    "通過硬性約束": true\n'
            "  },\n"
            '  "combinations": {\n'
            f'    "激進包牌": [選擇 {self.num_picks} 個數字的陣列],\n'
            f'    "穩健平衡": [選擇 {self.num_picks} 個數字的陣列],\n'
            f'    "統計趨勢": [選擇 {self.num_picks} 個數字的陣列]\n'
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

                # 驗證結構
                if "combinations" not in result or "reasoning" not in result:
                    raise ValueError("LLM 回傳的 JSON 缺少必要的欄位。")

                logging.info(f"{self.model} 推理完成！")
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
