import unittest

from scripts.sync_supabase import source_key


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


if __name__ == "__main__":
    unittest.main()
