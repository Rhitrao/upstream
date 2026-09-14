"""A register label places a company only where it names the sub-sector.

    python3 -m unittest discover -s ingest/tests -t .
"""

from __future__ import annotations

import unittest

from ingest import classify, register_labels, run
from ingest.gaps import NO_GAP_NAMED
from ingest.sources import dpiit
from ingest.sources.base import Company
from ingest.taxonomy import SUBSECTORS


def label(industry: str, sectors: list[str], stage: str = "Prototype") -> str:
    # Written by the scraper's own function, so a change to its wording breaks this test
    # rather than silently turning every label into one that supports nothing.
    return dpiit._description({"sectors": sectors, "stages": [stage]}, industry)


class WhatALabelNames(unittest.TestCase):
    def test_nlp_is_not_healthcare(self):
        # ZELBYX, CAMPSUM, URBISAGE, MENULA, CAFIYN: all in 3.2 on 14 September 2026.
        description = label("AI", ["NLP"])
        self.assertFalse(register_labels.supports(description, "3.2"))
        self.assertEqual(register_labels.supported(description), frozenset())

    def test_a_label_that_names_the_field_supports_it(self):
        self.assertTrue(register_labels.supports(label("Aeronautics Aerospace & Defence", ["Space Technology"]), "2.5"))
        self.assertTrue(register_labels.supports(label("Technology Hardware", ["Electronics"]), "2.2"))
        self.assertTrue(register_labels.supports(label("Robotics", ["Robotics Technology"]), "2.7"))
        self.assertTrue(register_labels.supports(label("Nanotechnology", []), "2.6"))

    def test_a_customer_or_a_method_supports_nothing(self):
        self.assertFalse(register_labels.supports(label("Internet of Things", ["Manufacturing & Warehouse"]), "2.3"))
        self.assertFalse(register_labels.supports(label("Aeronautics Aerospace & Defence", ["Drones"]), "2.7"))
        self.assertFalse(register_labels.supports(label("Computer Vision", []), "3.1"))
        # Tissue paper is not tissue engineering.
        self.assertFalse(register_labels.supports(label("Technology Hardware", ["Manufacturing"]), "4.6"))

    def test_several_sectors_are_read(self):
        description = label("Technology Hardware", ["Semiconductor", "3d printing"])
        self.assertEqual(register_labels.supported(description), frozenset({"2.2", "2.3", "2.6"}))

    def test_every_entry_names_a_real_sub_sector(self):
        real = {s["subsector_id"] for s in SUBSECTORS}
        for name, ids in register_labels.SUPPORTS.items():
            self.assertTrue(ids <= real, name)
            self.assertNotIn(name, register_labels.NAMES_NOTHING, name)

    def test_an_unread_label_supports_nothing(self):
        self.assertFalse(register_labels.supports(label("Quantum Computing", ["Qubits"]), "2.1"))


class WithholdingAGuess(unittest.TestCase):
    def company(self, cid: str, description: str) -> Company:
        return Company(id=cid, name=cid, description=description, description_is_label=True)

    def test_an_unsupported_placement_becomes_a_gap_filed_as_too_thin(self):
        nlp = self.company("zelbyx", label("AI", ["NLP"]))
        space = self.company("spaceock", label("Aeronautics Aerospace & Defence", ["Space Technology"]))
        results = {
            "zelbyx": classify.Classification(sector_id="3", subsector_id="3.2", project_type="NLP for records", note="n"),
            "spaceock": classify.Classification(sector_id="2", subsector_id="2.5", note="n"),
        }

        withheld = run.withhold_label_guesses(results, {"zelbyx": nlp, "spaceock": space})

        self.assertEqual(withheld, 1)
        self.assertFalse(results["zelbyx"].on_map)
        self.assertIsNone(results["zelbyx"].project_type)
        self.assertEqual(results["spaceock"].subsector_id, "2.5")
        gap = run.gap(nlp, results["zelbyx"])
        self.assertEqual(gap["missing"], NO_GAP_NAMED)
        self.assertIn("do not name 3.2 AI in Healthcare", gap["note"])

    def test_a_company_not_in_the_label_only_set_is_left_alone(self):
        results = {"described": classify.Classification(sector_id="3", subsector_id="3.2", note="n")}
        self.assertEqual(run.withhold_label_guesses(results, {}), 0)
        self.assertTrue(results["described"].on_map)


class SweepingRowsTheRunDidNotSend(unittest.TestCase):
    def row(self, cid: str, description: str, subsector_id: str, basis: str = "register-label") -> dict:
        return {"id": cid, "name": cid.upper(), "description": description, "sector_id": subsector_id.split(".")[0],
                "subsector_id": subsector_id, "classify_basis": basis}

    def test_a_row_out_of_the_scrape_window_is_judged_by_the_same_table(self):
        # ZELBYX was placed in 3.2 on 14 September 2026 and had left the register's window
        # by that night, so the rule that withdrew 154 others never saw it.
        rows = [
            self.row("zelbyx-technology", label("AI", ["NLP"]), "3.2"),
            self.row("kailash-cosmos", label("Aeronautics Aerospace & Defence", ["Space Technology"]), "2.5"),
        ]
        gaps = run.stale_label_guesses(rows, sent=set())
        self.assertEqual([g["company_id"] for g in gaps], ["zelbyx-technology"])
        self.assertEqual(gaps[0]["missing"], NO_GAP_NAMED)
        self.assertIn("do not name 3.2 AI in Healthcare", gaps[0]["note"])

    def test_a_row_this_run_sent_was_already_judged(self):
        rows = [self.row("zelbyx-technology", label("AI", ["NLP"]), "3.2")]
        self.assertEqual(run.stale_label_guesses(rows, sent={"zelbyx-technology"}), [])

    def test_a_described_row_is_left_alone(self):
        # Rechargion: in the register, and described by Venture Center.
        rows = [
            self.row("rechargion-energy", "Rechargeable batteries based on sodium ion.", "1.4"),
            self.row("described", label("AI", ["NLP"]), "3.2", basis="description"),
        ]
        self.assertEqual(run.stale_label_guesses(rows, sent=set()), [])


if __name__ == "__main__":
    unittest.main()
