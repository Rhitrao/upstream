"""A domain's registration date is asked once, kept forever, and never fails a run.

    python3 -m unittest discover -s ingest/tests -t .

No test here touches the network: lookup() takes the query and the clock as
arguments, and the cache path as a third.
"""

from __future__ import annotations

import datetime
import json
import pathlib
import tempfile
import types
import unittest

from ingest import rdap

NOW = datetime.datetime(2026, 9, 14, 12, 0, tzinfo=datetime.UTC)


def company(id: str, website: str | None, identity: str | None = "verified"):
    return types.SimpleNamespace(id=id, website=website, website_identity=identity)


class TheNameSomeoneRegistered(unittest.TestCase):
    def test_subdomains_are_stripped(self):
        self.assertEqual(rdap.registrable("https://www.fabheads.in/"), "fabheads.in")
        self.assertEqual(rdap.registrable("http://shop.eu.acuradyne.com/x?y=1"), "acuradyne.com")

    def test_multi_part_suffixes_keep_three_labels(self):
        self.assertEqual(rdap.registrable("https://www.planystech.co.in"), "planystech.co.in")
        self.assertEqual(rdap.registrable("iitm.ac.in"), "iitm.ac.in")
        self.assertEqual(rdap.registrable("https://www.ngo.org.in/about"), "ngo.org.in")
        self.assertEqual(rdap.registrable("https://store.example.com.au"), "example.com.au")

    def test_a_bare_host_and_an_email_domain_work_too(self):
        self.assertEqual(rdap.registrable("WWW.Fabheads.IN"), "fabheads.in")

    def test_things_that_are_not_domains_are_none(self):
        for value in (None, "", "localhost", "https://1.2.3.4/", "co.in", "not a url", "http://[::1"):
            self.assertIsNone(rdap.registrable(value), value)

    def test_a_hosted_subdomain_is_its_own_site_but_not_asked_about(self):
        domain = rdap.registrable("https://anurag49.github.io/atsc.github.io")
        self.assertEqual(domain, "anurag49.github.io")
        self.assertTrue(rdap.is_hosted(domain))
        self.assertFalse(rdap.is_hosted("fabheads.in"))


class ReadingTheResponse(unittest.TestCase):
    RESPONSE = {
        "objectClassName": "domain",
        "ldhName": "fabheads.in",
        "events": [
            {"eventAction": "last changed", "eventDate": "2025-01-02T03:04:05Z"},
            {"eventAction": "registration", "eventDate": "2015-06-11T07:28:59.000Z"},
            {"eventAction": "expiration", "eventDate": "2027-06-11T07:28:59Z"},
        ],
    }

    def test_the_registration_event_is_the_date(self):
        self.assertEqual(rdap.parse_registration(self.RESPONSE), "2015-06-11")

    def test_no_registration_event_is_none(self):
        self.assertIsNone(rdap.parse_registration({"events": [{"eventAction": "expiration", "eventDate": "2027-01-01"}]}))
        self.assertIsNone(rdap.parse_registration({}))

    def test_a_malformed_date_is_none_not_an_error(self):
        self.assertIsNone(rdap.parse_registration({"events": [{"eventAction": "registration", "eventDate": "yesterday"}]}))
        self.assertIsNone(rdap.parse_registration({"events": "nonsense"}))


