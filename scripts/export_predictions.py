"""Refresh data/predictions.json from the live Supabase prediction_records table.

This is the inverse of sync_supabase.py. The prediction + LINE pipeline now runs
server-side (Supabase Cron + Edge Function) and writes straight into Supabase, so
data/predictions.json is only a committed *snapshot* of that table. Without an export
path the snapshot silently goes stale; run this script to regenerate it.

Important: rebuild each entry from the authoritative top-level columns
(is_evaluated / evaluation), NOT from the `raw` column. The post-draw evaluator
updates the columns but leaves raw.evaluation at its pre-draw (empty) value, so using
raw would drop every real hit result.

Env:
  SUPABASE_URL                 e.g. https://<ref>.supabase.co
  SUPABASE_SERVICE_ROLE_KEY    service role key
  PREDICTIONS_EXPORT_LIMIT     optional int; keep only the most recent N entries
  PREDICTIONS_EXPORT_MODEL     optional comma-separated prediction model(s) to keep
                               (e.g. "game-theory-v1"); default keeps every model
"""
import json
import os
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = ROOT / "data"
SUPABASE_URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
SUPABASE_SERVICE_ROLE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
EXPORT_LIMIT = int(os.environ.get("PREDICTIONS_EXPORT_LIMIT", "0") or 0)
EXPORT_MODELS = [m.strip() for m in os.environ.get("PREDICTIONS_EXPORT_MODEL", "").split(",") if m.strip()]


def fetch_records() -> list[dict]:
    if not SUPABASE_URL or not SUPABASE_SERVICE_ROLE_KEY:
        raise SystemExit("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required")
    rows: list[dict] = []
    page_size = 1000
    for offset in range(0, 1_000_000, page_size):
        response = requests.get(
            f"{SUPABASE_URL}/rest/v1/prediction_records",
            headers={
                "apikey": SUPABASE_SERVICE_ROLE_KEY,
                "Authorization": f"Bearer {SUPABASE_SERVICE_ROLE_KEY}",
            },
            params={
                "select": "game_name,predicted_at,prediction,is_evaluated,evaluation,raw",
                "order": "predicted_at.asc",
                "limit": page_size,
                "offset": offset,
            },
            timeout=60,
        )
        if response.status_code >= 400:
            raise SystemExit(f"Supabase query failed: {response.status_code} {response.text}")
        page = response.json()
        rows.extend(page)
        if len(page) < page_size:
            break
    return rows


def to_entry(row: dict) -> dict:
    raw = row.get("raw") or {}
    return {
        "timestamp": raw.get("timestamp") or row.get("predicted_at"),
        "game_name": row.get("game_name"),
        "is_offline": bool(raw.get("is_offline", False)),
        "prediction": row.get("prediction") or {},
        "is_evaluated": bool(row.get("is_evaluated")),
        "evaluation": row.get("evaluation"),
    }


def main() -> None:
    rows = fetch_records()
    if EXPORT_MODELS:
        rows = [r for r in rows if (r.get("prediction") or {}).get("model") in EXPORT_MODELS]
    entries = [to_entry(row) for row in rows]
    # Stored oldest-first to match the existing snapshot convention.
    entries.sort(key=lambda e: e.get("timestamp") or "")
    if EXPORT_LIMIT > 0:
        entries = entries[-EXPORT_LIMIT:]
    out = DATA_DIR / "predictions.json"
    out.write_text(json.dumps(entries, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote {len(entries)} entries to {out}")


if __name__ == "__main__":
    main()
