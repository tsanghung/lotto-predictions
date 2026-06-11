import json
import os
import logging
import re
from datetime import datetime
from typing import List, Optional

import requests

from .scraper_core import ScraperException, LottoDraw
from .official_scraper import OfficialScraper

logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')


class AuzonetDaily539Scraper:
    """
    奧索樂透網今彩539備援來源。

    用途：台彩官方 API 偶爾會晚於公開開獎頁更新。當官方 API 最新期數落後時，
    從第二來源讀取最新一期，後續仍會經 validate_draw 做基本合理性檢查。
    """
    source_name = "Auzonet_Daily539"
    url = "https://lotto.auzonet.com/daily539"

    def fetch_latest(self) -> LottoDraw:
        try:
            resp = requests.get(
                self.url,
                headers={"User-Agent": "Mozilla/5.0"},
                timeout=20,
            )
            resp.raise_for_status()
        except requests.exceptions.RequestException as e:
            raise ScraperException(
                message="第二來源今彩539請求失敗",
                root_cause=str(e),
                suggested_fix="檢查 lotto.auzonet.com 是否可連線，或改用其他備援來源。"
            )

        text = resp.text
        match = re.search(
            r'<span[^>]*>\s*(?P<draw_id>\d+)\s*</span>\s*<br\s*/?>\s*'
            r'<br\s*/?>\s*(?P<date>\d{4}-\d{2}-\d{2}).*?'
            r'<p>\s*大小順序：\s*</p>(?P<numbers>.*?)</li>',
            text,
            flags=re.DOTALL,
        )
        if not match:
            raise ScraperException(
                message="第二來源今彩539解析失敗",
                root_cause="找不到最新期數、日期或大小順序號碼區塊。",
                suggested_fix="檢查奧索樂透網 HTML 結構是否改版，並更新解析規則。"
            )

        nums = [int(n) for n in re.findall(r">\s*(\d{1,2})\s*</a>", match.group("numbers"))]
        if len(nums) < 5:
            raise ScraperException(
                message="第二來源今彩539號碼解析不足",
                root_cause=f"numbers={nums}",
                suggested_fix="檢查大小順序區塊是否已改版或號碼連結格式是否改變。"
            )

        return LottoDraw(
            draw_id=match.group("draw_id"),
            date=match.group("date"),
            numbers=sorted(nums[:5]),
            special_number=None,
        )


def choose_freshest_draw(
    game_label: str,
    official_draw: LottoDraw,
    secondary_draw: Optional[LottoDraw],
) -> LottoDraw:
    """
    選擇較新的開獎資料。

    - 第二來源比官方來源新：採用第二來源。
    - 兩來源同一期但號碼不同：fail fast，避免污染資料。
    - 第二來源較舊或不存在：維持官方來源。
    """
    if secondary_draw is None:
        return official_draw

    official_key = (str(official_draw.draw_id), official_draw.date)
    secondary_key = (str(secondary_draw.draw_id), secondary_draw.date)
    if official_key == secondary_key and official_draw != secondary_draw:
        raise ScraperException(
            message=f"{game_label} 來源資料衝突：官方 API 與第二來源同一期號碼不同。",
            root_cause=f"official={official_draw}, secondary={secondary_draw}",
            suggested_fix="請人工比對台灣彩券官方網站或公正紀錄表後再更新資料。"
        )

    official_date = datetime.strptime(official_draw.date, "%Y-%m-%d").date()
    secondary_date = datetime.strptime(secondary_draw.date, "%Y-%m-%d").date()
    if secondary_date > official_date or str(secondary_draw.draw_id) > str(official_draw.draw_id):
        logging.warning(
            "%s 官方 API 最新期數落後，改用第二來源：official=%s/%s secondary=%s/%s",
            game_label,
            official_draw.draw_id,
            official_draw.date,
            secondary_draw.draw_id,
            secondary_draw.date,
        )
        return secondary_draw

    return official_draw


