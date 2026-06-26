"""
從 Supabase 拉取開獎資料，寫成本機 JSON（與 data/lotto649.json 同格式）。
預設拉威力彩，補上本機缺少的 data/power.json，讓離線分析腳本可在三個彩種跑完。

讀取環境變數（不寫死任何金鑰）：
    SUPABASE_URL        例如 https://<ref>.supabase.co
    SUPABASE_ANON_KEY   public anon / publishable key（lotto_draws 為 public read）

用法:
    SUPABASE_URL=... SUPABASE_ANON_KEY=... python scripts/fetch_power_data.py
    （可選）GAME_NAME=威力彩 OUT_FILE=data/power.json
"""

import json
import os
import sys

import requests

sys.stdout.reconfigure(encoding="utf-8")

SUPABASE_URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
ANON_KEY = os.environ.get("SUPABASE_ANON_KEY", "")
GAME_NAME = os.environ.get("GAME_NAME", "威力彩")
OUT_FILE = os.environ.get("OUT_FILE", "data/power.json")
PAGE = 1000


def fetch_all():
    if not SUPABASE_URL or not ANON_KEY:
        raise SystemExit("請設定環境變數 SUPABASE_URL 與 SUPABASE_ANON_KEY")

    headers = {"apikey": ANON_KEY, "Authorization": f"Bearer {ANON_KEY}"}
    rows = []
    offset = 0
    while True:
        params = {
            "game_name": f"eq.{GAME_NAME}",
            "select": "draw_id,draw_date,numbers,special_number",
            "order": "draw_date.asc,draw_id.asc",
            "limit": str(PAGE),
            "offset": str(offset),
        }
        resp = requests.get(f"{SUPABASE_URL}/rest/v1/lotto_draws", headers=headers, params=params, timeout=30)
        resp.raise_for_status()
        page = resp.json()
        rows.extend(page)
        if len(page) < PAGE:
            break
        offset += PAGE
    return rows


def main():
    rows = fetch_all()
    records = [
        {
            "draw_id": str(r["draw_id"]),
            "date": r["draw_date"],
            "numbers": sorted(int(n) for n in r["numbers"]),
            "special_number": (int(r["special_number"]) if r.get("special_number") is not None else None),
        }
        for r in rows
    ]
    records.sort(key=lambda x: (x["date"], x["draw_id"]))

    os.makedirs(os.path.dirname(OUT_FILE), exist_ok=True)
    with open(OUT_FILE, "w", encoding="utf-8") as f:
        json.dump(records, f, ensure_ascii=False, indent=2)

    print(f"已寫入 {OUT_FILE}：{GAME_NAME} 共 {len(records)} 期"
          f"（{records[0]['date']} ~ {records[-1]['date']}）" if records else f"{GAME_NAME} 無資料")
    if records:
        print(f"範例最新一期：{records[-1]}")


if __name__ == "__main__":
    main()