class TheCachePolicy(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.path = pathlib.Path(self.directory.name) / "rdap.json"
        self.asked: list[str] = []

    def tearDown(self):
        self.directory.cleanup()

    def query(self, answers: dict):
        def ask(domain):
            self.asked.append(domain)
            answer = answers.get(domain)
            if isinstance(answer, BaseException):
                raise answer
            return answer
        return ask

    def run_lookup(self, companies, answers, **kwargs):
        return rdap.lookup(companies, cache_path=self.path, query=self.query(answers), now=lambda: NOW, **kwargs)

    def write(self, entries):
        self.path.write_text(json.dumps(entries), encoding="utf-8")

    def test_a_found_date_is_returned_and_cached(self):
        found = self.run_lookup([company("fabheads", "https://www.fabheads.in")], {"fabheads.in": "2015-06-11"})
        self.assertEqual(found, {"fabheads": "2015-06-11"})
        entry = json.loads(self.path.read_text())["fabheads.in"]
        self.assertEqual(entry["registered"], "2015-06-11")
        self.assertEqual(datetime.datetime.fromisoformat(entry["checked"]), NOW)

    def test_a_cached_date_is_never_asked_again(self):
        self.write({"fabheads.in": {"registered": "2015-06-11", "checked": "2020-01-01T00:00:00+00:00"}})
        found = self.run_lookup([company("fabheads", "https://fabheads.in")], {})
        self.assertEqual(found, {"fabheads": "2015-06-11"})
        self.assertEqual(self.asked, [])

    def test_a_null_is_asked_again_only_after_thirty_days(self):
        recent = (NOW - datetime.timedelta(days=29)).isoformat()
        old = (NOW - datetime.timedelta(days=31)).isoformat()
        self.write({
            "recent.in": {"registered": None, "checked": recent},
            "old.in": {"registered": None, "checked": old},
        })
        found = self.run_lookup([company("a", "https://recent.in"), company("b", "https://old.in")], {"old.in": "2019-02-17"})
        self.assertEqual(self.asked, ["old.in"])
        self.assertEqual(found, {"b": "2019-02-17"})

    def test_a_failed_lookup_is_cached_as_null_and_does_not_raise(self):
        found = self.run_lookup([company("a", "https://broken.in"), company("b", "https://fine.in")],
                                {"broken.in": RuntimeError("registry fell over"), "fine.in": "2022-06-21"})
        self.assertEqual(found, {"b": "2022-06-21"})
        cache = json.loads(self.path.read_text())
        self.assertIsNone(cache["broken.in"]["registered"])

    def test_rate_limiting_stops_the_run_without_caching_a_null(self):
        found = self.run_lookup([company("a", "https://a.in"), company("b", "https://b.in")],
                                {"a.in": rdap.RateLimited("a.in"), "b.in": "2020-01-01"})
        self.assertEqual(found, {})
        self.assertEqual(self.asked, ["a.in"])
        self.assertFalse(self.path.exists())

    def test_only_verified_websites_are_asked(self):
        companies = [
            company("v", "https://verified.in", "verified"),
            company("a", "https://associated.in", "associated"),
            company("d", "https://discovered.in", "discovered"),
            company("n", "https://unknown.in", None),
            company("w", None, "verified"),
            company("p", "https://www.linkedin.com/company/x", "verified"),
            company("g", "https://someone.github.io", "verified"),
        ]
        self.run_lookup(companies, {})
        self.assertEqual(self.asked, ["verified.in"])

    def test_companies_sharing_a_domain_share_one_request(self):
        found = self.run_lookup([company("a", "https://www.same.co.in"), company("b", "http://shop.same.co.in")],
                                {"same.co.in": "2018-02-20"})
        self.assertEqual(self.asked, ["same.co.in"])
        self.assertEqual(found, {"a": "2018-02-20", "b": "2018-02-20"})

    def test_a_spent_time_budget_asks_nothing_more(self):
        found = self.run_lookup([company("a", "https://a.in"), company("b", "https://b.in")],
                                {"a.in": "2020-01-01", "b.in": "2021-01-01"}, max_seconds=0)
        self.assertEqual(self.asked, [])
        self.assertEqual(found, {})

    def test_every_answer_is_written_as_it_arrives(self):
        written: list[set[str]] = []

        def ask(domain):
            if self.path.exists():
                written.append(set(json.loads(self.path.read_text())))
            return "2020-01-01"

        rdap.lookup([company("a", "https://a.in"), company("b", "https://b.in")],
                    cache_path=self.path, query=ask, now=lambda: NOW)
        self.assertEqual(written, [{"a.in"}])

    def test_a_corrupt_cache_is_an_empty_one(self):
        self.path.write_text("{not json", encoding="utf-8")
        found = self.run_lookup([company("a", "https://a.in")], {"a.in": "2020-01-01"})
        self.assertEqual(found, {"a": "2020-01-01"})

    def test_never_asked_domains_go_before_stale_nulls(self):
        self.write({"stale.in": {"registered": None, "checked": "2020-01-01T00:00:00+00:00"}})
        self.run_lookup([company("s", "https://stale.in"), company("z", "https://zzz-new.in")], {})
        self.assertEqual(self.asked, ["zzz-new.in", "stale.in"])


class NeedsAsking(unittest.TestCase):
    def test_policy(self):
        self.assertTrue(rdap.needs_asking(None, NOW))
        self.assertFalse(rdap.needs_asking({"registered": "2010-03-16", "checked": "2000-01-01T00:00:00"}, NOW))
        self.assertTrue(rdap.needs_asking({"registered": None, "checked": "garbage"}, NOW))
        self.assertTrue(rdap.needs_asking({"registered": None, "checked": "2026-08-01T00:00:00"}, NOW))
        self.assertFalse(rdap.needs_asking({"registered": None, "checked": "2026-09-01T00:00:00"}, NOW))


if __name__ == "__main__":
    unittest.main()
