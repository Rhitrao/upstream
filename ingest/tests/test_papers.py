"""The join between a company's name and a paper's affiliation, which is where papers.py
can put a stranger's work on a company's row.

The affiliation strings below are real, copied from OpenAlex during the first backfill,
including the ones the rule exists to refuse: "Monte Rosa Technology" in California,
"Oneomics Co., Ltd." in Korea, and a law report that named a company as a party.
No test here touches the network.

    python3 -m unittest discover -s ingest/tests -t .
"""

from __future__ import annotations

import datetime
import json
import pathlib
import tempfile
import unittest
from unittest import mock

from ingest import papers
from ingest.sources.base import Company


def work(affiliation, title="A paper", year=2024, date=None, doi=None, wid="https://openalex.org/W1", **extra):
    return {
        "id": wid,
        "doi": doi,
        "title": title,
        "publication_year": year,
        "publication_date": date or f"{year}-01-01",
        "authorships": [{"raw_affiliation_strings": [affiliation]}],
        **extra,
    }


def reply(results, count=None):
    return 200, {}, json.dumps({"meta": {"count": len(results) if count is None else count}, "results": results})


class NeedlesAreDistinctiveNames(unittest.TestCase):
    def test_the_legal_form_is_not_part_of_the_name(self):
        self.assertEqual(papers.needle("GIGATON RESEARCH PRIVATE LIMITED"), "GIGATON RESEARCH")
        self.assertEqual(papers.needle("Kadamb Biolabs Pvt Ltd"), "Kadamb Biolabs")
        self.assertEqual(papers.needle("Call X Ringers Pvt Ltd"), "Call X Ringers")
        self.assertEqual(papers.needle("Kalki Robotics (OPC) Private Limited"), "Kalki Robotics")
        self.assertEqual(papers.needle("Bionano Integra Healthcare OPC Private Limited"), "Bionano Integra Healthcare")
        self.assertEqual(papers.needle("Vasishth Genomics Research Lab (P) Ltd."), "Vasishth Genomics Research Lab")

    def test_a_coined_word_carries_a_generic_one(self):
        self.assertEqual(papers.needle("Tavisha Robotics"), "Tavisha Robotics")
        self.assertEqual(papers.needle("Appliedc6 Technologies Private Limited"), "Appliedc6 Technologies")

    def test_a_bracketed_registered_name_is_the_one_searched(self):
        self.assertEqual(papers.needle("DocsApp (Phasorz Technologies Private Limited)"), "Phasorz Technologies")

    def test_one_short_or_common_word_is_not_searched(self):
        for name in ("Gaze", "Robotics", "TAYPRO Pvt. Ltd.", "Sustain & Co.", "Genoscope Private Limited"):
            with self.subTest(name=name):
                self.assertIsNone(papers.needle(name))

    def test_a_pair_of_generic_words_is_not_searched(self):
        for name in ("Nova Dynamics", "Nano Advantage", "Vertical Farming Technologies Pvt. Ltd.", "Arc Robotics Pvt Ltd"):
            with self.subTest(name=name):
                self.assertIsNone(papers.needle(name))

    def test_a_person_is_not_searched(self):
        self.assertIsNone(papers.needle("Aishwarya Dasare"))
        self.assertIsNone(papers.needle("Imran Hussain"))
        # A coined business word is not a surname.
        self.assertEqual(papers.needle("Denovo Bioinnovations"), "Denovo Bioinnovations")

    def test_search_says_none_without_asking(self):
        with mock.patch.object(papers, "_http", side_effect=AssertionError("must not be called")):
            self.assertIsNone(papers.search("Gaze"))


