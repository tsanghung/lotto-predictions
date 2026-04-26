import requests
import urllib3
from typing import List, Dict, Any
from datetime import datetime, timedelta

# 停用 SSL 警告 (TW Lottery API 憑證問題)
urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

from .scraper_core import BaseScraper, LottoDraw, ScraperException

class OfficialScraper(BaseScraper):
    """
    台灣彩券官方 API 爬蟲
    """
    def __init__(self, game_type: str = "649"):
        super().__init__(source_name="TaiwanLottery_Official")
        self.game_type = game_type # "649" or "539"
        if game_type == "649":
            self.api_url = "https://api.taiwanlottery.com/TLCAPIWeB/Lottery/Lotto649Result"
            self.res_key = "lotto649Res"
        elif game_type == "539":
            self.api_url = "https://api.taiwanlottery.com/TLCAPIWeB/Lottery/Daily539Result"
            self.res_key = "daily539Res"
        else:
            raise ValueError("Unsupported game type. Use '649' or '539'")

    def _fetch_month(self, month_str: str) -> List[LottoDraw]:
        """
        :param month_str: "YYYY-MM"
        """
        headers = {"User-Agent": "Mozilla/5.0"}
        params = {"period": "", "month": month_str}
        
        try:
            resp = requests.get(self.api_url, headers=headers, params=params, timeout=10, verify=False)
            if resp.status_code != 200:
                raise ScraperException(
                    message=f"官方 API 請求失敗 ({resp.status_code})",
                    root_cause=f"Response: {resp.text[:100]}",
                    suggested_fix="確認 API 網址是否變更，或檢查 IP 是否被封鎖。"
                )
            
            data = resp.json()
            if data.get("rtCode") != 0:
                raise ScraperException(
                    message="官方 API 回傳錯誤碼",
                    root_cause=str(data),
                    suggested_fix="檢查 API 參數格式是否改變"
                )
                
            results = data.get("content", {}).get(self.res_key, [])
            draws = []
            for item in results:
                # 解析日期 "2024-03-29T00:00:00" -> "2024-03-29"
                date_str = item["lotteryDate"].split("T")[0]
                draw_id = str(item["period"])
                
                # numbers
                if self.game_type == "649":
                    # 大樂透：前 6 碼為一般號，第 7 碼為特別號
                    nums = sorted(item["drawNumberSize"][:6])
                    special = item["drawNumberSize"][6]
                else:
                    # 539: 5 碼一般號，無特別號
                    nums = sorted(item["drawNumberSize"])
                    special = None
                
                draws.append(LottoDraw(
                    draw_id=draw_id,
                    date=date_str,
                    numbers=nums,
                    special_number=special
                ))
            return draws

        except requests.exceptions.RequestException as e:
            raise ScraperException(
                message="網路連線錯誤",
                root_cause=str(e),
                suggested_fix="檢查網路狀態或設定 Proxy"
            )

    def fetch_latest(self) -> LottoDraw:
        # 取當前月份的資料
        current_month = datetime.now().strftime("%Y-%m")
        draws = self._fetch_month(current_month)
        if not draws:
            # 如果這個月還沒開獎，往前取一個月
            prev_month = (datetime.now().replace(day=1) - timedelta(days=1)).strftime("%Y-%m")
            draws = self._fetch_month(prev_month)
            
        if not draws:
            raise ScraperException(
                message="無法獲取最新開獎資料",
                root_cause="最近兩個月皆無開獎紀錄",
                suggested_fix="檢查官方 API 是否異常，或是否處於過年期間停開"
            )
        
        # 依期數排序，取最後一期
        draws.sort(key=lambda x: x.draw_id)
        return draws[-1]

    def fetch_history(self, start_year: int, end_year: int) -> List[LottoDraw]:
        all_draws = []
        for year in range(start_year, end_year + 1):
            for month in range(1, 13):
                # 如果是未來月份則跳過
                if year == datetime.now().year and month > datetime.now().month:
                    continue
                month_str = f"{year}-{month:02d}"
                draws = self._fetch_month(month_str)
                all_draws.extend(draws)
        
        # 依期數排序
        all_draws.sort(key=lambda x: x.draw_id)
        return all_draws

