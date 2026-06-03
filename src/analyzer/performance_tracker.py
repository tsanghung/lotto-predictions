import os
import json
import logging
from typing import Dict, Optional

logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')

VALID_STRATEGIES = {"激進包牌", "穩健平衡", "統計趨勢"}

class PerformanceTracker:
    def __init__(self, performance_file: str = "data/performance.json"):
        self.file = performance_file
        self.data = self._load()

    def _load(self) -> dict:
        if not os.path.exists(self.file):
            return {"games": {}}
        with open(self.file, 'r', encoding='utf-8') as f:
            return json.load(f)

    def get_game_data(self, game_name: str) -> dict:
        return self.data.get("games", {}).get(game_name, {})

    def get_strategy_context(self, game_name: str, min_draws: int = 3) -> str:
        game = self.get_game_data(game_name)
        total = game.get("total_draws_evaluated", 0)
        if total < min_draws:
            return ""

        strategies = game.get("strategies", {})
        parts = []
        for s, d in sorted(strategies.items(), key=lambda x: -x[1].get("win_rate", 0)):
            if s not in VALID_STRATEGIES:
                continue
            wr = d.get("win_rate", 0)
            hits = d.get("total_hits", 0)
            miss = d.get("total_misses", 0)
            parts.append(f"{s}={wr*100:.1f}%({hits}/{hits+miss})")

        return f"📈 歷史預測績效 ({total}期): " + ", ".join(parts)

    def get_strategy_weights(self, game_name: str, min_draws: int = 5) -> Dict[str, float]:
        game = self.get_game_data(game_name)
        total = game.get("total_draws_evaluated", 0)
        if total < min_draws:
            return {}

        strategies = game.get("strategies", {})
        rates = {s: d.get("win_rate", 0) for s, d in strategies.items() if s in VALID_STRATEGIES}
        if not rates:
            return {}

        avg = sum(rates.values()) / len(rates)
        if avg == 0:
            return {s: 1.0 for s in rates}

        return {s: max(0.5, min(2.0, r / avg)) for s, r in rates.items()}

    def get_recent_trend(self, game_name: str, lookback: int = 5) -> str:
        game = self.get_game_data(game_name)
        trend = game.get("trend", [])
        recent = trend[-lookback:]
        if not recent:
            return ""

        hits = {s: 0 for s in VALID_STRATEGIES}
        for entry in recent:
            for s, h in entry.get("strategies", {}).items():
                if s in VALID_STRATEGIES:
                    hits[s] = hits.get(s, 0) + h

        parts = [f"{s}={hits[s]/len(recent):.2f}/期" for s in sorted(hits, key=lambda x: -hits[x])]
        return f"近{lookback}期趨勢: " + ", ".join(parts)
