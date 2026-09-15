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

    def test_a_two_word_brand_is_not_a_person_when_the_source_names_someone_else(self):
        self.assertEqual(entity.assess("Zerocircle Alternatives", {"venture-center"}, founders="Neha Jain"), (entity.UNVERIFIED, entity.BRAND_NOTE))
        self.assertEqual(entity.assess("Maini Renewables", {"venture-center"}, founders="Swati Maini")[0], entity.UNVERIFIED)
        self.assertEqual(entity.assess("Global Talent Manufacturing", {"sine-iitb"}, founders="Bhanu Pratap Singh")[0], entity.UNVERIFIED)

    def test_a_person_named_among_the_founders_is_still_a_persons_project(self):
        self.assertEqual(entity.assess("Chaithra Arun", {"sine-iitb"}, founders="Chaithra G, Naveen Gopal Krishna")[0], entity.RESEARCHER_PROJECT)
        self.assertEqual(entity.assess("Nidhi Pandey", {"sine-iitb"}, founders="Nidhi Pandey,Prof. Jayesh Bellare")[0], entity.RESEARCHER_PROJECT)

    def test_without_founders_only_a_source_that_lists_people_is_believed(self):
        self.assertEqual(entity.assess("General Aeronautics", {"fsid-iisc"})[0], entity.UNVERIFIED)
        self.assertEqual(entity.assess("Open Water", {"fsid-iisc"})[0], entity.UNVERIFIED)

    def test_a_project_name_with_no_entity_behind_it_is_unverified(self):
        for name in ("GAZE", "Plasmo-Sense", "Nirvaan", "Macvisys"):
            self.assertEqual(entity.assess(name, {"sine-iitb"})[0], entity.UNVERIFIED, name)

    def test_a_legal_suffix_or_a_dpiit_recognition_makes_a_company(self):
        self.assertEqual(entity.assess("Planys Technologies Private Limited", {"rtbi-iitm"})[0], entity.COMPANY)
        self.assertEqual(entity.assess("Tavisha Robotics", {"dpiit-startup-india"}, "recognised")[0], entity.COMPANY)
        # Whichever source got there first: a SINE listing does not undo a recognition.
        self.assertEqual(entity.assess("Still Up", {"sine-iitb", "dpiit-startup-india"}, "recognised")[0], entity.COMPANY)
        # A lapsed recognition was still granted, so the company was incorporated.
        self.assertEqual(entity.assess("Tavisha Robotics", {"dpiit-startup-india"}, "expired")[0], entity.COMPANY)

    def test_a_startup_india_profile_without_a_recognition_is_not_proof_of_a_company(self):
        self.assertEqual(entity.assess("TATVA CORE", {"dpiit-startup-india"}, "profile")[0], entity.UNVERIFIED)
        self.assertEqual(entity.assess("TATVA CORE", {"dpiit-startup-india"}, "pending")[0], entity.UNVERIFIED)
        self.assertEqual(entity.assess("TATVA CORE", {"dpiit-startup-india"})[0], entity.UNVERIFIED)
        # A profile under a name that reads like a person's is still a startup's profile.
        self.assertEqual(entity.assess("Delta Nanoventions", {"dpiit-startup-india"}, "profile"), (entity.UNVERIFIED, entity.PROFILE_NOTE))

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

    def test_an_off_map_project_keeps_its_old_answer_and_a_placed_one_is_asked_again(self):
        # 53 SINE records became non-companies; 34 of them were never placed. Their
        # reasons appear on no page, so re-buying them to change a word is waste.
        person = Company(id="p", name="Imran Hussain", description="NAAT device", source="sine-iitb", entity_type=entity.RESEARCHER_PROJECT)
        old_key = classify._fingerprint(person, with_entity=False)
        off_map = {"hash": old_key, "sector_id": "4", "subsector_id": None, "note": "The company builds..."}
        placed = {"hash": old_key, "sector_id": "4", "subsector_id": "4.5", "note": "The company builds..."}
        self.assertTrue(classify._answered_before_entity_types(person, off_map))
        self.assertFalse(classify._answered_before_entity_types(person, placed))
        # And a company never takes this path, whatever its cache says.
        company = Company(id="c", name="Acme Pvt Ltd", description="x", source="sine-iitb", entity_type=entity.COMPANY)
        self.assertFalse(classify._answered_before_entity_types(company, off_map))

    def test_a_placed_register_profile_keeps_its_answer_when_only_its_entity_type_changed(self):
        profile = Company(
            id="tatva-core", name="TATVA CORE", description="DPIIT-recognised startup. Industry: Robotics.", source="dpiit-startup-india",
            description_is_label=True, entity_type=entity.UNVERIFIED,
        )
        placed = {"hash": classify._fingerprint(profile, with_entity=False), "sector_id": "2", "subsector_id": "2.7", "note": "The company builds robots."}
        self.assertTrue(classify._answered_before_entity_types(profile, placed))


    def test_a_brand_once_read_as_a_person_keeps_its_placed_answer(self):
        brand = Company(id="zerocircle", name="Zerocircle Alternatives", description="Seaweed packaging", source="venture-center", entity_type=entity.UNVERIFIED)
        as_person = Company(id="zerocircle", name="Zerocircle Alternatives", description="Seaweed packaging", source="venture-center", entity_type=entity.RESEARCHER_PROJECT)
        placed = {"hash": classify._fingerprint(as_person), "sector_id": "1", "subsector_id": "1.9", "note": "The project makes packaging."}
        self.assertTrue(classify._answered_before_entity_types(brand, placed))
        # A different description is a different question, whatever the type.
        brand.description = "Seaweed packaging and films"
        self.assertFalse(classify._answered_before_entity_types(brand, placed))