# ── 基本合理性驗證（取代尚未實作的 DualVerifier 第三方來源）────────────────
def validate_draw(draw: LottoDraw, max_number: int, num_picks: int, existing_data: List[dict]) -> None:
    """
    對單筆開獎資料進行基本合理性檢查，發現異常立即拋出 ScraperException。
    這不能取代真正的雙重驗證，但能攔截明顯的 API 異常或網站改版問題。

    檢查項目：
    1. 號碼數量正確
    2. 所有號碼在合法範圍內（1 ~ max_number）
    3. 號碼無重複
    4. 日期格式合法且不是未來日期
    5. 期數不早於現有最新期數（防止 API 回傳舊資料）
    """
    nums = draw.numbers

    # 1. 號碼數量
    if len(nums) != num_picks:
        raise ScraperException(
            message=f"期數 {draw.draw_id} 號碼數量異常：預期 {num_picks} 個，實際 {len(nums)} 個",
            root_cause=f"numbers={nums}",
            suggested_fix="官方 API 回傳格式可能已變更，請檢查 drawNumberSize 欄位。"
        )

    # 2. 號碼範圍
    out_of_range = [n for n in nums if not (1 <= n <= max_number)]
    if out_of_range:
        raise ScraperException(
            message=f"期數 {draw.draw_id} 含超出範圍的號碼：{out_of_range}（合法範圍 1~{max_number}）",
            root_cause=f"numbers={nums}",
            suggested_fix="確認 API 是否混入特別號或其他欄位資料。"
        )

    # 3. 號碼重複
    if len(set(nums)) != len(nums):
        raise ScraperException(
            message=f"期數 {draw.draw_id} 含重複號碼：{nums}",
            root_cause=f"numbers={nums}",
            suggested_fix="API 回傳資料異常，請人工確認官方網站。"
        )

    # 4. 日期合法性
    try:
        draw_date = datetime.strptime(draw.date, "%Y-%m-%d").date()
    except ValueError:
        raise ScraperException(
            message=f"期數 {draw.draw_id} 日期格式異常：{draw.date}",
            root_cause="日期無法解析",
            suggested_fix="確認 API lotteryDate 欄位格式是否改變。"
        )
    if draw_date > datetime.now().date():
        raise ScraperException(
            message=f"期數 {draw.draw_id} 開獎日期 {draw.date} 是未來日期，資料異常",
            root_cause=f"draw_date={draw_date} > today={datetime.now().date()}",
            suggested_fix="API 可能回傳了預告資料，請確認。"
        )

    # 5. 期數連續性（不早於現有最新期數）
    if existing_data:
        latest_existing_id = str(existing_data[-1].get("draw_id", "0"))
        if str(draw.draw_id) < latest_existing_id:
            raise ScraperException(
                message=f"API 回傳期數 {draw.draw_id} 早於現有最新期數 {latest_existing_id}，疑似資料倒退",
                root_cause=f"new_id={draw.draw_id} < existing_latest={latest_existing_id}",
                suggested_fix="確認 API 是否回傳了舊月份資料，或 fetch_latest 邏輯是否有誤。"
            )

    logging.info(f"✅ 期數 {draw.draw_id} 合理性驗證通過（{num_picks} 個號碼，範圍 1~{max_number}，日期 {draw.date}）")

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
    logging.info("開始執行每日抓取最新一期號碼...")
    logging.info(
        "ℹ️ [驗證模式] 使用官方 API 單點抓取 + 本地合理性驗證。"
        "完整 DualVerifier 雙重驗證將於第三方來源實作後啟動。"
    )

    lotto_scraper = OfficialScraper(game_type="649")
    daily_scraper = OfficialScraper(game_type="539")
    daily_secondary_scraper = AuzonetDaily539Scraper()

    is_updated = False
    lotto_count = 0
    daily_count = 0

    # 1. 大樂透 649 更新
    try:
        lotto_data = load_json("data/lotto649.json")
        latest_lotto = lotto_scraper.fetch_latest()
        validate_draw(latest_lotto, max_number=49, num_picks=6, existing_data=lotto_data)
        if append_if_new(lotto_data, latest_lotto):
            save_json("data/lotto649.json", lotto_data)
            logging.info(f"大樂透更新成功！新增期數：{latest_lotto.draw_id}")
            is_updated = True
        else:
            logging.info("大樂透無新期數。")
        lotto_count = len(lotto_data)
    except ScraperException as e:
        logging.error(f"大樂透抓取或驗證發生錯誤：{e}")
        lotto_count = len(load_json("data/lotto649.json"))

    # 2. 今彩 539 更新
    try:
        daily_data = load_json("data/daily539.json")
        latest_daily = daily_scraper.fetch_latest()
        try:
            secondary_daily = daily_secondary_scraper.fetch_latest()
            latest_daily = choose_freshest_draw("今彩539", latest_daily, secondary_daily)
        except ScraperException as e:
            logging.warning(f"今彩539第二來源檢查失敗，維持官方 API 資料：{e}")
        validate_draw(latest_daily, max_number=39, num_picks=5, existing_data=daily_data)
        if append_if_new(daily_data, latest_daily):
            save_json("data/daily539.json", daily_data)
            logging.info(f"今彩539更新成功！新增期數：{latest_daily.draw_id}")
            is_updated = True
        else:
            logging.info("今彩539無新期數。")
        daily_count = len(daily_data)
    except ScraperException as e:
        logging.error(f"今彩539抓取或驗證發生錯誤：{e}")
        daily_count = len(load_json("data/daily539.json"))

    # 3. 狀態寫入：每次執行都更新 meta.json（代表「最後檢查時間」）
    if os.path.exists("data/meta.json"):
        with open("data/meta.json", "r", encoding='utf-8') as f:
            try:
                meta = json.load(f)
            except json.JSONDecodeError:
                meta = {}
    else:
        meta = {}

    meta["last_updated"] = datetime.now().isoformat()
    meta["lotto649_total"] = lotto_count
    meta["daily539_total"] = daily_count

    with open("data/meta.json", 'w', encoding='utf-8') as f:
        json.dump(meta, f, ensure_ascii=False, indent=2)
    logging.info(f"已同步 meta.json 狀態（is_updated={is_updated}）。")

if __name__ == "__main__":
    main()
