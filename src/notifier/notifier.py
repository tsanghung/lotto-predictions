import os
import requests
import logging
from dotenv import load_dotenv

logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')

class UniversalNotifier:
    def __init__(self):
        load_dotenv()
        self.webhook_url = os.getenv("NOTIFIER_WEBHOOK_URL")

    def send_message(self, message: str) -> bool:
        if not self.webhook_url:
            logging.warning("NOTIFIER_WEBHOOK_URL 未設定，跳過實際推播。")
            logging.info(f"模擬推播內容:\n{message}")
            return False

        # 針對 Discord 的 JSON 格式進行簡單封裝
        payload = {"content": message}

        try:
            response = requests.post(self.webhook_url, json=payload, timeout=10)
            if response.status_code in [200, 204]:
                logging.info("Webhook 訊息發送成功！")
                return True
            else:
                logging.error(f"Webhook 發送失敗，狀態碼: {response.status_code}, 回應: {response.text}")
                return False
        except Exception as e:
            logging.error(f"發送 Webhook 時發生例外: {e}")
            return False

    def build_prediction_message(self, game_name: str, target_date: str, insight: str, combinations: dict) -> str:
        """
        組裝預測訊息 (支援 Markdown 語法)
        """
        msg = f"## 🔮【小賽 AI 樂透預測】🔮\n"
        msg += f"**📅 日期**：`{target_date}`\n"
        msg += f"**🎯 遊戲**：`{game_name}`\n"
        msg += f"---\n"
        msg += f"### 📊 統計洞察：\n> {insight}\n"
        msg += f"---\n"
        msg += f"### 💡 推薦組合：\n"
        
        for strategy, nums in combinations.items():
            num_str = " , ".join([f"`{n:02d}`" for n in nums])
            msg += f"- **[{strategy}]**: {num_str}\n"
            
        msg += f"---\n"
        msg += "*⚠️ 免責聲明：預測結果僅供參考，請理性投注，勿過度沉迷。*"
        return msg

if __name__ == "__main__":
    notifier = UniversalNotifier()
    # 測試組裝與推播
    test_msg = notifier.build_prediction_message(
        game_name="今彩 539",
        target_date="2026-04-26",
        insight="根據近 10 期數據，尾數 6 的號碼出現頻率最高，建議關注 06, 16。",
        combinations={
            "激進包牌": [6, 16, 23, 26, 31],
            "穩健平衡": [2, 9, 16, 25, 34],
            "完全隨機": [1, 14, 22, 28, 33]
        }
    )
    notifier.send_message(test_msg)
