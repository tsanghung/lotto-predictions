import json
import os
import logging
from datetime import datetime

from .official_scraper import OfficialScraper
from .scraper_core import ScraperException

logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')

def save_to_json(filepath: str, data: list):
    existing_data = []
    # 1. 讀取現有歷史資料
    if os.path.exists(filepath):
        with open(filepath, 'r', encoding='utf-8') as f:
            try:
                existing_data = json.load(f)
            except json.JSONDecodeError:
                existing_data = []
    
    # 2. 建立現有資料的期數集合，用於快速去重比對
    existing_ids = {str(item["draw_id"]) for item in existing_data}
    
    new_data_dicts = []
    for draw in data:
        if str(draw.draw_id) not in existing_ids:
            new_data_dicts.append({
                "draw_id": draw.draw_id,
                "date": draw.date,
                "numbers": draw.numbers,
                "special_number": draw.special_number
            })
    
    # 3. 合併資料並確保依期數排序
    combined_data = existing_data + new_data_dicts
    combined_data.sort(key=lambda x: str(x["draw_id"]))
    
    # 4. 全量寫回
    with open(filepath, 'w', encoding='utf-8') as f:
        json.dump(combined_data, f, ensure_ascii=False, indent=2)
    logging.info(f"成功合併 {len(new_data_dicts)} 筆新資料至 {filepath}，總計 {len(combined_data)} 筆")

def main():
    logging.info("開始執行歷史大建檔 (Task 1.3)...")
    
    # 防呆機制：若檔案已存在且資料超過閾值，強制中斷
    for file_path in ["data/lotto649.json", "data/daily539.json"]:
        if os.path.exists(file_path):
            with open(file_path, 'r', encoding='utf-8') as f:
                try:
                    existing_data = json.load(f)
                    if len(existing_data) > 1000:
                        logging.error(f"防呆機制啟動：{file_path} 已有 {len(existing_data)} 筆歷史資料。請勿重複執行大建檔，以免造成資料庫損毀或覆蓋。若需重新建檔，請先手動備份並刪除舊檔。")
                        return
                except json.JSONDecodeError:
                    pass

    # 確保 data 目錄存在
    os.makedirs("data", exist_ok=True)
    
    lotto_scraper = OfficialScraper(game_type="649")
    daily_scraper = OfficialScraper(game_type="539")
    
    # 從 2007 年開始抓取完整歷史資料
    start_year = 2007
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