class AStateForACity(unittest.TestCase):
    def test_the_cities_the_grants_lists_print_have_states_and_nothing_else_is_guessed(self):
        from ingest import places

        self.assertEqual(places.state_for(" Bangalore "), "Karnataka")
        self.assertEqual(places.state_for("Jammu, J & K"), "Jammu and Kashmir")
        self.assertIsNone(places.state_for("Shell, Tricon Buildwell"))
        self.assertIsNone(places.state_for(None))

    def test_one_place_has_one_spelling_and_a_district_of_many_towns_is_left_alone(self):
        from ingest import places

        self.assertEqual({places.place_name(c) for c in ["Bangalore", "Bengaluru", " Bengaluru Urban "]}, {"Bengaluru"})
        self.assertEqual(places.place_name("Bengaluru Rural"), "Bengaluru Rural")
        self.assertEqual(places.place_name("Mumbai Suburban"), "Mumbai")
        self.assertEqual(places.place_name("South Eastdelhi"), "South East Delhi")
        self.assertEqual(places.place_name("Ernakulam"), "Ernakulam")
        # A state where a city belongs is not a place of its own.
        self.assertIsNone(places.place_name("Jharkhand"))
        self.assertIsNone(places.place_name("  "))
        # The state is still found from a spelling that is folded away.
        self.assertEqual(places.state_for(places.place_name("Bhubaneshwar")), "Odisha")


class ANameAsThePagePrintsIt(unittest.TestCase):
    def test_a_register_name_in_capitals_is_recased_and_a_company_spelling_is_not(self):
        from ingest.names import display

        self.assertEqual(display("GIGATON RESEARCH PRIVATE LIMITED"), "Gigaton Research Private Limited")
        self.assertEqual(display("NCF GREEN ENERGY PRIVATE LIMITED"), "NCF Green Energy Private Limited")
        self.assertEqual(display("AAYUSHI SOLAR ENERGY (OPC) PRIVATE LIMITED"), "Aayushi Solar Energy (OPC) Private Limited")
        self.assertEqual(display("D-RUBE LABS AND RESEARCH PRIVATE LIMITED"), "D-Rube Labs and Research Private Limited")
        self.assertEqual(display("2D MATX PRIVATE LIMITED"), "2D Matx Private Limited")
        self.assertEqual(display("BIKE SPA INTERNATIONAL PVT LTD"), "Bike Spa International Pvt Ltd")
        self.assertEqual(display("A R SHAKTI BIOFUELS"), "A R Shakti Biofuels")
        # Any lower-case letter means the source already cased it: the company's own.
        self.assertEqual(display("KaviRISE Technologies Pvt Ltd"), "KaviRISE Technologies Pvt Ltd")
        self.assertEqual(display("MANI Aerospace"), "MANI Aerospace")


if __name__ == "__main__":
    unittest.main()


class MergingCopies(unittest.TestCase):
    def test_a_real_description_from_any_source_beats_the_owners_label(self):
        from ingest import run
        from ingest.sources.base import Company

        label = Company(id="relsym", name="RELSYM", description="DPIIT-recognised startup. Industry: Nanotechnology.", description_is_label=True, source="dpiit-startup-india")
        real = Company(id="relsym", name="Relsym Solutions", description="Printable nanomaterial inks.", source="sine-iitb")
        self.assertTrue(run._is_label_or_empty(label))
        self.assertFalse(run._is_label_or_empty(real))


class HoldingASourcesBacklog(unittest.TestCase):
    def test_a_held_source_is_not_asked_unless_chosen_and_others_always_are(self):
        from ingest import run

        held = Company(id="satlabs", name="Satlabs Space Systems", description="A data relay constellation", source="nmicps-tih")
        other = Company(id="acme", name="Acme Pvt Ltd", description="Robots", source="sine-iitb")
        self.assertFalse(run.may_ask(held, frozenset()))
        self.assertTrue(run.may_ask(held, frozenset({"satlabs"})))
        self.assertTrue(run.may_ask(other, frozenset()))

    def test_a_held_company_already_answered_keeps_its_answer_and_is_never_charged(self):
        import tempfile, pathlib, json as _json
        from unittest import mock

        company = Company(id="satlabs", name="Satlabs Space Systems", description="A data relay constellation", source="nmicps-tih")
        fresh = Company(id="new-hub-co", name="New Hub Co", description="Drones for farms", source="nmicps-tih")
        entry = {"hash": classify._fingerprint(company), "sector_id": "2", "subsector_id": "2.5", "project_type": None, "note": "x", "missing": None, "name": company.name, "model": classify.MODEL, "classified_at": "2026-09-15"}
        with tempfile.TemporaryDirectory() as directory:
            cache = pathlib.Path(directory) / "classify.json"
            cache.write_text(_json.dumps({"satlabs": entry}))
            with mock.patch.object(classify, "CACHE_PATH", cache), mock.patch.object(classify, "OVERRIDES_PATH", pathlib.Path(directory) / "none.json"):
                results, usage = classify.classify([company, fresh], cost_limit=0.0, batch=False, may_ask=lambda c: False)
        self.assertEqual(results["satlabs"].subsector_id, "2.5")
        self.assertNotIn("new-hub-co", results)
        self.assertEqual((usage.cached, usage.held, usage.calls), (1, 1, 0))
