"""從台灣彩券官方 API 補齊 daily539.json 缺漏期數。"""
import json
import sys
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from scraper.official_scraper import OfficialScraper

PATH = ROOT / "data" / "daily539.json"
META = ROOT / "data" / "meta.json"

# 補齊範圍：檔案最後一筆若落在 4 月底，從 2026-04 起對帳至當月
MONTHS = ("2026-04", "2026-05")


def main():
    with open(PATH, encoding="utf-8") as f:
        existing = json.load(f)

    by_id = {str(d["draw_id"]): d for d in existing}
    before = len(by_id)

    scraper = OfficialScraper("539")
    added = []

    for month in MONTHS:
        for draw in scraper._fetch_month(month):
            did = str(draw.draw_id)
            if did not in by_id:
                by_id[did] = {
                    "draw_id": did,
                    "date": draw.date,
                    "numbers": draw.numbers,
                    "special_number": draw.special_number,
                }
                added.append((draw.date, did))

    # 月查詢 API 有時漏期，依期別 ID 連號補洞
    import requests
    import urllib3

    urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)
    api_url = scraper.api_url
    numeric_ids = sorted(int(d) for d in by_id if d.isdigit())
    if numeric_ids:
        lo, hi = numeric_ids[-30], numeric_ids[-1]
        for pid in range(lo, hi + 1):
            did = str(pid)
            if did in by_id:
                continue
            resp = requests.get(
                api_url,
                params={"period": did, "month": ""},
                headers={"User-Agent": "Mozilla/5.0"},
                verify=False,
                timeout=10,
            )
            if resp.status_code != 200:
                continue
            items = resp.json().get("content", {}).get(scraper.res_key, [])
            for item in items:
                if str(item["period"]) != did:
                    continue
                by_id[did] = {
                    "draw_id": did,
                    "date": item["lotteryDate"].split("T")[0],
                    "numbers": sorted(item["drawNumberSize"]),
                    "special_number": None,
                }
                added.append((by_id[did]["date"], did))

    merged = sorted(by_id.values(), key=lambda x: x["date"])
    with open(PATH, "w", encoding="utf-8") as f:
        json.dump(merged, f, ensure_ascii=False, indent=2)

    meta = {}
    if META.exists():
        with open(META, encoding="utf-8") as f:
            meta = json.load(f)
    meta["last_updated"] = datetime.now().isoformat()
    meta["daily539_total"] = len(merged)
    with open(META, "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=2)

    print(f"新增 {len(added)} 期（{before} -> {len(merged)}）")
    for date, did in sorted(added):
        d = by_id[did]
        nums = ", ".join(f"{n:02d}" for n in d["numbers"])
        print(f"  {date}  {did}  {nums}")

    print("\n2026年4月:", sum(1 for d in merged if d["date"].startswith("2026-04")), "期")
    print("2026年5月:", sum(1 for d in merged if d["date"].startswith("2026-05")), "期")
    may = [d for d in merged if d["date"].startswith("2026-05")]
    for d in may:
        nums = ", ".join(f"{n:02d}" for n in d["numbers"])
        print(f"  {d['date']}  {d['draw_id']}  {nums}")


if __name__ == "__main__":
    main()
