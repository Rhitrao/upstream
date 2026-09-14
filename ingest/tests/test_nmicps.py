"""NM-ICPS: dates at the precision given, no profile as a domain, no hub's copy of another.

The fixture is fourteen real records from the endpoint, chosen for the ways it goes
wrong.

    python3 -m unittest discover -s ingest/tests -t .
"""

from __future__ import annotations

import json
import pathlib
import unittest
from unittest import mock

from ingest.sources import nmicps

FIXTURES = pathlib.Path(__file__).parent / "fixtures"
PAGE = (FIXTURES / "nmicps_startups.json").read_text()


def scrape(body: str = PAGE):
    with mock.patch.object(nmicps, "fetch", return_value=body), mock.patch.object(nmicps.log, "warning"):
        companies, signals = nmicps.scrape()
    by_company: dict[str, list] = {}
    for signal in signals:
        by_company.setdefault(signal.company_id, []).append(signal)
    return {c.id: c for c in companies}, signals, by_company


class Records(unittest.TestCase):
    def setUp(self):
        self.companies, self.signals, self.by_company = scrape()

    def test_a_record_gives_its_own_name_brief_site_and_founders(self):
        c = self.companies["edgeforce-solutions"]
        self.assertEqual(c.name, "EdgeForce Solutions")
        self.assertEqual(c.website, "https://edgeforce.in/")
        self.assertTrue(c.description.startswith("EdgeForce Solutions is a technology startup"))
        self.assertEqual(c.founders, "Colonel P Hani, Colonel (Dr) N Sriramesh")
        self.assertEqual(c.founders_source, nmicps.SOURCE)

        g = self.companies["gdq"]
        self.assertEqual(g.website, "https://gdqlabs.com/")
        self.assertTrue(g.description.startswith("Quantum Magnetometers"))

    def test_a_social_profile_is_not_a_website_and_is_not_kept(self):
        c = self.companies["opt2deal-e-commerce"]
        self.assertIsNone(c.website)
        self.assertNotIn("linkedin", json.dumps(c.payload()))

    def test_placeholder_and_mangled_sites_are_none(self):
        self.assertIsNone(self.companies["senseqube-technologies"].website)  # "NA"
        self.assertIsNone(self.companies["darwin-digitech"].website)  # a browser tab's title
        self.assertIsNone(self.companies["embright-infotech"].website)  # the company's name
        self.assertIsNone(self.companies["grow-your-farms"].website)  # "https:--growyourfarms-com"

    def test_a_brief_that_is_only_a_product_name_is_not_a_description(self):
        self.assertIsNone(self.companies["neos-healthtech"].description)  # "Flow"
        self.assertIsNone(self.companies["bramhansh-technologies"].description)  # "Migrarelief"
        self.assertEqual(self.companies["opt2deal-e-commerce"].description, "Platform to liquidate access inventory")

    def test_a_full_date_dates_the_signal_to_the_day(self):
        (signal,) = self.by_company["edgeforce-solutions"]
        self.assertEqual(signal.date, "2023-09-22")
        self.assertEqual(signal.label, "IIT Kharagpur AI4ICPS (NM-ICPS) seed-funded startup, 2023-09-22")
        self.assertEqual(signal.url, "https://nmicps.gov.in/startups")
        self.assertEqual((signal.type, signal.source), ("incubator", nmicps.SOURCE))
        self.assertEqual(self.companies["edgeforce-solutions"].record_year, 2023)

    def test_a_support_period_dates_the_signal_to_its_start(self):
        signal = next(s for s in self.by_company["grow-your-farms"])
        # "09-05-2024 - 31-11-2025": day first, and the end is not a real date.
        self.assertEqual(signal.date, "2024-05-09")
        self.assertIn("2024-05-09 to 31-11-2025", signal.label)
        self.assertEqual(self.companies["grow-your-farms"].record_year, 2024)

    def test_a_bare_year_is_a_year_never_a_first_of_january(self):
        (signal,) = self.by_company["embright-infotech"]
        self.assertEqual(signal.date, "2023")
        self.assertEqual(self.companies["embright-infotech"].record_year, 2023)

    def test_a_financial_year_is_kept_in_the_label_and_dates_nothing(self):
        (signal,) = self.by_company["darwin-digitech"]
        self.assertIsNone(signal.date)
        self.assertTrue(signal.label.endswith(", 2023-2024"))
        self.assertIsNone(self.companies["darwin-digitech"].record_year)

        (patna_twin,) = self.by_company["neos-healthtech"]
        self.assertIsNone(patna_twin.date)
        self.assertTrue(patna_twin.label.endswith(", 2023-24"))  # "2023 - 24" as written, spaces gone

    def test_no_year_here_is_an_origin_or_founding_year(self):
        for company in self.companies.values():
            self.assertIsNone(company.origin_year, company.id)
            self.assertIsNone(company.founded_year, company.id)

    def test_a_record_that_says_it_was_not_funded_is_not_called_seed_funded(self):
        (signal,) = self.by_company["gdq"]
        self.assertEqual(signal.label, "IISER Pune I-Hub Quantum (NM-ICPS) incubatee, not given any funds, only incubation")
        self.assertIsNone(signal.date)
        self.assertIsNone(self.companies["gdq"].record_year)

    def test_the_same_company_twice_under_one_hub_is_one_signal(self):
        (signal,) = self.by_company["senseqube-technologies"]
        self.assertTrue(signal.label.endswith(", 2021-2022"))

    def test_a_company_under_two_hubs_is_one_company_with_two_signals(self):
        signals = self.by_company["canorx-motors"]
        self.assertEqual(
            sorted(s.label for s in signals),
            [
                "IIT Hyderabad TiHAN (NM-ICPS) seed-funded startup, 2023-10-31 to 2025-10-30",
                "IIT Palakkad IPTIF (NM-ICPS) seed-funded startup, 2025-02-01",
            ],
        )
        c = self.companies["canorx-motors"]
        # The first listing's site is mangled; the second listing's own site fills it.
        self.assertEqual(c.website, "https://www.canorx.com/")
        self.assertEqual(c.record_year, 2023)

    def test_patna_records_that_repeat_indore_are_dropped(self):
        for cid in ("neos-healthtech", "bramhansh-technologies"):
            labels = [s.label for s in self.by_company[cid]]
            self.assertEqual(len(labels), 1, cid)
            self.assertTrue(labels[0].startswith("IIT Indore Drishti CPS"), cid)
        self.assertFalse(any("Patna" in s.label for s in self.signals))


