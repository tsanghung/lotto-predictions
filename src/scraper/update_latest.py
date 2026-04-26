import json
import os
import logging
from datetime import datetime
from typing import List

from .scraper_core import ScraperException, LottoDraw
from .official_scraper import OfficialScraper
# TODO: 將來實作 ThirdPartyScraper 後，可自此導入並傳入 DualVerifier
# from .scraper_core import DualVerifier

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

    # [Bug #4 修復] DualVerifier 目前無第三方來源可用，改為單點直接抓取
    # 待實作 ThirdPartyScraper 後，可恢復雙重驗證機制
    logging.warning(
        "⚠️ [DualVerifier 停用] 目前僅使用官方 API 單點抓取，"
        "雙重驗證功能將於第三方來源實作後啟動。"
    )
    lotto_scraper = OfficialScraper(game_type="649")
    daily_scraper = OfficialScraper(game_type="539")
    
    try:
        # 大樂透 649 更新
        lotto_data = load_json("data/lotto649.json")
        latest_lotto = lotto_scraper.fetch_latest()
        is_lotto_updated = append_if_new(lotto_data, latest_lotto)
        if is_lotto_updated:
            save_json("data/lotto649.json", lotto_data)
            logging.info(f"大樂透更新成功！新增期數：{latest_lotto.draw_id}")
        else:
            logging.info("大樂透無新期數。")

        # 今彩 539 更新
        daily_data = load_json("data/daily539.json")
        latest_daily = daily_scraper.fetch_latest()
        is_daily_updated = append_if_new(daily_data, latest_daily)
        if is_daily_updated:
            save_json("data/daily539.json", daily_data)
            logging.info(f"今彩539更新成功！新增期數：{latest_daily.draw_id}")
        else:
            logging.info("今彩539無新期數。")

        # 若有任一更新，則修改 meta.json
        if is_lotto_updated or is_daily_updated:
            # 安全讀取 meta.json：若不存在則建立空 dict（首次執行時）
            if os.path.exists("data/meta.json"):
                with open("data/meta.json", "r", encoding='utf-8') as f:
                    try:
                        meta = json.load(f)
                    except json.JSONDecodeError:
                        meta = {}
            else:
                meta = {}

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
