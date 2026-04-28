import os
import json
import re
import logging
from datetime import datetime
from dotenv import load_dotenv
from google import genai
from google.genai import types

from .stats_engine import StatsEngine
from .web_search import WebSearcher

logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')

class AIPredictor:
    def __init__(self, game_name: str, data_file: str, max_number: int, num_picks: int):
        self.game_name = game_name
        self.num_picks = num_picks # 大樂透為 6 碼，今彩 539 為 5 碼
        
        load_dotenv()
        self.api_key = os.getenv("GEMINI_API_KEY")
        if self.api_key and self.api_key != "your_gemini_api_key_here":
            self.client = genai.Client(api_key=self.api_key)
        else:
            self.client = None
            logging.warning("未設定 GEMINI_API_KEY，將啟用離線模擬預測模式。")
            
        self.stats_engine = StatsEngine(data_file, max_number)
        self.web_searcher = WebSearcher()

    def _generate_mock_prediction(self, stats_context: str, reason: str = "未提供有效的 Gemini API Key") -> dict:
        """
        當沒有 API Key 或呼叫失敗時的離線備援方案 (Fallback)
        """
        logging.info("執行離線模擬預測...")
        import random
        # 從 stats context 中隨便抓幾個字當作 mock
        nums = list(range(1, self.stats_engine.max_number + 1))
        
        return {
            "reasoning": f"此為離線模擬預測。原因：{reason}",
            "risk_warning": "這只是隨機亂數，沒有任何 AI 推理。",
            "combinations": {
                "激進包牌": sorted(random.sample(nums, self.num_picks)),
                "穩健平衡": sorted(random.sample(nums, self.num_picks)),
                "完全隨機": sorted(random.sample(nums, self.num_picks))
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
            
        # 2. 定義 System Prompt 與 User Prompt
        system_instruction = (
            "你是一位『頂級博弈精算師』，精通機率論、統計學與大數據分析。"
            "請基於提供的『自 2007 年至今超過 10 年』的歷史累計數據與最新網路輿情，進行深度推估。"
            "你必須綜合考量長期的規律性與短期的熱冷門趨勢，提供具備科學依據的預測。"
            "分析結果必須嚴格遵守 JSON 格式回傳，不可包含任何額外字串或 Markdown 標記。"
        )
        
        prompt = (
            f"請為【{self.game_name}】進行下一期的號碼預測。\n"
            f"該遊戲是從 1 到 {self.stats_engine.max_number} 之間選出 {self.num_picks} 個號碼。\n"
            f"以下是背景資料：\n\n{full_context}\n\n"
            "請回傳以下 JSON 格式：\n"
            "{\n"
            '  "reasoning": "你的深度統計邏輯與輿情推理總結 (約 50-100 字)",\n'
            '  "risk_warning": "一句風險提示",\n'
            '  "combinations": {\n'
            f'    "激進包牌": [選擇 {self.num_picks} 個數字的陣列, 適合追求極端冷門反彈者],\n'
            f'    "穩健平衡": [選擇 {self.num_picks} 個數字的陣列, 綜合冷熱門與均值],\n'
            f'    "完全隨機": [選擇 {self.num_picks} 個數字的陣列, 不看任何數據]\n'
            "  }\n"
            "}"
        )

        try:
            # 3. 呼叫 Gemini API
            logging.info("正在呼叫 Gemini LLM 進行推理...")
            response = self.client.models.generate_content(
                model='gemini-2.5-flash',
                contents=prompt,
                config=types.GenerateContentConfig(
                    system_instruction=system_instruction,
                    temperature=0.7,
                    response_mime_type="application/json"
                )
            )
            
            # [修正] 增強 JSON 解析強健性：移除可能的 Markdown 標記或雜訊
            raw_text = response.text.strip()
            # 利用正則表達式擷取最外層的大括號內容
            json_match = re.search(r'(\{.*\})', raw_text, re.DOTALL)
            if json_match:
                clean_text = json_match.group(1)
            else:
                clean_text = raw_text

            result = json.loads(clean_text)
            
            # 驗證結構
            if "combinations" not in result or "reasoning" not in result:
                raise ValueError("LLM 回傳的 JSON 缺少必要的欄位。")
                
            logging.info("Gemini 推理完成！")
            return result
            
        except Exception as e:
            logging.error(f"AI 預測發生錯誤: {e}")
            logging.warning("啟動容錯機制，使用模擬預測。")
            return self._generate_mock_prediction(full_context, reason=f"API 發生錯誤: {e}")

def save_predictions(game_name: str, prediction: dict, file_path: str = "data/predictions.json"):
    """
    將預測結果儲存至 predictions.json
    """
    record = {
        "timestamp": datetime.now().isoformat(),
        "game_name": game_name,
        "prediction": prediction,
        "is_evaluated": False,
        "evaluation": {
            "draw_id": None,
            "actual_numbers": [],
            "strategies": {},
            "attribution_report": None
        }
    }
    
    predictions_history = []
    if os.path.exists(file_path):
        with open(file_path, 'r', encoding='utf-8') as f:
            try:
                predictions_history = json.load(f)
            except json.JSONDecodeError:
                pass
                
    predictions_history.append(record)
    
    # 只保留最近 50 次預測，避免檔案過大
    if len(predictions_history) > 50:
        predictions_history = predictions_history[-50:]
        
    with open(file_path, 'w', encoding='utf-8') as f:
        json.dump(predictions_history, f, ensure_ascii=False, indent=2)
    logging.info(f"預測結果已成功儲存至 {file_path}")

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
