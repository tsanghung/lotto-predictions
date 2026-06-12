import hashlib
import json
import os
from pathlib import Path
from typing import Any, Iterable

import requests


ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = ROOT / "data"
SUPABASE_URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
SUPABASE_SERVICE_ROLE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
CHUNK_SIZE = 500


class SupabaseSyncError(RuntimeError):
    pass


def load_json(path: Path) -> Any:
    with path.open("r", encoding="utf-8") as file:
        return json.load(file)


def chunks(items: list[dict[str, Any]], size: int) -> Iterable[list[dict[str, Any]]]:
    for index in range(0, len(items), size):
        yield items[index:index + size]


def request(method: str, table: str, payload: Any | None = None) -> None:
    if not SUPABASE_URL or not SUPABASE_SERVICE_ROLE_KEY:
        raise SupabaseSyncError("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required")

    response = requests.request(
        method,
        f"{SUPABASE_URL}/rest/v1/{table}",
        headers={
            "apikey": SUPABASE_SERVICE_ROLE_KEY,
            "Authorization": f"Bearer {SUPABASE_SERVICE_ROLE_KEY}",
            "Content-Type": "application/json",
            "Prefer": "resolution=merge-duplicates,return=minimal",
        },
        json=payload,
        timeout=60,
    )

    if response.status_code >= 400:
        raise SupabaseSyncError(
            f"Supabase {table} sync failed: {response.status_code} {response.text}"
        )


def source_key(record: dict[str, Any]) -> str:
    raw_key = "|".join([
        record.get("game_name", ""),
        record.get("timestamp", ""),
        record.get("evaluation", {}).get("draw_id", ""),
    ])
    return hashlib.sha1(raw_key.encode("utf-8")).hexdigest()


def sync_draws(game_name: str, file_name: str) -> int:
    rows = []
    for record in load_json(DATA_DIR / file_name):
        rows.append({
            "game_name": game_name,
            "draw_id": str(record["draw_id"]),
            "draw_date": record["date"],
            "numbers": record["numbers"],
            "special_number": record.get("special_number"),
            "raw": record,
        })

    for batch in chunks(rows, CHUNK_SIZE):
        request("POST", "lotto_draws?on_conflict=game_name,draw_id", batch)

    return len(rows)


def sync_predictions() -> int:
    records = load_json(DATA_DIR / "predictions.json")
    rows = []
    for record in records:
        rows.append({
            "source_key": source_key(record),
            "game_name": record["game_name"],
            "predicted_at": record["timestamp"],
            "prediction": record.get("prediction") or {},
            "is_evaluated": bool(record.get("is_evaluated")),
            "evaluation": record.get("evaluation"),
            "raw": record,
        })

    for batch in chunks(rows, CHUNK_SIZE):
        request("POST", "prediction_records?on_conflict=source_key", batch)

    return len(rows)


def sync_meta() -> None:
    meta = load_json(DATA_DIR / "meta.json")
    request("POST", "app_meta?on_conflict=meta_key", [{
        "meta_key": "current",
        "last_updated": meta.get("last_updated"),
        "payload": meta,
    }])


def sync_performance() -> None:
    performance = load_json(DATA_DIR / "performance.json")
    request("POST", "performance_snapshots?on_conflict=snapshot_key", [{
        "snapshot_key": "current",
        "last_updated": performance.get("last_updated"),
        "payload": performance,
    }])


def main() -> None:
    lotto_count = sync_draws("大樂透", "lotto649.json")
    daily_count = sync_draws("今彩539", "daily539.json")
    prediction_count = sync_predictions()
    sync_meta()
    sync_performance()
    print(
        "Supabase sync completed: "
        f"lotto649={lotto_count}, daily539={daily_count}, predictions={prediction_count}"
    )


if __name__ == "__main__":
    main()
