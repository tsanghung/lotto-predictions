import json
import os
import logging
from datetime import datetime

from .official_scraper import OfficialScraper
from .scraper_core import ScraperException

logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')

def save_to_json(filepath: str, data: list):
    # 將 List[LottoDraw] 轉為 dict list
    data_dicts = [
        {
            "draw_id": draw.draw_id,
            "date": draw.date,
            "numbers": draw.numbers,
            "special_number": draw.special_number
        }
        for draw in data
    ]
    
    with open(filepath, 'w', encoding='utf-8') as f:
        json.dump(data_dicts, f, ensure_ascii=False, indent=2)
    logging.info(f"成功寫入 {len(data)} 筆資料至 {filepath}")

def main():
    logging.info("開始執行歷史大建檔 (Task 1.3)...")
    
    # 確保 data 目錄存在
    os.makedirs("data", exist_ok=True)
    
    lotto_scraper = OfficialScraper(game_type="649")
    daily_scraper = OfficialScraper(game_type="539")
    
    # 為了展示與測試效能，此處撈取 2025 ~ 2026 的資料作為歷史大建檔示範
    start_year = 2025
    end_year = datetime.now().year
    
    try:
        logging.info(f"開始撈取大樂透歷史資料 ({start_year} ~ {end_year})...")
        lotto_history = lotto_scraper.fetch_history(start_year, end_year)
        save_to_json("data/lotto649.json", lotto_history)
        
        logging.info(f"開始撈取今彩539歷史資料 ({start_year} ~ {end_year})...")
        daily_history = daily_scraper.fetch_history(start_year, end_year)
        save_to_json("data/daily539.json", daily_history)
        
        # 寫入 meta.json
        meta = {
            "last_updated": datetime.now().isoformat(),
            "lotto649_total": len(lotto_history),
            "daily539_total": len(daily_history)
        }
        with open("data/meta.json", 'w', encoding='utf-8') as f:
            json.dump(meta, f, ensure_ascii=False, indent=2)
            
        logging.info("歷史大建檔完成！")
        
    except ScraperException as e:
        logging.error(f"歷史大建檔發生錯誤：\n{e}")
        
if __name__ == "__main__":
    main()
