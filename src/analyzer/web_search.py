import logging
from ddgs import DDGS

logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')

class WebSearcher:
    """
    輿情檢索模組，用於抓取最新樂透時事與鄉民討論
    """
    def __init__(self):
        self.ddgs = DDGS()

    def get_lottery_news_context(self, game_name: str, max_results: int = 5) -> str:
        """
        搜尋近期的樂透相關新聞、熱門話題或分析
        """
        query = f"台灣彩券 {game_name} 預測 報牌 分析 走勢"
        logging.info(f"開始搜尋網路輿情，關鍵字: {query}")
        
        try:
            # 取得搜尋結果
            results = self.ddgs.text(
                query,
                region="tw-tz", # 台灣地區
                safesearch="off",
                timelimit="w",  # 本週最新
                max_results=max_results
            )
            
            context = f"🌐 網路輿情與時事分析 ({game_name} - 本週最新):\n"
            if not results:
                context += "無最新顯著輿情。\n"
                return context
                
            for idx, r in enumerate(results, 1):
                title = r.get("title", "")
                snippet = r.get("body", "")
                context += f"{idx}. 【{title}】\n   摘要: {snippet}\n"
                
            return context
            
        except Exception as e:
            logging.error(f"搜尋過程中發生錯誤: {e}")
            return f"🌐 網路輿情檢索失敗 ({e})，使用純統計推論。"

if __name__ == "__main__":
    searcher = WebSearcher()
    # 測試大樂透輿情
    news_context = searcher.get_lottery_news_context("大樂透")
    
    # 修正 Windows 終端機編碼輸出
    import sys
    sys.stdout.reconfigure(encoding='utf-8')
    print(news_context)
