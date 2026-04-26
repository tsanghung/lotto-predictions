import json
import os
import logging
from datetime import datetime
from typing import List

from .scraper_core import DualVerifier, ScraperException, LottoDraw
from .official_scraper import OfficialScraper

logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')

def load_json(filepath: str) -> List[dict]:
    if not os.path.exists(filepath):
        return []
    with open(filepath, 'r', encoding='utf-8') as f:
        return json.load(f)

def save_json(filepath: str, data: List[dict]):
    with open(filepath, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=2)

def append_if_new(existing_data: List[dict], latest_draw: LottoDraw) -> bool:
    """
    如果最新期數不在現有資料中，則 append 並回傳 True。否則回傳 False。
    """
    for item in existing_data[-5:]:  # 只檢查最後五筆即可
        if str(item['draw_id']) == str(latest_draw.draw_id):
            return False
            
    existing_data.append({
        "draw_id": latest_draw.draw_id,
        "date": latest_draw.date,
        "numbers": latest_draw.numbers,
        "special_number": latest_draw.special_number
    })
    return True

def main():
    logging.info("開始執行 Task 2.1：每日抓取最新一期號碼...")
    
    # 初始化 Scraper 與 DualVerifier
    # 註：目前 Primary 與 Secondary 皆使用 Official API 作為示範
    # 實際運作時，Secondary 應替換為 ThirdPartyScraper
    lotto_primary = OfficialScraper(game_type="649")
    lotto_secondary = OfficialScraper(game_type="649")
    lotto_verifier = DualVerifier(primary=lotto_primary, secondary=lotto_secondary)
    
    daily_primary = OfficialScraper(game_type="539")
    daily_secondary = OfficialScraper(game_type="539")
    daily_verifier = DualVerifier(primary=daily_primary, secondary=daily_secondary)
    
    try:
        # 大樂透 649 更新
        lotto_data = load_json("data/lotto649.json")
        latest_lotto = lotto_verifier.get_verified_latest()
        is_lotto_updated = append_if_new(lotto_data, latest_lotto)
        if is_lotto_updated:
            save_json("data/lotto649.json", lotto_data)
            logging.info(f"大樂透更新成功！新增期數：{latest_lotto.draw_id}")
        else:
            logging.info("大樂透無新期數。")

        # 今彩 539 更新
        daily_data = load_json("data/daily539.json")
        latest_daily = daily_verifier.get_verified_latest()
        is_daily_updated = append_if_new(daily_data, latest_daily)
        if is_daily_updated:
            save_json("data/daily539.json", daily_data)
            logging.info(f"今彩539更新成功！新增期數：{latest_daily.draw_id}")
        else:
            logging.info("今彩539無新期數。")

        # 若有任一更新，則修改 meta.json
        if is_lotto_updated or is_daily_updated:
            meta = load_json("data/meta.json") if os.path.exists("data/meta.json") else {}
            # 必須轉為 dict，否則會有 attribute error，因為 load_json 若為 dict 就沒事，但上面定義是 List[dict]
            # 修正 load_json 只對陣列，這裡直接讀寫 meta
            with open("data/meta.json", "r", encoding='utf-8') as f:
                meta = json.load(f)
                
            meta["last_updated"] = datetime.now().isoformat()
            meta["lotto649_total"] = len(lotto_data)
            meta["daily539_total"] = len(daily_data)
            
            with open("data/meta.json", 'w', encoding='utf-8') as f:
                json.dump(meta, f, ensure_ascii=False, indent=2)
            logging.info("已更新 meta.json。")
            
    except ScraperException as e:
        logging.error(f"抓取最新資料發生錯誤：\n{e}")

if __name__ == "__main__":
    main()
