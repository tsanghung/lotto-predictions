import unittest

from src.scraper.scraper_core import LottoDraw, ScraperException
from src.scraper.update_latest import choose_freshest_draw


class ChooseFreshestDrawTests(unittest.TestCase):
    def test_uses_secondary_when_official_is_stale(self):
        official = LottoDraw(
            draw_id="115000140",
            date="2026-06-09",
            numbers=[10, 17, 20, 25, 28],
        )
        secondary = LottoDraw(
            draw_id="115000141",
            date="2026-06-10",
            numbers=[1, 4, 32, 35, 39],
        )

        selected = choose_freshest_draw(
            game_label="今彩539",
            official_draw=official,
            secondary_draw=secondary,
        )

        self.assertEqual(selected.draw_id, "115000141")
        self.assertEqual(selected.date, "2026-06-10")
        self.assertEqual(selected.numbers, [1, 4, 32, 35, 39])

    def test_rejects_secondary_with_same_date_but_conflicting_numbers(self):
        official = LottoDraw(
            draw_id="115000141",
            date="2026-06-10",
            numbers=[1, 4, 32, 35, 39],
        )
        secondary = LottoDraw(
            draw_id="115000141",
            date="2026-06-10",
            numbers=[1, 4, 30, 35, 39],
        )

        with self.assertRaises(ScraperException):
            choose_freshest_draw(
                game_label="今彩539",
                official_draw=official,
                secondary_draw=secondary,
            )


if __name__ == "__main__":
    unittest.main()
