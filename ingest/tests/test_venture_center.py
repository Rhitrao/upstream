"""Venture Center: every field from its own card, no year read as an age, no profile as a domain.

    python3 -m unittest discover -s ingest/tests -t .
"""

from __future__ import annotations

import pathlib
import unittest
from unittest import mock

from ingest.sources import venture_center as vc

FIXTURES = pathlib.Path(__file__).parent / "fixtures"


def scrape(html: str):
    with mock.patch.object(vc, "fetch", return_value=html):
        companies, signals = vc.scrape()
    return {c.id: c for c in companies}, signals


class VentureCenterCards(unittest.TestCase):
    def setUp(self):
        self.companies, self.signals = scrape((FIXTURES / "venture_center_cards.html").read_text())

    def test_a_card_gives_its_own_name_summary_and_site(self):
        c = self.companies["call-x-ringers"]
        self.assertEqual(c.name, "Call X Ringers Pvt Ltd")
        self.assertEqual(c.website, "https://lithiumionbattery-recycling.com/")
        self.assertTrue(c.description.startswith("Closing the loop on lithium-ion batteries"))
        self.assertFalse(c.description_is_label)

    def test_the_bracketed_year_is_kept_and_never_read_as_an_age(self):
        c = self.companies["call-x-ringers"]
        self.assertEqual((c.source_year, c.source_year_type), (2026, "unknown"))
        self.assertIsNone(c.origin_year)
        self.assertIsNone(c.record_year)
        self.assertIsNone(c.founded_year)

    def test_an_impossible_year_is_dropped_not_guessed(self):
        c = self.companies["cellxx-technologies"]
        self.assertEqual(c.name, "CellXX Technologies Pvt Ltd")
        self.assertIsNone(c.source_year)
        self.assertIsNone(c.source_year_type)

    def test_a_linkedin_page_is_not_a_company_domain(self):
        for cid in ("urjanovac", "sakura-biotech", "queliz-lifetech"):
            self.assertIsNone(self.companies[cid].website, cid)

    def test_one_listing_signal_per_company_and_no_date_invented(self):
        self.assertEqual(len(self.signals), len(self.companies))
        self.assertTrue(all(s.type == "incubator" and s.date is None for s in self.signals))


class NothingIsJoinedByPosition(unittest.TestCase):
    def test_a_card_missing_its_summary_does_not_shift_the_next_one(self):
        # Synthetic, and the one shape the live page does not show today: a card with
        # no summary. Zipping page-wide lists would hand the second card's sentence to
        # the first.
        html = """<div id="StartupsListing">
          <article><h3><a href="https://first.example">First Co Pvt Ltd (2020)</a></h3></article>
          <article><h3><a href="https://second.example">Second Co Pvt Ltd (2021)</a></h3>
            <p class="summary">Second Co builds sensors.</p></article>
        </div>"""
        companies, _ = scrape(html)
        self.assertIsNone(companies["first-co"].description)
        self.assertEqual(companies["second-co"].description, "Second Co builds sensors.")
        self.assertEqual(companies["first-co"].website, "https://first.example")

    def test_a_changed_page_raises_rather_than_returning_nothing(self):
        with self.assertRaises(ValueError):
            scrape("<html><body><p>We have moved.</p></body></html>")


if __name__ == "__main__":
    unittest.main()