class AffiliationsNameTheCompany(unittest.TestCase):
    def match(self, affiliation, phrase):
        return papers.matching_affiliation(work(affiliation), phrase)

    def test_whole_words_only(self):
        self.assertIsNotNone(self.match("Gigaton Research Pvt Ltd, Pune, India", "GIGATON RESEARCH"))
        self.assertIsNone(self.match("Gigaton Researchers Pvt Ltd, Pune, India", "GIGATON RESEARCH"))
        self.assertIsNone(self.match("XGigaton Research Pvt Ltd, Pune, India", "GIGATON RESEARCH"))

    def test_case_and_punctuation_do_not_matter(self):
        self.assertIsNotNone(self.match("ISMO Bio-Photonics Pvt. Ltd., IITM Research Park, Chennai", "Ismo Bio Photonics"))
        self.assertIsNotNone(self.match("QuNu Labs Pvt Ltd,Bengaluru,Karnataka 560025", "QuNu Labs"))

    def test_the_affiliation_must_be_indian(self):
        self.assertIsNone(self.match("Monte Rosa Technology, Los Altos, CA, USA", "Rosa Technology"))
        self.assertIsNone(self.match("Industron Technical Services Inc, Minneapolis, MN, USA", "Industron Technical Services"))
        self.assertIsNotNone(self.match("Industron Technical Services Pvt. Ltd. Trivandrum Kerala India", "Industron Technical Services"))
        # An Indian company form is enough on its own: QuNu often writes nothing else.
        self.assertIsNotNone(self.match("QuNu Labs Pvt. Ltd", "QuNu Labs"))

    def test_india_is_read_in_the_same_affiliation_not_a_glued_neighbour(self):
        glued = "Oneomics Co., Ltd., Gimpo-si, South Korea; Indian Institute of Technology Delhi, India"
        self.assertIsNone(self.match(glued, "Oneomics"))
        glued = "S.P. Jain Institute of Management & Research, India; A3 Remote Monitoring Technologies Pvt Ltd, India"
        self.assertEqual(self.match(glued, "A3 Remote Monitoring Technologies"), "A3 Remote Monitoring Technologies Pvt Ltd, India")

    def test_a_one_word_name_must_be_the_organisation(self):
        self.assertIsNotNone(self.match("Oneomics Private Limited, Bharathidasan University Technology Park, Tiruchirappalli", "Oneomics"))
        self.assertIsNotNone(self.match("Cancrie, Jaipur, India", "Cancrie"))
        self.assertIsNone(self.match("Chimertech Innovations LLP, Chennai, India", "Chimertech"))
        self.assertIsNone(self.match('"Electronlab India" Research Facility', "Electronlab"))

    def test_a_law_report_is_not_a_paper(self):
        citation = "Tharakan Web Innovations Pvt. Ltd. v . National Company Law Tribunal , W.P.(C) Nos. 27636 of 2020"
        self.assertIsNone(self.match(citation, "Tharakan Web Innovations"))


class SearchReadsOpenAlex(unittest.TestCase):
    def test_counts_verified_papers_and_keeps_three_newest(self):
        results = [
            work("QuNu Labs Pvt Ltd., Bangalore, India", title="Older", year=2020, doi="https://doi.org/10.1/a", wid="https://openalex.org/W1"),
            work("QuNu Labs Pvt. Ltd., Bengaluru, India", title="Newest", year=2026, wid="https://openalex.org/W2"),
            work("QuNu Labs Pvt. Ltd", title="Middle", year=2024, doi="https://doi.org/10.1/c", wid="https://openalex.org/W3"),
            work("QuNu Labs Pvt. Ltd", title="Middle", year=2023, wid="https://openalex.org/W3b"),  # a preprint of the same
            work("QuNu Labs Pvt. Ltd", title="Second", year=2025, wid="https://openalex.org/W4"),
            work("Qunu Laboratories, Oslo, Norway", title="Someone else's", year=2026, wid="https://openalex.org/W5"),
            work("QuNu Labs Pvt. Ltd", title="Retracted", year=2026, wid="https://openalex.org/W6", is_retracted=True),
            work("QuNu Labs Pvt. Ltd", title="Correction: Newest", year=2026, wid="https://openalex.org/W7", type="erratum"),
        ]
        with mock.patch.object(papers, "_http", return_value=reply(results)) as http, mock.patch.object(papers.time, "sleep"):
            found = papers.search("QuNu Labs Private Limited")
        self.assertEqual(found.count, 4)
        self.assertEqual([w.title for w in found.works], ["Newest", "Second", "Middle"])
        self.assertEqual(found.works[0].url, "https://openalex.org/W2")
        self.assertEqual(found.works[2].url, "https://doi.org/10.1/c")
        self.assertIn("api.openalex.org/works?filter=raw_affiliation_strings.search:%22QuNu%20Labs%22", found.query_url)

        url, params = http.call_args.args
        self.assertEqual(params["filter"], 'raw_affiliation_strings.search:"QuNu Labs"')
        self.assertNotIn("mailto", params)
        self.assertNotIn("@", json.dumps(params))

    def test_a_failure_is_not_zero_papers(self):
        with mock.patch.object(papers, "_http", return_value=(503, {}, "")), mock.patch.object(papers.time, "sleep"):
            with self.assertRaises(papers.Unavailable):
                papers.search("QuNu Labs Private Limited")

    def test_a_name_in_hundreds_of_affiliations_is_nobodys(self):
        with mock.patch.object(papers, "_http", return_value=reply([work("x")] * 200, count=5000)), mock.patch.object(papers.time, "sleep"):
            self.assertIsNone(papers.search("Kadamb Biolabs Pvt Ltd"))


