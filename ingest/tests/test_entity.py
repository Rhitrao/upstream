"""People and projects are not companies, and nothing re-buys a company to say so.

    python3 -m unittest discover -s ingest/tests -t .
"""

from __future__ import annotations

import unittest

from ingest import classify, entity
from ingest.sources.base import Company


class WhatARecordIs(unittest.TestCase):
    def test_a_person_listed_for_a_funded_project_is_not_a_company(self):
        for name in ("Aishwarya Dasare", "Hariharan Sekar", "Priyanka Yasaslapu"):
            self.assertEqual(entity.assess(name, {"sine-iitb"})[0], entity.RESEARCHER_PROJECT, name)

    def test_a_project_name_with_no_entity_behind_it_is_unverified(self):
        for name in ("GAZE", "Plasmo-Sense", "Nirvaan", "Macvisys"):
            self.assertEqual(entity.assess(name, {"sine-iitb"})[0], entity.UNVERIFIED, name)

    def test_a_legal_suffix_or_a_dpiit_recognition_makes_a_company(self):
        self.assertEqual(entity.assess("Planys Technologies Private Limited", {"rtbi-iitm"})[0], entity.COMPANY)
        self.assertEqual(entity.assess("Tavisha Robotics", {"dpiit-startup-india"})[0], entity.COMPANY)
        # Whichever source got there first: a SINE listing does not undo a recognition.
        self.assertEqual(entity.assess("Still Up", {"sine-iitb", "dpiit-startup-india"})[0], entity.COMPANY)

    def test_a_business_word_is_never_read_as_a_surname(self):
        self.assertFalse(entity.looks_like_a_person("Exovian Robotics"))
        self.assertFalse(entity.looks_like_a_person("Delta Nanoventions Labs"))


class TheClassifierIsToldAndOnlyTheyRerun(unittest.TestCase):
    def test_a_project_is_described_as_one_in_the_question(self):
        project = Company(id="aishwarya-dasare", name="Aishwarya Dasare", description="Plant protein from oil cake", entity_type=entity.RESEARCHER_PROJECT)
        text = classify._company_text(project)
        self.assertIn('never "the company"', text)
        self.assertNotIn("Company:", text)

    def test_every_company_keeps_the_cache_key_it_was_bought_under(self):
        company = Company(id="planys", name="Planys Technologies Private Limited", description="Underwater robots", source="rtbi-iitm")
        before = classify._fingerprint(company)
        company.entity_type = entity.COMPANY
        self.assertEqual(classify._fingerprint(company), before)
        self.assertEqual(classify._company_text(company), "Company: Planys Technologies Private Limited\nWhat they do: Underwater robots")


if __name__ == "__main__":
    unittest.main()
