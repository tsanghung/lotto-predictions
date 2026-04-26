import logging
import argparse
from datetime import datetime

from analyzer.ai_predictor import AIPredictor, save_predictions
from notifier.notifier import UniversalNotifier

logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')

def run_prediction_pipeline(game_name: str, data_file: str, max_number: int, num_picks: int):
    logging.info(f"啟動 {game_name} 預測與推播管線...")
    
    # 1. 執行 AI 預測
    predictor = AIPredictor(game_name, data_file, max_number, num_picks)
    result = predictor.generate_prediction()
    
    # 2. 儲存預測結果
    save_predictions(game_name, result)
    
    # 3. 組裝推播訊息
    target_date = datetime.now().strftime("%Y-%m-%d")
    notifier = UniversalNotifier()
    msg = notifier.build_prediction_message(
        game_name=game_name,
        target_date=target_date,
        insight=result.get("reasoning", "無提供洞察"),
        combinations=result.get("combinations", {})
    )
    
    # 加入風險提示
    if "risk_warning" in result:
        msg += f"\n(AI小語: {result['risk_warning']})"
        
    # 4. 發送 LINE Notify
    notifier.send_message(msg)
    logging.info(f"{game_name} 預測推播完成！")

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="執行樂透 AI 預測與推播")
    parser.add_argument("--game", type=str, choices=["649", "539"], required=True, help="選擇遊戲類型: 649 (大樂透) 或 539 (今彩539)")
    args = parser.parse_args()
    
    if args.game == "649":
        run_prediction_pipeline("大樂透", "data/lotto649.json", 49, 6)
    elif args.game == "539":
        run_prediction_pipeline("今彩539", "data/daily539.json", 39, 5)
