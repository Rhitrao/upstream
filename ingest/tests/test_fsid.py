"""FSID: every field from its own record, no contact kept, no profile as a domain, no date.

The fixture is nine real records from the search endpoint, with the email addresses
replaced by example.com ones so the repository holds nobody's.

    python3 -m unittest discover -s ingest/tests -t .
"""

from __future__ import annotations

import json
import pathlib
import unittest
from unittest import mock

from ingest.sources import fsid

FIXTURES = pathlib.Path(__file__).parent / "fixtures"
PAGE = (FIXTURES / "fsid_incubatees.json").read_text()


def scrape(body: str = PAGE):
    with mock.patch.object(fsid, "fetch_form", return_value=body):
        companies, signals = fsid.scrape()
    return {c.id: c for c in companies}, signals


def one(**fields) -> str:
    record = {"title": "", "thumbnail": "", "content": "", "twitter": "", "linkedin": "", "website": "", "email": "", "instagram": "", "domain": ""}
    return json.dumps({"total_count": 1, "result": [{**record, **fields}]})


class Records(unittest.TestCase):
    def setUp(self):
        self.companies, self.signals = scrape()

    def test_a_record_gives_its_own_name_description_and_site(self):
        c = self.companies["aagyavision"]
        self.assertEqual(c.name, "AAGYAVISION PVT. LTD.")
        self.assertEqual(c.website, "https://aagyavision.com/")
        self.assertTrue(c.description.startswith("AAGYAVISION® is a deep-technology company"))
        self.assertIsNone(c.founders)

    def test_markup_and_entities_become_plain_text(self):
        c = self.companies["kaiza-health"]
        self.assertNotIn("<", c.description)
        self.assertIn("SUSTAINABLE AGRI & ALLIED HEALTH", c.description)

    def test_no_email_address_is_kept_anywhere(self):
        for company in self.companies.values():
            self.assertNotIn("@", json.dumps(company.payload()), company.id)
        self.assertTrue(self.companies["magheals"].description.endswith("improve treatment outcomes."))
        self.assertTrue(self.companies["molecular-semiconductors-applied-organic-materials"].description.endswith("printed electronics"))

    def test_the_social_fields_are_not_kept(self):
        self.assertNotIn("linkedin", json.dumps([c.payload() for c in self.companies.values()]))

    def test_an_empty_website_is_none(self):
        self.assertIsNone(self.companies["e3-labs"].website)

    def test_one_company_listed_under_two_spellings_is_one_company(self):
        # "Mushloop" with no website, then "Mushloop Private Limited" with one.
        self.assertEqual(len(self.companies), 8)
        self.assertEqual(self.companies["mushloop"].website, "https://mushloop.com/")
        self.assertEqual(len([s for s in self.signals if s.company_id == "mushloop"]), 1)

    def test_entries_the_source_does_not_mark_as_non_companies_are_kept(self):
        self.assertIn("international-center-for-nano-devices", self.companies)

    def test_one_undated_signal_per_company(self):
        self.assertEqual(len(self.signals), len(self.companies))
        for signal in self.signals:
            self.assertEqual((signal.type, signal.label, signal.url, signal.source), ("incubator", "FSID IISc incubatee", fsid.URL, fsid.SOURCE))
            self.assertIsNone(signal.date)
        for company in self.companies.values():
            self.assertIsNone(company.record_year)
            self.assertIsNone(company.origin_year)


class Websites(unittest.TestCase):
    # Synthetic: shapes the live list does not show today but the form allows.
    def test_a_profile_in_the_website_field_is_not_a_website(self):
        companies, _ = scrape(one(title="Acme Sensors Pvt Ltd", content="Acme builds gas sensors for mines.", website="https://www.linkedin.com/company/acme/"))
        self.assertIsNone(companies["acme-sensors"].website)

    def test_a_placeholder_website_is_none(self):
        for value in ("NA", "N/A", "-", "https:--acme-com", "Acme Sensors", "logo.png"):
            with self.subTest(value=value):
                companies, _ = scrape(one(title="Acme Sensors Pvt Ltd", website=value))
                self.assertIsNone(companies["acme-sensors"].website)

    def test_a_bare_domain_becomes_a_link(self):
        companies, _ = scrape(one(title="Acme Sensors Pvt Ltd", website="acme.in"))
        self.assertEqual(companies["acme-sensors"].website, "https://acme.in")

    def test_a_phone_number_in_a_description_is_not_kept(self):
        companies, _ = scrape(one(title="Acme Sensors Pvt Ltd", content="Acme builds gas sensors. <br/>Phone: +91 98450 12345"))
        self.assertEqual(companies["acme-sensors"].description, "Acme builds gas sensors.")


class Pages(unittest.TestCase):
    def test_pages_are_read_until_a_short_one(self):
        records = json.loads(PAGE)["result"]
        pages = {1: records[:4], 2: records[4:8], 3: records[8:]}
        asked = []

        def fetch_form(url, form):
            asked.append(form["paged"])
            self.assertEqual({k: form[k] for k in ("action", "search", "domain")}, {"action": "search_incubatees", "search": "", "domain": ""})
            return json.dumps({"total_count": 99, "result": pages.get(form["paged"], [])})

        with mock.patch.object(fsid, "PER_PAGE", 4), mock.patch.object(fsid, "fetch_form", side_effect=fetch_form):
            companies, _ = fsid.scrape()
        self.assertEqual(asked, [1, 2, 3])
        self.assertIn("e3-labs", {c.id for c in companies})

    def test_a_changed_endpoint_raises_rather_than_returning_nothing(self):
        for body in ('{"total_count": 0, "result": []}', "0", '{"success": false}', "<html>Not found</html>"):
            with self.subTest(body=body), self.assertRaises(ValueError):
                scrape(body)


if __name__ == "__main__":
    unittest.main()
