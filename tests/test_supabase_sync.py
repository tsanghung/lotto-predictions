import unittest

from scripts.sync_supabase import normalize_taipei_timestamp, source_key, target_draw_date


class SourceKeyTests(unittest.TestCase):
    def test_source_key_does_not_change_after_evaluation(self):
        pending_record = {
            "game_name": "今彩539",
            "timestamp": "2026-06-11T14:47:57.998224",
            "prediction": {
                "combinations": {
                    "穩健平衡": [5, 22, 23, 26, 27],
                    "統計趨勢": [8, 10, 22, 26, 27],
                }
            },
            "is_evaluated": False,
            "evaluation": {
                "draw_id": None,
                "actual_numbers": [],
                "strategies": {},
            },
        }
        evaluated_record = {
            **pending_record,
            "is_evaluated": True,
            "evaluation": {
                "draw_id": "115000142",
                "actual_numbers": [8, 15, 20, 29, 31],
                "strategies": {
                    "統計趨勢": {
                        "hits": 1,
                        "matches": [8],
                    }
                },
            },
        }

        self.assertEqual(source_key(pending_record), source_key(evaluated_record))

    def test_source_key_uses_target_draw_date_not_timestamp_second(self):
        first = {
            "game_name": "大樂透",
            "timestamp": "2026-06-12T14:36:21.390434",
        }
        second = {
            "game_name": "大樂透",
            "timestamp": "2026-06-12T16:20:22+08:00",
        }

        self.assertEqual(target_draw_date(first), "2026-06-12")
        self.assertEqual(source_key(first), source_key(second))

    def test_target_draw_date_moves_lotto649_to_next_draw_day(self):
        record = {
            "game_name": "大樂透",
            "timestamp": "2026-06-13T22:25:00+08:00",
        }

        self.assertEqual(target_draw_date(record), "2026-06-16")


class TimestampTests(unittest.TestCase):
    def test_naive_prediction_timestamp_is_treated_as_taipei_time(self):
        self.assertEqual(
            normalize_taipei_timestamp("2026-06-11T14:47:57.998224"),
            "2026-06-11T14:47:57.998224+08:00",
        )

    def test_existing_timezone_is_preserved(self):
        self.assertEqual(
            normalize_taipei_timestamp("2026-06-11T06:47:57.998224+00:00"),
            "2026-06-11T06:47:57.998224+00:00",
        )


if __name__ == "__main__":
    unittest.main()
