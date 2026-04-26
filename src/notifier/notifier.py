import os
import requests
import logging
from dotenv import load_dotenv

logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')

class LineBotNotifier:
    def __init__(self):
        load_dotenv()
        self.access_token = os.getenv("LINE_CHANNEL_ACCESS_TOKEN")
        self.user_id = os.getenv("LINE_USER_ID")
        self.api_url = "https://api.line.me/v2/bot/message/push"

    def send_message(self, message: str) -> bool:
        if not self.access_token or not self.user_id:
            logging.warning("LINE_CHANNEL_ACCESS_TOKEN 或 LINE_USER_ID 未設定，跳過實際推播。")
            logging.info(f"模擬推播內容:\n{message}")
            return False

        headers = {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {self.access_token}"
        }
        
        # 建立推播內容
        payload = {
            "to": self.user_id,
            "messages": [
                {
                    "type": "text",
                    "text": message
                }
            ]
        }

        try:
            response = requests.post(self.api_url, headers=headers, json=payload, timeout=15)
            if response.status_code == 200:
                logging.info("LINE Messaging API 推播成功！")
                return True
            else:
                logging.error(f"LINE API 錯誤，狀態碼: {response.status_code}, 回應: {response.text}")
                return False
        except Exception as e:
            logging.error(f"調用 LINE Messaging API 時發生例外: {e}")
            return False

    def build_prediction_message(self, game_name: str, target_date: str, insight: str, combinations: dict) -> str:
        """
        組裝適合 LINE 閱讀的訊息格式
        """
        msg = f"🔮【小賽 AI 樂透預測】🔮\n\n"
        msg += f"📅 日期：{target_date}\n"
        msg += f"🎯 遊戲：{game_name}\n"
        msg += f"──────────────────\n"
        msg += f"📊 統計洞察：\n{insight}\n"
        msg += f"──────────────────\n"
        msg += f"💡 推薦組合：\n"
        
        for strategy, nums in combinations.items():
            num_str = ", ".join([f"{n:02d}" for n in nums])
            msg += f"[{strategy}]:\n{num_str}\n\n"
            
        msg += f"──────────────────\n"
        msg += "⚠️ 提醒：請理性投注，勿過度沉迷。"
        return msg

if __name__ == "__main__":
    notifier = LineBotNotifier()
    # 測試組裝與推播
    test_msg = notifier.build_prediction_message(
        game_name="今彩 539",
        target_date="2026-04-26",
        insight="分析近期 30 期開獎，發現在 5 尾號碼冷卻 3 期後，05 與 15 有顯著反彈趨勢。",
        combinations={
            "AI 核心推薦": [5, 15, 23, 29, 31],
            "熱門遺漏組合": [2, 9, 15, 26, 38],
            "平衡守備策略": [1, 14, 22, 28, 33]
        }
    )
    notifier.send_message(test_msg)
