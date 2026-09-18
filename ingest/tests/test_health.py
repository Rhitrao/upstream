"""A scraper returning nothing must never look like a quiet day.

    python3 -m unittest discover -s ingest/tests -t .
"""

from __future__ import annotations

import types
import unittest
from unittest import mock

from ingest import health, run
from ingest.sources import base


class JudgingARun(unittest.TestCase):
    def test_zero_records_is_quarantined_with_or_without_history(self):
        self.assertEqual(health.judge("dpiit-startup-india", 0, None).status, health.QUARANTINED)
        self.assertEqual(health.judge("dpiit-startup-india", 0, 330).status, health.QUARANTINED)

    def test_a_sharp_drop_against_the_last_good_run_is_quarantined(self):
        verdict = health.judge("dpiit-startup-india", 120, 330)
        self.assertEqual(verdict.status, health.QUARANTINED)
        self.assertIn("120 records against 330", verdict.reason)

    def test_growth_a_small_dip_and_a_first_run_are_all_fine(self):
        self.assertEqual(health.judge("sine-iitb", 240, 233).status, health.OK)
        self.assertEqual(health.judge("sine-iitb", 200, 233).status, health.OK)
        self.assertEqual(health.judge("venture-center", 142, None).status, health.OK)

    def test_a_failure_says_why(self):
        verdict = health.failed("dpiit-startup-india", "HTTPError: 403 Client Error: Forbidden")
        self.assertEqual((verdict.status, verdict.records), (health.FAILED, 0))
        self.assertIn("403", verdict.payload()["reason"])


class ScrapingRecordsWhatHappened(unittest.TestCase):
    def test_a_raising_scraper_is_named_with_its_error_and_the_rest_carry_on(self):
        def blocked():
            raise RuntimeError("403 Forbidden")

        def fine():
            base.FETCHED_AT.append("2026-09-01T00:00:00+00:00")
            base.FETCHED_AT.append("2026-09-13T00:00:00+00:00")
            return [base.Company(id="a", name="A")], []

        sources = [types.SimpleNamespace(SOURCE="dpiit-startup-india", scrape=blocked), types.SimpleNamespace(SOURCE="sine-iitb", scrape=fine)]
        with mock.patch.object(run, "SOURCES", sources), mock.patch("traceback.print_exc"):
            companies, _, failed, as_of = run.scrape_all()

        self.assertEqual(list(companies), ["sine-iitb"])
        self.assertIn("403 Forbidden", failed["dpiit-startup-india"])
        # As old as its stalest page, not as new as the run.
        self.assertEqual(as_of["sine-iitb"], "2026-09-01T00:00:00+00:00")


if __name__ == "__main__":
    unittest.main()


class ExpectedFailures(unittest.TestCase):
    """A red run has to mean something new, or nobody reads it."""

    def test_a_known_blocked_source_failing_to_connect_does_not_alarm(self):
        verdict = health.failed("nmicps-tih", "ConnectTimeout: nmicpsbck.nmicps.gov.in timed out")
        self.assertTrue(health.expected(verdict))
        self.assertEqual(health.alarming([verdict]), [])

    def test_it_is_still_set_aside_and_recorded_as_failed(self):
        verdict = health.failed("nmicps-tih", "ConnectTimeout")
        self.assertEqual(verdict.status, health.FAILED)
        self.assertEqual(verdict.payload()["status"], "failed")

    def test_the_same_source_answering_with_nothing_is_a_new_fault(self):
        verdict = health.judge("nmicps-tih", 0, None)
        self.assertFalse(health.expected(verdict))
        self.assertEqual(health.alarming([verdict]), [verdict])

    def test_a_source_that_normally_works_still_alarms_beside_an_expected_one(self):
        blocked = health.failed("nmicps-tih", "ConnectTimeout")
        broken = health.failed("rtbi-iitm", "ValueError: no portfolio blocks")
        self.assertEqual(health.alarming([blocked, broken]), [broken])
