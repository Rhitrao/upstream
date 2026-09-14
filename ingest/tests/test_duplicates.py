"""One company listed twice becomes one id before anything is classified or sent.

    python3 -m unittest discover -s ingest/tests -t .
"""

from __future__ import annotations

import unittest

from ingest import duplicates
from ingest.sources.base import Company, Signal, slugify


def named(name: str) -> Company:
    return Company.named(name)


class SameNameOnceTheBoilerplateIsGone(unittest.TestCase):
    def test_the_two_pairs_found_on_14_september(self):
        found = duplicates.merges([named("Call X Ringers Pvt Ltd"), named("CallX Ringers"),
                                   named("Cancrie Private Limited"), named("Cancrie Inc.")], hand={})
        self.assertEqual(found, {"callx-ringers": "call-x-ringers", "cancrie-inc": "cancrie"})

    def test_a_shared_word_is_not_a_shared_name(self):
        self.assertEqual(duplicates.merges([named("Ayati Devices"), named("Ayu Devices"),
                                            named("MRobotics"), named("UmaRobotics")], hand={}), {})

    def test_the_survivor_does_not_depend_on_scrape_order(self):
        a, b = named("CallX Ringers"), named("Call X Ringers Pvt Ltd")
        self.assertEqual(duplicates.merges([a, b], hand={}), duplicates.merges([b, a], hand={}))

    def test_inc_never_changes_an_id(self):
        # Only the comparison key drops it; ids are what every stored row is keyed by.
        self.assertEqual(slugify("Cancrie Inc."), "cancrie-inc")


class HandReadAliases(unittest.TestCase):
    def test_every_alias_says_why_and_points_somewhere_else(self):
        import json
        for alias, entry in json.loads(duplicates.ALIASES_PATH.read_text()).items():
            self.assertTrue(entry["why"].strip(), alias)
            self.assertNotEqual(alias, entry["into"])

    def test_chains_resolve_to_the_last_row(self):
        found = duplicates.merges([named("Byline Medtch Pvt Ltd")], hand={"byline-medtch": "bylin-medtech", "bylin-medtech": "bylin"})
        self.assertEqual(found, {"byline-medtch": "bylin", "bylin-medtech": "bylin"})


class Applying(unittest.TestCase):
    def test_copies_and_traces_move_and_a_source_sends_each_company_once(self):
        vc = [named("Call X Ringers Pvt Ltd"), named("CallX Ringers")]
        signals = {"venture-center": [Signal(company_id="callx-ringers", type="incubator", label="Venture Center portfolio")]}
        by_source = {"venture-center": vc}
        duplicates.apply(by_source, signals, {"callx-ringers": "call-x-ringers"})
        self.assertEqual([c.id for c in by_source["venture-center"]], ["call-x-ringers"])
        self.assertEqual(signals["venture-center"][0].company_id, "call-x-ringers")


class AMergedCompanyIsNotBoughtAgain(unittest.TestCase):
    def test_an_answer_filed_under_the_other_spelling_is_found_by_what_was_asked(self):
        from unittest import mock
        from ingest import classify

        # Bylin: SINE's copy was classified as byline-medtch; after the merge the same
        # copy arrives as bylin-medtech, whose own entry is the grant copy's answer.
        sine = Company(id="bylin-medtech", name="Byline Medtch Pvt Ltd", description="Oral bio-patch.", source="sine-iitb")
        other = Company(id="bylin-medtech", name="Bylin Medtech Pvt. Ltd.", description="Dry mouth.", source="grants-csv")
        cache = {
            "byline-medtch": {"hash": classify._fingerprint(sine), "sector_id": "4", "subsector_id": "4.5", "note": "n"},
            "bylin-medtech": {"hash": classify._fingerprint(other), "sector_id": "4", "subsector_id": "4.6", "note": "n"},
        }
        with mock.patch.object(classify, "_load", side_effect=lambda path: cache if path == classify.CACHE_PATH else {}):
            results, usage = classify.classify([sine], cost_limit=0.0)
        self.assertEqual(results["bylin-medtech"].subsector_id, "4.5")
        self.assertEqual(usage.cached, 1)


if __name__ == "__main__":
    unittest.main()
