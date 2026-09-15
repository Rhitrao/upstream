"""A homepage's first archived copy is asked once, a failed request is not an answer, and nothing fails a run.

    python3 -m unittest discover -s ingest/tests -t .

No test here touches the network: lookup() takes the query, the clock and the cache path.
"""

from __future__ import annotations

import datetime
import json
import pathlib
import tempfile
import types
import unittest

from ingest import wayback

NOW = datetime.datetime(2026, 9, 15, 12, 0, tzinfo=datetime.UTC)


def company(id: str, website: str | None, identity: str | None = "verified"):
    return types.SimpleNamespace(id=id, website=website, website_identity=identity)


class ReadingTheIndex(unittest.TestCase):
    def test_the_first_capture_is_the_date(self):
        rows = [["timestamp", "statuscode"], ["20231120190632", "302"]]
        self.assertEqual(wayback.parse_first_capture(rows), ("2023-11-20", wayback.CAPTURED))

    def test_an_empty_index_is_not_archived(self):
        self.assertEqual(wayback.parse_first_capture([]), (None, wayback.NOT_ARCHIVED))
        self.assertEqual(wayback.parse_first_capture([["timestamp", "statuscode"]]), (None, wayback.NOT_ARCHIVED))

    def test_a_malformed_answer_is_an_error_not_an_absence(self):
        self.assertEqual(wayback.parse_first_capture({"error": "x"}), (None, wayback.ERROR))
        self.assertEqual(wayback.parse_first_capture([["yesterday", "200"]]), (None, wayback.ERROR))
        self.assertEqual(wayback.parse_first_capture([["20231340000000", "200"]]), (None, wayback.ERROR))


class TheCachePolicy(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.path = pathlib.Path(self.directory.name) / "wayback.json"
        self.asked: list[str] = []

    def tearDown(self):
        self.directory.cleanup()

    def query(self, answers: dict):
        def ask(domain):
            self.asked.append(domain)
            answer = answers.get(domain, (None, wayback.NOT_ARCHIVED))
            if isinstance(answer, BaseException):
                raise answer
            return answer
        return ask

    def run_lookup(self, companies, answers, **kwargs):
        return wayback.lookup(companies, cache_path=self.path, query=self.query(answers), now=lambda: NOW, **kwargs)

    def write(self, entries):
        self.path.write_text(json.dumps(entries), encoding="utf-8")

    def cache(self):
        return json.loads(self.path.read_text())

    def test_a_capture_is_returned_cached_and_never_asked_again(self):
        found = self.run_lookup([company("relsym", "https://www.relsym.com")], {"relsym.com": ("2023-11-20", wayback.CAPTURED)})
        self.assertEqual(found, {"relsym": "2023-11-20"})
        self.assertEqual(self.cache()["relsym.com"]["outcome"], wayback.CAPTURED)
        self.asked.clear()
        self.assertEqual(self.run_lookup([company("relsym", "https://relsym.com")], {}), {"relsym": "2023-11-20"})
        self.assertEqual(self.asked, [])

    def test_not_archived_is_asked_again_only_after_thirty_days(self):
        self.write({
            "recent.in": {"first_capture": None, "outcome": "not-archived", "checked": (NOW - datetime.timedelta(days=29)).isoformat()},
            "old.in": {"first_capture": None, "outcome": "not-archived", "checked": (NOW - datetime.timedelta(days=31)).isoformat()},
        })
        found = self.run_lookup([company("a", "https://recent.in"), company("b", "https://old.in")], {"old.in": ("2025-01-02", wayback.CAPTURED)})
        self.assertEqual(self.asked, ["old.in"])
        self.assertEqual(found, {"b": "2025-01-02"})

    def test_a_failed_request_is_kept_as_what_happened_and_asked_again_next_run(self):
        self.run_lookup([company("a", "https://slow.in"), company("b", "https://down.in")],
                        {"slow.in": (None, wayback.TIMEOUT), "down.in": (None, wayback.UNAVAILABLE)})
        self.assertEqual(self.cache()["slow.in"]["outcome"], wayback.TIMEOUT)
        self.assertEqual(self.cache()["down.in"]["outcome"], wayback.UNAVAILABLE)
        self.asked.clear()
        self.run_lookup([company("a", "https://slow.in"), company("b", "https://down.in")], {})
        self.assertEqual(sorted(self.asked), ["down.in", "slow.in"])

    def test_a_failure_does_not_overwrite_an_earlier_empty_index(self):
        self.write({"x.in": {"first_capture": None, "outcome": "not-archived", "checked": (NOW - datetime.timedelta(days=40)).isoformat()}})
        self.run_lookup([company("x", "https://x.in")], {"x.in": (None, wayback.TIMEOUT)})
        entry = self.cache()["x.in"]
        self.assertEqual(entry["outcome"], wayback.NOT_ARCHIVED)
        self.assertEqual(entry["last_failure"], wayback.TIMEOUT)

    def test_an_exception_is_one_error_and_does_not_raise(self):
        found = self.run_lookup([company("a", "https://broken.in"), company("b", "https://fine.in")],
                                {"broken.in": RuntimeError("archive fell over"), "fine.in": ("2022-06-21", wayback.CAPTURED)})
        self.assertEqual(found, {"b": "2022-06-21"})
        self.assertEqual(self.cache()["broken.in"]["outcome"], wayback.ERROR)

    def test_rate_limiting_stops_the_run_without_caching_anything(self):
        found = self.run_lookup([company("a", "https://a.in"), company("b", "https://b.in")],
                                {"a.in": wayback.RateLimited("a.in"), "b.in": ("2020-01-01", wayback.CAPTURED)})
        self.assertEqual(found, {})
        self.assertEqual(self.asked, ["a.in"])
        self.assertFalse(self.path.exists())

    def test_only_verified_own_domains_are_asked(self):
        companies = [
            company("v", "https://verified.in", "verified"),
            company("a", "https://associated.in", "associated"),
            company("d", "https://discovered.in", None),
            company("h", "https://someone.github.io", "verified"),
            company("l", "https://www.linkedin.com/company/x", "verified"),
        ]
        self.run_lookup(companies, {})
        self.assertEqual(self.asked, ["verified.in"])

    def test_companies_sharing_a_domain_share_one_question(self):
        found = self.run_lookup([company("a", "https://www.arc.in"), company("b", "https://arc.in/about")], {"arc.in": ("2021-05-05", wayback.CAPTURED)})
        self.assertEqual(self.asked, ["arc.in"])
        self.assertEqual(found, {"a": "2021-05-05", "b": "2021-05-05"})

    def test_never_asked_domains_go_before_failed_and_stale_ones(self):
        self.write({
            "failed.in": {"first_capture": None, "outcome": "timeout", "checked": NOW.isoformat()},
            "stale.in": {"first_capture": None, "outcome": "not-archived", "checked": (NOW - datetime.timedelta(days=60)).isoformat()},
        })
        self.run_lookup([company("s", "https://stale.in"), company("f", "https://failed.in"), company("n", "https://new.in")], {})
        self.assertEqual(self.asked, ["new.in", "failed.in", "stale.in"])


if __name__ == "__main__":
    unittest.main()
