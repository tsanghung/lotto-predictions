import os
import json
import logging
from dotenv import load_dotenv
from google import genai
from google.genai import types

from .stats_engine import StatsEngine

logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')

class AttributionAnalyzer:
    def __init__(self, data_file: str, max_number: int):
        load_dotenv()
        self.api_key = os.getenv("GEMINI_API_KEY")
        if self.api_key and self.api_key != "your_gemini_api_key_here":
            self.client = genai.Client(api_key=self.api_key)
        else:
            self.client = None
            logging.warning("未設定 GEMINI_API_KEY，歸因分析模組將回傳離線預設說明。")
            
        self.stats_engine = StatsEngine(data_file, max_number)

    def generate_attribution_report(self, game_name: str, draw_id: str, predicted_combinations: dict, actual_numbers: list) -> str:
        """
        針對未命中情況，呼叫 LLM 進行嚴格的數理歸因分析。
        """
        # 如果是離線模式
        if not self.client:
            return "【離線歸因報告】因未設定 API Key，無法進行深度 AI 歸因。根據大數法則，短期內的開獎分佈本就存在極大的隨機性變異，此為預期的機率偏差。"

        stats_context = self.stats_engine.generate_full_report()
        
        system_instruction = (
            "你是一位頂級的『數理統計學家』與『機率論專家』。"
            "你的任務是針對樂透預測系統的「未命中號碼」進行客觀、嚴謹的科學歸因分析。"
            "【嚴格規定】：\n"
            "1. 必須基於科學、數理、統計學及機率理論進行解釋。\n"
            "2. 必須引用具體的統計術語（例如：變異數分析 ANOVA、偏態分佈 Skewness、大數法則 Law of Large Numbers、樣本偏差、自相關性、隨機漫步 Random Walk 等）。\n"
            "3. 嚴禁任何編造、幻想、玄學、運氣、靈性或沒有數據支撐的虛假解釋。\n"
            "4. 如果開獎結果單純是因為隨機性造成的離群值 (Outlier)，請直接以機率學的角度說明其合理性。\n"
            "5. 請保持專業、冷靜的語氣，字數控制在 200 字以內。"
        )

        prompt = (
            f"以下是【{game_name}】第 {draw_id} 期的預測與開獎結果對比：\n\n"
            f"實際開獎號碼: {actual_numbers}\n"
            f"我們的預測組合: {json.dumps(predicted_combinations, ensure_ascii=False)}\n\n"
            f"當前的歷史統計背景資料如下：\n{stats_context}\n\n"
            "請根據上述資訊，給出一份針對「為何未能完全命中」的深度科學歸因報告。"
        )

        try:
            logging.info("正在呼叫 Gemini 進行科學歸因分析...")
            # 必須設定極低的 Temperature 以防止幻覺
            response = self.client.models.generate_content(
                model='gemini-2.5-flash',
                contents=prompt,
                config=types.GenerateContentConfig(
                    system_instruction=system_instruction,
                    temperature=0.1, 
                )
            )
            logging.info("科學歸因分析完成！")
            return response.text.strip()
        except Exception as e:
            logging.error(f"科學歸因發生錯誤: {e}")
            return "【系統錯誤】歸因分析引擎發生異常，無法生成報告。"

if __name__ == "__main__":
    # 測試執行
    analyzer = AttributionAnalyzer("data/lotto649.json", 49)
    report = analyzer.generate_attribution_report(
        game_name="大樂透",
        draw_id="113000001",
        predicted_combinations={"激進包牌": [1, 2, 3, 4, 5, 6]},
        actual_numbers=[10, 20, 30, 40, 41, 42]
    )
    print("生成報告:\n", report)
