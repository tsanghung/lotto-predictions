import logging
from typing import Dict, List

logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')

class StatisticalModel:
    def __init__(self, stats_engine):
        self.se = stats_engine
        self.max_n = stats_engine.max_number
        self.num_picks = 6 if self.max_n == 49 else 5
        self.trend_periods = 100 if self.max_n == 49 else 300

    def predict(self) -> Dict[str, List[int]]:
        missing = self.se.get_missing_values()
        cold = self.se.get_cold_pool()
        hot = self.se.get_hot_pool(self.trend_periods)
        gaps = self.se.get_gap_analysis()
        recent_freq = self.se.get_hot_cold_stats(self.trend_periods)["frequencies"]
        tail_dist = self.se.get_tail_distribution(self.trend_periods)["frequencies"]
        max_tail = max(tail_dist.values()) or 1
        zones = self.se.get_zone_distribution(self.trend_periods)["zones"]

        freq_z = self.se._compute_z_scores(recent_freq)
        missing_z = self.se._compute_z_scores(missing)

        signals = {}
        for n in range(1, self.max_n + 1):
            gap_ratio = 0.0
            g = gaps[n]
            if g.get("avg_gap") and g["avg_gap"] > 0:
                gap_ratio = min(3.0, g["current_gap"] / g["avg_gap"])
            signals[n] = {
                "gap_ratio": gap_ratio,
                "freq_z": freq_z.get(n, 0.0),
                "missing_z": missing_z.get(n, 0.0),
                "tail": tail_dist.get(n % 10, 0) / max_tail,
                "cold": n in cold,
                "hot": n in hot,
            }

        return {
            "激進包牌": self._select(self._score_aggressive, signals),
            "穩健平衡": self._select(self._score_balanced, signals),
            "統計趨勢": self._select(self._score_trend, signals),
        }

    def _select(self, scorer, signals):
        scored = [(n, scorer(s)) for n, s in signals.items()]
        scored.sort(key=lambda x: -x[1])
        return sorted(n for n, _ in scored[:self.num_picks])

    def _score_aggressive(self, s):
        return (s["gap_ratio"] * 2.0 + s["missing_z"] * 1.5 + s["tail"] * 0.5
                + (3.0 if s["cold"] else 0.0) - (2.0 if s["hot"] else 0.0))

    def _score_trend(self, s):
        return (s["freq_z"] * 2.0 + s["tail"] * 0.5
                + (3.0 if s["hot"] else 0.0) - (2.0 if s["cold"] else 0.0))

    def _score_balanced(self, s):
        extreme = abs(s["freq_z"]) > 1.0 or abs(s["missing_z"]) > 1.0
        return (s["tail"] * 1.0 + (0.5 if extreme else 2.0)
                + (1.0 if not s["cold"] and not s["hot"] else 0.0))