class Copies(unittest.TestCase):
    def test_a_hub_whose_whole_list_repeats_another_hubs_is_dropped_and_logged(self):
        # The fixture holds two of Patna's 56 copies; lower the floor to see the
        # whole-list rule rather than the Patna-and-Indore one.
        with mock.patch.object(nmicps, "MIN_COPY", 2), mock.patch.object(nmicps, "fetch", return_value=PAGE), mock.patch.object(nmicps.log, "warning") as warning:
            _, signals = nmicps.scrape()
        self.assertFalse(any("Patna" in s.label for s in signals))
        self.assertTrue(any("copy of" in str(call) and "IIT Patna" in str(call) for call in warning.call_args_list))

    def test_a_small_hub_sharing_its_one_company_is_not_a_copy(self):
        # Synthetic: a hub that funded one company another hub also funded, with the
        # same brief. Below the floor, that is two hubs choosing one company.
        records = json.loads(PAGE)["data"]
        edge = records[0]
        twin = {**edge, "id": 1, "incub_date": "2024-01-05", "hub_id": 23, "master_hub": records[8]["master_hub"]}
        body = json.dumps({"data": [edge, records[1], twin]})
        _, signals, by_company = scrape(body)
        self.assertEqual(len(by_company["edgeforce-solutions"]), 2)


class Pages(unittest.TestCase):
    def test_pages_are_read_until_a_short_one(self):
        records = json.loads(PAGE)["data"]
        pages = {1: records[:5], 2: records[5:10], 3: records[10:]}
        calls = []

        def fetch(url):
            page = int(url.split("page=")[1].split("&")[0])
            calls.append(page)
            return json.dumps({"data": pages.get(page, [])})

        with mock.patch.object(nmicps, "LIMIT", 5), mock.patch.object(nmicps, "fetch", side_effect=fetch), mock.patch.object(nmicps.log, "warning"):
            companies, _ = nmicps.scrape()
        self.assertEqual(calls, [1, 2, 3])
        self.assertIn("embright-infotech", {c.id for c in companies})

    def test_a_changed_endpoint_raises_rather_than_returning_nothing(self):
        for body in ('{"message": "ok", "data": []}', '{"error": "moved"}', "<html>We have moved.</html>"):
            with self.subTest(body=body), self.assertRaises(ValueError):
                scrape(body)


class Dates(unittest.TestCase):
    def test_each_shape_the_hubs_write(self):
        cases = {
            "2023-09-22": ("2023-09-22", 2023),
            "2023": ("2023", 2023),
            "2022-23": (None, None),
            "2022 - 23": (None, None),
            "2023-2024": (None, None),
            "2025 -  2026": (None, None),
            "2021-07-15 - 2023-07-14": ("2021-07-15", 2021),
            "2023-02-30": (None, None),
            "not given any funds, only incubation": (None, None),
            "": (None, None),
        }
        for text, (date, year) in cases.items():
            with self.subTest(text=text):
                got_date, _, got_year = nmicps._when(text)
                self.assertEqual((got_date, got_year), (date, year))


if __name__ == "__main__":
    unittest.main()
