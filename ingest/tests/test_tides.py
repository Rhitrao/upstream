"""TIDES: every field from its own record, status in the label, no directory as a domain.

The fixture is the real page trimmed to ten portfolio records and the page data
around them.

    python3 -m unittest discover -s ingest/tests -t .
"""

from __future__ import annotations

import json
import pathlib
import unittest
from unittest import mock

from ingest.sources import tides

FIXTURES = pathlib.Path(__file__).parent / "fixtures"
PAGE = (FIXTURES / "tides_portfolio.html").read_text()


def scrape(html: str = PAGE):
    with mock.patch.object(tides, "fetch", return_value=html):
        companies, signals = tides.scrape()
    return {c.id: c for c in companies}, {s.company_id: s for s in signals}, signals


def page(records: list[dict]) -> str:
    data = {"props": {"pageProps": {"data": {"data": {"contentBlock": [{"advanceData": {"data": records}}]}}}}}
    return f'<script id="__NEXT_DATA__" type="application/json">{json.dumps(data)}</script>'


class Records(unittest.TestCase):
    def setUp(self):
        self.companies, self.signal, self.signals = scrape()

    def test_a_record_gives_its_own_name_description_and_site(self):
        c = self.companies["umarobotics"]
        self.assertEqual(c.name, "Umarobotics")
        self.assertEqual(c.website, "https://umarobotics.com/")
        self.assertTrue(c.description.startswith("UMA Team comes with 20+ Years"))
        self.assertNotIn("<p>", c.description)
        self.assertNotIn("&nbsp;", self.companies["log9-materials-scientific"].description)

    def test_status_is_in_the_label(self):
        self.assertEqual(self.signal["umarobotics"].label, "TIDES IIT Roorkee, current incubatee")
        self.assertEqual(self.signal["log9-materials-scientific"].label, "TIDES IIT Roorkee, graduated")

    def test_a_profile_or_registry_lookup_is_not_a_website(self):
        self.assertIsNone(self.companies["neon-bike"].website)  # LinkedIn
        self.assertIsNone(self.companies["battezy-energy"].website)  # ZaubaCorp
        self.assertIsNone(self.companies["neuresko-technologies"].website)  # IndiaFilings
        blob = json.dumps([c.payload() for c in self.companies.values()])
        for host in ("linkedin", "zaubacorp", "indiafilings"):
            self.assertNotIn(host, blob)

    def test_a_missing_link_is_none_and_a_bare_domain_is_a_link(self):
        self.assertIsNone(self.companies["farmassistant"].website)
        self.assertEqual(self.companies["mantiswave-networks"].website, "https://www.mantiswave.in")
        self.assertEqual(self.companies["elespa-hev"].website, "https://www.elespahev.com")  # "www.elespahev.com Phone"

    def test_a_name_listed_twice_is_one_company_with_one_signal(self):
        self.assertEqual(len(self.companies), 9)
        self.assertEqual(len(self.signals), 9)
        self.assertEqual(self.companies["verdant-autobots"].name, "Verdant Autobots")
        self.assertEqual(self.companies["verdant-autobots"].website, "https://verdantautobots.com/")

    def test_nothing_is_dated(self):
        for signal in self.signals:
            self.assertIsNone(signal.date)
            self.assertEqual((signal.type, signal.url, signal.source), ("incubator", tides.URL, tides.SOURCE))
        for company in self.companies.values():
            self.assertIsNone(company.record_year)
            self.assertIsNone(company.origin_year)

    def test_the_campus_list_beside_the_portfolio_is_not_read(self):
        self.assertNotIn("tides", self.companies)


class Shapes(unittest.TestCase):
    def test_a_record_missing_its_description_does_not_take_the_next_one(self):
        # Synthetic: a record with an empty description, then one with a description
        # and a link. Each keeps only its own.
        html = page(
            [
                {"title": "First Co Pvt Ltd", "desci": "", "link": "#", "category": "CURRENT"},
                {"title": "Second Co Pvt Ltd", "desci": "<p>Second Co builds sensors.</p>", "link": "https://second.example", "category": "GRADUATED"},
            ]
        )
        companies, signal, _ = scrape(html)
        self.assertIsNone(companies["first-co"].description)
        self.assertIsNone(companies["first-co"].website)
        self.assertEqual(companies["second-co"].description, "Second Co builds sensors.")
        self.assertEqual(companies["second-co"].website, "https://second.example")
        self.assertEqual(signal["first-co"].label, "TIDES IIT Roorkee, current incubatee")

    def test_a_record_with_no_status_is_labelled_without_one(self):
        companies, signal, _ = scrape(page([{"title": "Third Co", "desci": "", "link": None, "category": ""}]))
        self.assertEqual(signal["third-co"].label, "TIDES IIT Roorkee")

    def test_a_changed_page_raises_rather_than_returning_nothing(self):
        for html in ("<html><body><p>We have moved.</p></body></html>", page([]), '<script id="__NEXT_DATA__" type="application/json">{oops</script>'):
            with self.subTest(html=html[:40]), self.assertRaises(ValueError):
                scrape(html)


if __name__ == "__main__":
    unittest.main()
