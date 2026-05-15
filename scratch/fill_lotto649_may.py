"""從台灣彩券官方 API 補齊 lotto649.json 缺漏期數（2026-04/05）。"""
import json
import sys
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from scraper.official_scraper import OfficialScraper

PATH = ROOT / "data" / "lotto649.json"
META = ROOT / "data" / "meta.json"


def main():
    with open(PATH, encoding="utf-8") as f:
        existing = json.load(f)

    by_id = {str(d["draw_id"]): d for d in existing}
    scraper = OfficialScraper("649")
    added = []

    for month in ("2026-04", "2026-05"):
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

    merged = sorted(by_id.values(), key=lambda x: x["date"])
    with open(PATH, "w", encoding="utf-8") as f:
        json.dump(merged, f, ensure_ascii=False, indent=2)

    meta = {}
    if META.exists():
        with open(META, encoding="utf-8") as f:
            meta = json.load(f)
    meta["last_updated"] = datetime.now().isoformat()
    meta["lotto649_total"] = len(merged)
    with open(META, "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=2)

    print(f"新增 {len(added)} 期")
    for date, did in sorted(added):
        d = by_id[did]
        nums = ", ".join(f"{n:02d}" for n in d["numbers"])
        sp = d["special_number"]
        print(f"  {date}  {did}  {nums}  特別號:{sp:02d}")

    print("\n2026年5月（共", sum(1 for d in merged if d["date"].startswith("2026-05")), "期）")
    for d in merged:
        if d["date"].startswith("2026-05"):
            nums = ", ".join(f"{n:02d}" for n in d["numbers"])
            print(f"  {d['date']}  {d['draw_id']}  {nums}  特別號:{d['special_number']:02d}")


if __name__ == "__main__":
    main()
