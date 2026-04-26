import os
import requests
import logging
from dotenv import load_dotenv

logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')

class LineNotifier:
    def __init__(self):
        load_dotenv()
        self.token = os.getenv("LINE_NOTIFY_TOKEN")
        self.api_url = "https://notify-api.line.me/api/notify"

    def send_message(self, message: str) -> bool:
        if not self.token or self.token == "your_line_notify_token_here":
            logging.warning("LINE_NOTIFY_TOKEN 未設定或無效，跳過實際推播。")
            logging.info(f"模擬推播內容:\n{message}")
            return False

        headers = {
            "Authorization": f"Bearer {self.token}",
            "Content-Type": "application/x-www-form-urlencoded"
        }
        payload = {"message": message}

        try:
            response = requests.post(self.api_url, headers=headers, data=payload, timeout=10)
            if response.status_code == 200:
                logging.info("LINE Notify 發送成功！")
                return True
            else:
                logging.error(f"LINE Notify 發送失敗，狀態碼: {response.status_code}, 回應: {response.text}")
                return False
        except Exception as e:
            logging.error(f"發送 LINE Notify 時發生例外: {e}")
            return False

    def build_prediction_message(self, game_name: str, target_date: str, insight: str, combinations: dict) -> str:
        """
        組裝預測訊息
        :param combinations: {"激進包牌": [1,2,3,4,5,6], "穩健平衡": [...], "完全隨機": [...]}
        """
        msg = f"\n🔮【小賽 AI 樂透預測】🔮\n"
        msg += f"📅 日期：{target_date}\n"
        msg += f"🎯 遊戲：{game_name}\n"
        msg += f"{"-" * 20}\n"
        msg += f"📊 統計洞察：\n{insight}\n"
        msg += f"{"-" * 20}\n"
        msg += f"💡 推薦組合：\n"
        
        for strategy, nums in combinations.items():
            num_str = ", ".join([f"{n:02d}" for n in nums])
            msg += f"[{strategy}]: {num_str}\n"
            
        msg += f"{"-" * 20}\n"
        msg += "⚠️ 免責聲明：預測結果僅供參考，請理性投注，勿過度沉迷。"
        return msg

if __name__ == "__main__":
    notifier = LineNotifier()
    # 測試組裝與推播
    test_msg = notifier.build_prediction_message(
        game_name="大樂透",
        target_date="2026-04-25",
        insight="遺漏值達 30 期的冷門號 [14] 即將反彈，近期熱門尾數為 3 尾。",
        combinations={
            "激進包牌": [14, 23, 33, 43, 4, 11],
            "穩健平衡": [5, 12, 14, 28, 36, 49],
            "完全隨機": [2, 17, 24, 30, 41, 46]
        }
    )
    notifier.send_message(test_msg)