class LookupCaches(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.path = pathlib.Path(self.folder.name) / "papers.json"
        self.companies = [Company(id="qunu-labs", name="QuNu Labs Private Limited"), Company(id="kadamb-biolabs", name="Kadamb Biolabs Pvt Ltd"), Company(id="gaze", name="Gaze")]
        self.sleep = mock.patch.object(papers.time, "sleep")
        self.sleep.start()

    def tearDown(self):
        self.sleep.stop()
        self.folder.cleanup()

    def entry(self, needle, days_old, count=2):
        checked = datetime.datetime.now(datetime.UTC) - datetime.timedelta(days=days_old)
        return {"needle": needle, "count": count, "works": [{"title": "T", "year": 2024, "url": "https://doi.org/x"}], "query_url": papers.query_url(needle), "checked": checked.isoformat(), "rule": papers.RULE_VERSION}

    def test_fresh_entries_cost_nothing(self):
        self.path.write_text(json.dumps({"qunu-labs": self.entry("QuNu Labs", 3), "kadamb-biolabs": self.entry("Kadamb Biolabs", 29, count=0)}))
        with mock.patch.object(papers, "_http", side_effect=AssertionError("must not be called")):
            found = papers.lookup(self.companies, cache_path=self.path)
        self.assertEqual(found["qunu-labs"].count, 2)
        self.assertEqual(found["kadamb-biolabs"].count, 0)
        self.assertNotIn("gaze", found)

    def test_stale_or_renamed_entries_are_asked_again_in_one_batch(self):
        self.path.write_text(json.dumps({"qunu-labs": self.entry("QuNu Labs", 31), "kadamb-biolabs": self.entry("Kadamb Bio", 1)}))
        results = [work("Kadamb Biolabs Pvt Ltd, Hyderabad, India", title="Kadamb paper")]
        with mock.patch.object(papers, "_http", return_value=reply(results)) as http:
            found = papers.lookup(self.companies, cache_path=self.path)
        self.assertEqual(http.call_count, 1)
        self.assertEqual(http.call_args.args[1]["filter"], 'raw_affiliation_strings.search:"QuNu Labs"|"Kadamb Biolabs"')
        self.assertEqual(found["qunu-labs"].count, 0)
        self.assertEqual(found["kadamb-biolabs"].count, 1)
        written = json.loads(self.path.read_text())
        self.assertEqual(written["kadamb-biolabs"]["needle"], "Kadamb Biolabs")
        self.assertEqual(written["kadamb-biolabs"]["works"], [{"title": "Kadamb paper", "year": 2024, "url": "https://openalex.org/W1"}])
        self.assertNotIn("gaze", written)

    def test_an_overflowing_batch_is_split_and_the_broad_name_dropped(self):
        def http(url, params):
            if "|" in params["filter"]:
                return reply([], count=900)
            if "QuNu" in params["filter"]:
                return reply([work("QuNu Labs Pvt. Ltd")])
            return reply([work("x")] * 200, count=900)

        with mock.patch.object(papers, "_http", side_effect=http):
            found = papers.lookup(self.companies, cache_path=self.path)
        self.assertEqual(found["qunu-labs"].count, 1)
        self.assertNotIn("kadamb-biolabs", found)
        self.assertIsNone(json.loads(self.path.read_text())["kadamb-biolabs"]["count"])

    def test_out_of_allowance_stops_without_raising(self):
        with mock.patch.object(papers, "_http", return_value=(429, {"x-ratelimit-remaining-usd": "0"}, "")) as http:
            found = papers.lookup(self.companies, cache_path=self.path)
        self.assertEqual(found, {})
        self.assertEqual(http.call_count, 1)

    def test_nothing_escapes(self):
        with mock.patch.object(papers, "_http", side_effect=RuntimeError("boom")):
            self.assertEqual(papers.lookup(self.companies, cache_path=self.path), {})
        self.path.write_text("not json")
        with mock.patch.object(papers, "_http", return_value=(400, {}, "")):
            self.assertEqual(papers.lookup(self.companies, cache_path=self.path), {})

    def test_the_time_budget_is_respected(self):
        with mock.patch.object(papers, "_http", side_effect=AssertionError("must not be called")):
            self.assertEqual(papers.lookup(self.companies, max_seconds=0, cache_path=self.path), {})


if __name__ == "__main__":
    unittest.main()
