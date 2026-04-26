import logging
from dataclasses import dataclass
from typing import List, Optional, Tuple

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s'
)

class ScraperException(Exception):
    """
    Fail Fast 機制的自訂例外處理
    """
    def __init__(self, message: str, root_cause: str, suggested_fix: str):
        self.message = message
        self.root_cause = root_cause
        self.suggested_fix = suggested_fix
        super().__init__(self.message)

    def __str__(self):
        return (f"\n[Status]: Error - {self.message}\n"
                f"[Root Cause]: {self.root_cause}\n"
                f"[Suggested Fix]: {self.suggested_fix}")


@dataclass
class LottoDraw:
    draw_id: str        # 期數，如 '112000001'
    date: str           # 開獎日期，格式 'YYYY-MM-DD'
    numbers: List[int]  # 開出獎號（依大小排序）
    special_number: Optional[int] = None # 特別號

    def __eq__(self, other):
        if not isinstance(other, LottoDraw):
            return False
        return (self.draw_id == other.draw_id and
                self.numbers == other.numbers and
                self.special_number == other.special_number)


class BaseScraper:
    """
    爬蟲介面，定義主要與次要來源必須實作的行為
    """
    def __init__(self, source_name: str):
        self.source_name = source_name

    def fetch_latest(self) -> LottoDraw:
        raise NotImplementedError

    def fetch_history(self, year: int = None) -> List[LottoDraw]:
        raise NotImplementedError


class DualVerifier:
    """
    雙重驗證機制核心：
    由 Primary 與 Secondary 兩個資料來源進行交叉比對，
    若不一致則觸發 Fail Fast，確保回傳的資料 100% 正確。
    """
    def __init__(self, primary: BaseScraper, secondary: BaseScraper):
        self.primary = primary
        self.secondary = secondary

    def get_verified_latest(self) -> LottoDraw:
        try:
            logging.info(f"從主要來源 [{self.primary.source_name}] 獲取最新資料...")
            primary_data = self.primary.fetch_latest()
            
            logging.info(f"從次要來源 [{self.secondary.source_name}] 獲取最新資料...")
            secondary_data = self.secondary.fetch_latest()

            if primary_data != secondary_data:
                raise ScraperException(
                    message="雙重驗證失敗：主要來源與次要來源的最新開獎資料不一致。",
                    root_cause=f"Primary ({primary_data}) != Secondary ({secondary_data})",
                    suggested_fix="請人工檢查兩個來源的網頁結構是否改變，或是否有網站提供錯誤資訊。"
                )
            
            logging.info("雙重驗證成功！資料一致。")
            return primary_data

        except ScraperException as e:
            logging.error(e)
            raise
        except Exception as e:
            raise ScraperException(
                message="爬蟲執行期間發生未預期錯誤。",
                root_cause=str(e),
                suggested_fix="請檢查網路連線狀態或爬蟲目標網站是否封鎖了 IP。"
            )

    def get_verified_history(self, year: int) -> List[LottoDraw]:
        try:
            logging.info(f"從主要來源 [{self.primary.source_name}] 獲取 {year} 年歷史資料...")
            primary_history = self.primary.fetch_history(year)
            
            logging.info(f"從次要來源 [{self.secondary.source_name}] 獲取 {year} 年歷史資料...")
            secondary_history = self.secondary.fetch_history(year)

            if len(primary_history) != len(secondary_history):
                raise ScraperException(
                    message="雙重驗證失敗：主要來源與次要來源的歷史期數數量不一致。",
                    root_cause=f"Primary (count={len(primary_history)}) != Secondary (count={len(secondary_history)})",
                    suggested_fix="請檢查是否有某個來源漏抓資料，或來源網頁的分頁邏輯已經改變。"
                )

            # 進行逐期比對
            for p_draw, s_draw in zip(primary_history, secondary_history):
                if p_draw != s_draw:
                    raise ScraperException(
                        message=f"雙重驗證失敗：期數 {p_draw.draw_id} 的資料不一致。",
                        root_cause=f"Primary ({p_draw}) != Secondary ({s_draw})",
                        suggested_fix="資料來源內容衝突，請人工比對台灣彩券官方網站的正式公告。"
                    )

            logging.info(f"{year} 年歷史資料雙重驗證成功！共驗證 {len(primary_history)} 期。")
            return primary_history

        except ScraperException as e:
            logging.error(e)
            raise
        except Exception as e:
            raise ScraperException(
                message="歷史資料爬蟲執行期間發生未預期錯誤。",
                root_cause=str(e),
                suggested_fix="檢查爬蟲邏輯是否遇到空值或網路中斷。"
            )
