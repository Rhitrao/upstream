"""Evidence collectors: every field from its own record, two dates kept apart, no company created.

    python3 -m unittest discover -s ingest/tests -t .

Fixtures are trimmed copies of the real pages (HTML), and for the PDFs the words and
positions pdfplumber extracted from the real documents, cropped to a few rows.
"""

from __future__ import annotations

import json
import pathlib
import re
import tempfile
import unittest
from unittest import mock

from ingest.evidence import Award, birac_big, city_from, idex, is_company, match, national_startup_awards as nsa, tdb
from ingest.evidence import upload_date, written_date

FIXTURES = pathlib.Path(__file__).parent / "fixtures" / "evidence"


def read(name: str) -> str:
    return (FIXTURES / name).read_text(encoding="utf-8")


def by_name(awards: list[Award]) -> dict[str, Award]:
    return {a.name: a for a in awards}


class DatesStayApart:
    """Shared checks: a date is a year or a whole day, never a padded year or a page date."""

    def assert_honest_dates(self, awards: list[Award]):
        for award in awards:
            if award.date is not None:
                self.assertRegex(award.date, r"^\d{4}(-\d{2}-\d{2})?$", award)
                self.assertFalse(award.date.endswith("-01-01"), award)
            if award.published is not None:
                self.assertRegex(award.published, r"^\d{4}(-\d{2}-\d{2})?$", award)
            self.assertIn(award.type, {"award", "grant"})


# ---------------------------------------------------------------------------------------
# National Startup Awards


class NationalStartupAwards2020(unittest.TestCase, DatesStayApart):
    URL = "https://www.startupindia.gov.in/nsa/agriculture.html"

    def setUp(self):
        self.awards = nsa.parse_page(read("nsa2020_agriculture.html"), self.URL, "2020")
        self.named = by_name(self.awards)

    def test_a_winner_keeps_its_own_panel_number_and_category(self):
        mandya = self.named["Mandya Organic Foods Private Limited"]
        self.assertEqual(mandya.dpiit_number, "DIPP22685")
        self.assertEqual(mandya.label, "National Startup Awards 2020, winner — Agriculture (Farmer Engagement and Education)")
        intello = self.named["Intello Labs Private Limited"]
        self.assertEqual(intello.dpiit_number, "DIPP6785")
        self.assertIn("(Post Harvest)", intello.label)

    def test_a_winner_listed_again_among_finalists_is_kept_once_with_that_rows_city(self):
        keys = [re.sub(r"\W", "", a.name.lower()) for a in self.awards]
        self.assertEqual(len([k for k in keys if k.startswith("mandyaorganic")]), 1)
        self.assertEqual(self.named["Mandya Organic Foods Private Limited"].city, "Bengaluru")
        self.assertEqual(self.named["Intello Labs Private Limited"].city, "Delhi")

    def test_a_finalist_row_gives_its_own_category_and_city(self):
        resham = self.named["RESHAM SUTRA PRIVATE LIMITED"]
        self.assertEqual(resham.label, "National Startup Awards 2020, finalist — Agriculture (Allied Areas)")
        self.assertEqual(resham.city, "Ranchi")
        self.assertIsNone(resham.dpiit_number)
        self.assertEqual(self.named["GREENJAMS BUILDTECH PRIVATE LIMITED"].city, "Visakhapatnam")

    def test_the_edition_year_is_the_date_and_nothing_is_published(self):
        self.assert_honest_dates(self.awards)
        self.assertEqual({a.date for a in self.awards}, {"2020"})
        self.assertEqual({a.published for a in self.awards}, {None})
        self.assertEqual({(a.source, a.url, a.type) for a in self.awards}, {("nsa-dpiit", self.URL, "award")})


class NationalStartupAwards2021(unittest.TestCase, DatesStayApart):
    def test_winners_come_from_their_accordion_and_finalists_from_their_row(self):
        awards = by_name(nsa.parse_page(read("nsa2021_agriculture.html"), "u", "2021"))
        shapos = awards["Shapos Services Private Limited"]
        self.assertEqual((shapos.dpiit_number, shapos.date), ("DIPP60116", "2021"))
        self.assertEqual(shapos.label, "National Startup Awards 2021, winner — Agriculture (Farmer Engagement and Education)")
        self.assertEqual(awards["Agrirain Agro Industries India Private Limited"].dpiit_number, "DIPP40639")
        # "Warehousing <span>a</span>nd Logistics" in the source cell reads as one word.
        singodwala = awards["Singodwala Warehousing and Logistics Private Limited"]
        self.assertEqual((singodwala.city, singodwala.dpiit_number), ("Jaipur", None))
        self.assertIn("finalist — Agriculture (Farmer Engagement & Education)", singodwala.label)

    def test_a_special_page_takes_its_year_from_the_sites_own_edition_link(self):
        awards = nsa.parse_page(read("nsa2021_women_led.html"), "u", "2021")
        self.assertEqual(len(awards), 1)
        self.assertEqual(awards[0].date, "2021")
        self.assertEqual(awards[0].dpiit_number, "DIPP53186")

    def test_the_index_lists_every_category_page(self):
        pages = nsa.page_urls(read("nsa2021_index.html"), "https://www.startupindia.gov.in/nsa2021results/")
        self.assertIn("https://www.startupindia.gov.in/nsa2021results/agriculture.html", pages)
        self.assertIn("https://www.startupindia.gov.in/nsa2021results/Rural-area-page.html", pages)
        self.assertNotIn("https://www.startupindia.gov.in/nsa2021results/index.html", pages)
        self.assertEqual(len(pages), len(set(pages)))


class NationalStartupAwards2022And2023(unittest.TestCase, DatesStayApart):
    def test_only_the_modal_the_page_opens_is_its_winner(self):
        # The Animal Husbandry page still carries the Agriculture page's Natura Crop Care
        # and Wolkus modals, which nothing on the page opens.
        awards = nsa.parse_page(read("nsa2022_animal_husbandry.html"), "u", "2022")
        winners = [a for a in awards if ", winner" in a.label]
        self.assertEqual([a.name for a in winners], ["Hydrogreens Agri Solutions Private Limited"])
        self.assertNotIn("Natura Crop Care", by_name(awards))
        hydro = winners[0]
        self.assertEqual(hydro.label, "National Startup Awards 2022, winner — Animal Husbandry (Productivity)")
        self.assertEqual((hydro.dpiit_number, hydro.city, hydro.date), ("DIPP35600", "Dakshina Kannada", "2022"))
        finalists = [a for a in awards if ", finalist" in a.label]
        self.assertTrue(finalists)
        self.assertTrue(all(a.city is None and a.dpiit_number is None for a in finalists))

    def test_a_state_first_place_line_still_gives_the_city(self):
        awards = by_name(nsa.parse_page(read("nsa2023_rising_star.html"), "u", "2023"))
        vivid = awards["Vividminds Technologies Private Limited"]  # "Telangana, Hyderabad"
        self.assertEqual((vivid.city, vivid.dpiit_number), ("Hyderabad", "DIPP49386"))
        self.assertEqual(awards["Vvp Healthcare Evolution Private Limited"].city, "Mumbai")
        # Both winners appear again in capitals among the finalists; neither is repeated.
        self.assertNotIn("VIVIDMINDS TECHNOLOGIES PRIVATE LIMITED", awards)
        self.assertEqual(awards["HANUAI PRIVATE LIMITED"].label, "National Startup Awards 2023, finalist — Rising Star Award")
        self.assert_honest_dates(list(awards.values()))


class NationalStartupAwards5(unittest.TestCase, DatesStayApart):
    def test_the_year_is_the_one_the_page_gives_the_edition(self):
        awards = nsa.parse_page(read("nsa5_agri_innovation.html"), "u", "5.0")
        self.assertEqual({a.date for a in awards}, {"2025"})
        winner = awards[0]
        self.assertEqual(winner.name, "AREETE BUSINESS SOLUTIONS PRIVATE LIMITED")
        self.assertEqual(winner.label, "National Startup Awards 5.0, winner — Agri Innovation Award")
        self.assertEqual(len([a for a in awards if ", finalist" in a.label]), 6)

    def test_no_year_on_the_page_means_no_date(self):
        html = re.sub(r"\s*In\s+NSA\s+2025", "", read("nsa5_agri_innovation.html"))
        awards = nsa.parse_page(html, "u", "5.0")
        self.assertTrue(awards)
        self.assertEqual({a.date for a in awards}, {None})
        self.assertTrue(all(a.label.startswith("National Startup Awards 5.0, ") for a in awards))

    def test_a_page_with_nothing_on_it_raises(self):
        with self.assertRaises(ValueError):
            nsa.parse_page("<html><title>Agriculture-National Startup Awards 2020</title></html>", "u", "2020")

    def test_an_index_linking_nothing_raises(self):
        with mock.patch.object(nsa, "fetch", return_value="<html><body>moved</body></html>"):
            with self.assertRaises(ValueError):
                nsa.collect()

    def test_an_incubator_is_an_institution_and_a_brand_is_not_a_person(self):
        self.assertFalse(nsa._award("Access Livelihoods Foundation", "winner", "2021", "2021", "Incubator", None,
                                    "u", None, None, institution=True).is_company)
        self.assertTrue(nsa._award("Soil Sathi", "finalist", "2023", "2023", "Innovators", None, "u", None, None).is_company)


# ---------------------------------------------------------------------------------------
# BIRAC BIG


class BiracBig(unittest.TestCase, DatesStayApart):
    @classmethod
    def setUpClass(cls):
        cls.fixture = json.loads(read("birac_big_words.json"))

    def names(self, key):
        return birac_big.awardee_names(self.fixture[key]["pages"])

    def test_centred_names_that_wrap_above_and_below_their_reference(self):
        self.assertEqual(self.names("big15")[:10], [
            "Ajaya P Katti", "Anabio Technologies Private Limited", "Anuradha Bhosale",
            "Arboreal Bioinnovations Private Limited", "ASHVA WEARABLE TECHNOLOGIES PVT. LTD.",
            "ASISH MOHANDAS", "Badri Viswanatha N", "Bhamini Krishna Rao",
            "BRAINSIGHT TECHNOLOGY PRIVATE LIMITED", "Dr Lini Basil",
        ])

    def test_wrapped_reference_codes_and_top_aligned_names(self):
        self.assertEqual(self.names("big22"), [
            "Vinayak Nanjundappa", "Madhumohan R", "Aswathi Sasidharan", "Auric Cosmo India Private Limited",
            "Dr. Kalay Khan", "Rajesh Patkar", "Fins and Tails Agritech Private Limited", "Rajesh Nair",
        ])

    def test_a_legal_suffix_never_starts_the_next_name(self):
        names = self.names("ner")
        self.assertIn("Brahmaputra Technopharmaceuticals Private Limited", names)
        self.assertIn("Taraknath Kundu", names)

    def test_a_wrapped_category_heading_is_not_part_of_a_name(self):
        names = self.names("big24")
        self.assertEqual(names[0], "Trish-I")
        self.assertFalse(any("Diagnostics" in n or "Category" in n for n in names))

    def test_round_label_upload_date_and_no_award_date(self):
        entry = self.fixture["big15"]
        self.assertEqual(birac_big.round_of(entry["pages"]), "15")
        awards = birac_big.parse(entry["pages"], entry["url"], "15")
        self.assert_honest_dates(awards)
        self.assertEqual({a.label for a in awards}, {"BIRAC BIG round 15 awardee"})
        self.assertEqual({a.date for a in awards}, {None})  # "Date: 3rd Feb. 2020" is the letter's date
        self.assertEqual({a.published for a in awards}, {"2020-03-13"})  # 1584097052_…
        self.assertEqual({a.type for a in awards}, {"grant"})
        self.assertEqual(birac_big.round_of(self.fixture["ner"]["pages"]), "NER")

    def test_individuals_and_companies(self):
        awards = by_name(birac_big.parse(self.fixture["big15"]["pages"], self.fixture["big15"]["url"], "15"))
        self.assertFalse(awards["Ajaya P Katti"].is_company)
        self.assertFalse(awards["Dr Lini Basil"].is_company)
        self.assertFalse(awards["ASISH MOHANDAS"].is_company)
        self.assertTrue(awards["Anabio Technologies Private Limited"].is_company)
        self.assertTrue(awards["ASHVA WEARABLE TECHNOLOGIES PVT. LTD."].is_company)

    def test_a_document_with_no_rows_raises(self):
        with self.assertRaises(ValueError):
            birac_big.parse([[{"text": "Applicant", "x0": 280, "x1": 320, "top": 100, "bottom": 110}]], "u", "16")

    def test_only_awardee_lists_are_followed_from_the_page(self):
        html = ('<a href="./webcontent/1584097052_big_15_awardee_list.pdf">15</a>'
                '<a href="./webcontent/BIG_17_Call_Awardee.pdf">17</a>'
                '<a href="./webcontent/1682069225_Final_list_BIG_NER.pdf">NER</a>'
                '<a href="./webcontent/1563866235_BIG_Guideline_23_07_2019.pdf">guidelines</a>')
        self.assertEqual(birac_big.pdf_links(html), [
            "https://birac.nic.in/webcontent/1584097052_big_15_awardee_list.pdf",
            "https://birac.nic.in/webcontent/BIG_17_Call_Awardee.pdf",
            "https://birac.nic.in/webcontent/1682069225_Final_list_BIG_NER.pdf",
        ])

    def test_the_grants_csv_gap_counts_company_awardees_missing_from_the_file(self):
        entry = self.fixture["big22"]
        with tempfile.TemporaryDirectory() as tmp:
            path = pathlib.Path(tmp) / "grants.csv"
            path.write_text("company_name,scheme\nAuric Cosmo India Pvt Ltd,BIRAC BIG 22\n", encoding="utf-8")
            with mock.patch.object(birac_big, "fetch", return_value=f'<a href="{entry["url"]}">22</a>'), \
                    mock.patch.object(birac_big, "fetch_bytes", return_value=b""), \
                    mock.patch.object(birac_big, "pdf_words", return_value=entry["pages"]):
                gap = birac_big.grants_csv_gap(path)
        self.assertEqual(gap["22"]["missing"], ["Fins and Tails Agritech Private Limited"])  # Madhumohan R is a person
        self.assertEqual(gap["22"]["companies"], 2)
        self.assertEqual(gap["22"]["missing_with_legal_suffix"], ["Fins and Tails Agritech Private Limited"])
        self.assertEqual(gap["22"]["awardees"], 8)


# ---------------------------------------------------------------------------------------
# TDB


class TechnologyDevelopmentBoard(unittest.TestCase, DatesStayApart):
    def test_a_table_row_gives_company_city_project_and_commitment(self):
        awards = by_name(tdb.parse_year(read("tdb_2022_23.html"), "https://tdb.gov.in/agreement-2022-2023", "2022-23"))
        kritsnam = awards["Kritsnam Technologies Private Limited"]
        self.assertEqual(kritsnam.city, "Ranchi")
        self.assertEqual(kritsnam.label, "TDB funding agreement, FY 2022-23: Commercialization of Dhaara Smart Flow Meter (₹3.3 cr)")
        self.assertEqual((kritsnam.date, kritsnam.published, kritsnam.type), (None, None, "grant"))
        self.assertEqual(awards["Panacea Medical Technologies Pvt. Ltd."].city, "Bangalore")
        self.assert_honest_dates(list(awards.values()))

    def test_a_sentence_row_is_read_from_its_own_cell(self):
        awards = by_name(tdb.parse_year(read("tdb_2018_19.html"), "u", "2018-19"))
        surewaves = awards["SureWaves MediaTech Pvt. Ltd."]
        self.assertEqual(surewaves.city, "Bangalore")
        self.assertEqual(surewaves.label, "TDB funding agreement, FY 2018-19: Development and Commercialization of SkyNet Programmatic TV Platform")
        self.assertIsNone(surewaves.date)

    def test_only_a_date_the_row_states_is_a_date(self):
        awards = by_name(tdb.parse_year(read("tdb_2016_17.html"), "u", "2016-17"))
        self.assertEqual(awards["Energos Technologies Pvt. Limited"].date, "2017-03-23")
        self.assertEqual(awards["Energos Technologies Pvt. Limited"].label, "TDB funding agreement, FY 2016-17: Changing Energy Habits")
        self.assertEqual(awards["Renalyx Health Systems Private Limited"].date, "2017-03-16")
        self.assertIsNone(awards["Ampere Vehicles Pvt. Ltd."].date)  # a financial year is not a date
        self.assertEqual(awards["Terminus Circuits Pvt. Ltd."].city, "Bangalore")  # "Bangaloresigned a Loan…"
        self.assert_honest_dates(list(awards.values()))

    def test_the_index_gives_each_financial_year(self):
        pages = dict(tdb.year_pages(read("tdb_index.html")))
        self.assertEqual(pages["https://tdb.gov.in/agreement-2022-2023"], "2022-23")
        self.assertEqual(pages["https://tdb.gov.in/Agreements-2025-26"], "2025-26")
        self.assertEqual(len(pages), 13)

    def test_an_empty_table_raises(self):
        with self.assertRaises(ValueError):
            tdb.parse_year("<table><tr><th>Sr. No.</th><th>Project Title</th><th>company name</th></tr></table>", "u", "2030-31")

    def test_the_company_cell_splits_at_the_legal_suffix(self):
        self.assertEqual(tdb.split_company("M/s WellRx Technologies Pvt. Ltd. Rewari,  (Haryana)"), ("WellRx Technologies Pvt. Ltd.", "Rewari"))
        self.assertEqual(tdb.split_company("M/s Sahajananad Medical Technologies Ltd., Gujarat"), ("Sahajananad Medical Technologies Ltd.", None))
        self.assertEqual(tdb.split_company("M/s S3V Vascular Technologies, Bangalore"), ("S3V Vascular Technologies", "Bangalore"))


# ---------------------------------------------------------------------------------------
# iDEX


class Idex(unittest.TestCase, DatesStayApart):
    @classmethod
    def setUpClass(cls):
        cls.book = json.loads(read("idex_book_pages.json"))
        cls.grid = idex.home_grid(read("idex_home.html"))

    def test_the_grid_gives_each_company_its_own_slides_state(self):
        rows = {r["name"]: r for r in self.grid}
        self.assertEqual(rows["Gyan Data Private Limited"]["state"], "Tamil Nadu")
        self.assertEqual(rows["ASTROME TECHNOLOGIES PRIVATE LIMITED"]["state"], "Karnataka")
        self.assertEqual(rows["Gyan Data Private Limited"]["website"], "https://www.gyandata.com/")

    def test_a_book_page_gives_its_category_title_and_sideways_name(self):
        winners = idex.book_winners(self.book["pages"])
        self.assertEqual(winners, [
            {"name": "Aerial IQ India Pvt Ltd", "category": "Open Challenge 4.0",
             "title": "Aviral- A Tethered Drone System for Surveillance & Monitoring Purpose"},
            {"name": "Aerospace Engineers Pvt Ltd", "category": "DISC 7", "title": "Underwater Navigation System for AUVs"},
            {"name": "Sagar Defence Engineering Pvt Ltd", "category": "DISC 7", "title": "Autonomous Weaponized Boat Swarm"},
        ])

    def test_book_and_grid_combine_one_record_per_company(self):
        url, published = idex.book_link(read("idex_publications.html"))
        self.assertEqual(published, "2025-10-31")
        self.assertTrue(url.endswith("1787225323_c53b250da5cd44f87280.pdf"))
        grid = self.grid + [{"name": "Aerospace Engineers Private Limited", "state": "Karnataka", "website": None}]
        awards = idex.combine(grid, idex.book_winners(self.book["pages"]), url, published)
        named = by_name(awards)
        self.assertEqual(named["Aerospace Engineers Pvt Ltd"].label, "iDEX DISC 7 winner: Underwater Navigation System for AUVs")
        self.assertNotIn("Aerospace Engineers Private Limited", named)  # the same company, from the grid
        self.assertEqual(named["Gyan Data Private Limited"].label, "iDEX-supported startup (Tamil Nadu)")
        self.assertEqual(len([a for a in awards if a.name.upper() == "BIG BANG BOOM SOLUTIONS PRIVATE LIMITED"]), 1)
        self.assertEqual(named["Aerospace Engineers Pvt Ltd"].published, "2025-10-31")
        self.assertIsNone(named["Gyan Data Private Limited"].published)
        self.assertEqual({a.date for a in awards}, {None})
        self.assert_honest_dates(awards)

    def test_an_empty_grid_raises(self):
        with mock.patch.object(idex, "fetch", return_value="<html></html>"):
            with self.assertRaises(ValueError):
                idex.collect()


# ---------------------------------------------------------------------------------------
# Shared helpers


class Helpers(unittest.TestCase):
    def test_people_institutions_and_companies(self):
        for name in ("Ajaya P Katti", "Dr. S. Vishnuvardhan Reddy", "Mr. Samir K. Maji", "ASISH MOHANDAS", "Madhumohan R",
                     "Foundation for Neglected Disease Research", "Centre For Cellular and Molecular Platforms (C-CAMP)"):
            self.assertFalse(is_company(name), name)
        for name in ("Anabio Technologies Private Limited", "Villgro Innovations Foundation Private Limited",
                     "Zentron Labs", "Natura Crop Care", "Backyard Creators", "Trish-I", "Hanuai", "ASM International",
                     "VIA Energicals", "Telscie Genetics"):
            self.assertTrue(is_company(name), name)

    def test_upload_dates_come_from_the_file_name_only(self):
        self.assertEqual(upload_date("https://birac.nic.in/webcontent/1630669396_BIG_18_Awardees.pdf"), "2021-09-03")
        self.assertIsNone(upload_date("https://birac.nic.in/webcontent/BIG_17_Call_Awardee.pdf"))
        self.assertIsNone(upload_date("https://birac.nic.in/webcontent/159701040077_BIG_Associate_Partners.pdf"))

    def test_written_dates(self):
        self.assertEqual(written_date("entered into a grant agreement on 4th May, 2017 with"), "2017-05-04")
        self.assertEqual(written_date("Oct 31, 2025"), "2025-10-31")
        self.assertIsNone(written_date("FY 2022-23"))
        self.assertIsNone(written_date("in 2019"))

    def test_city_from_a_place_line(self):
        self.assertEqual(city_from("Telangana, Hyderabad"), "Hyderabad")
        self.assertEqual(city_from("Bhopal (MP)"), "Bhopal")
        self.assertIsNone(city_from("Gujarat"))


class Matching(unittest.TestCase):
    def award(self, name, dpiit=None):
        return Award(name=name, type="award", label="x", date=None, published=None, url="u", source="s", dpiit_number=dpiit)

    def test_same_name_once_suffixes_and_punctuation_are_gone(self):
        a = self.award("SNL Innovations Pvt. Ltd.")
        self.assertEqual(match.match([a], [("snl-innovations", "Snl Innovations Private Limited", None)]), [(a, "snl-innovations")])

    def test_a_dpiit_number_wins_over_the_name(self):
        a = self.award("Organic Mandya", "DIPP22685")
        held = [("mandya-organic-foods", "Mandya Organic Foods Private Limited", "DIPP 22685"),
                ("organic-mandya", "Organic Mandya", None)]
        self.assertEqual(match.match([a], held), [(a, "mandya-organic-foods")])

    def test_two_different_numbers_are_two_companies_whatever_the_name(self):
        a = self.award("Renkube Private Limited", "DIPP50415")
        self.assertEqual(match.match([a], [("renkube", "Renkube Pvt Ltd", "DIPP99999")]), [])

    def test_never_fuzzy(self):
        a = self.award("Aerospace Engineers Pvt Ltd")
        held = [("aero-space-engineering", "Aero Space Engineering Pvt Ltd", None), ("aerospace-engineer", "Aerospace Engineer", None)]
        self.assertEqual(match.match([a], held), [])

    def test_a_name_two_held_companies_share_matches_neither(self):
        a = self.award("Nava Design Innovation")
        held = [("nava-1", "Nava Design Innovation Pvt Ltd", None), ("nava-2", "NAVA DESIGN INNOVATION LLP", None)]
        self.assertEqual(match.match([a], held), [])

    def test_nothing_matched_creates_nothing(self):
        self.assertEqual(match.match([self.award("Unknown Recipient")], []), [])


if __name__ == "__main__":
    unittest.main()


class EvidenceInTheRun(unittest.TestCase):
    def test_awards_become_signals_only_on_held_companies_and_never_for_individuals(self):
        from ingest import run
        from ingest.evidence import Award

        awards = [
            Award(name="Kadamb Biolabs Pvt Ltd", type="award", label="National Startup Awards 2022, finalist — Health", date="2022", published=None, url="https://www.startupindia.gov.in/", source="nsa-dpiit"),
            Award(name="Priya Sharma", type="grant", label="BIRAC BIG round 18 awardee", date=None, published="2021-09-03", url="https://birac.nic.in/big.php", source="birac-big", is_company=False),
            Award(name="Nobody We Hold Ltd", type="grant", label="TDB funding agreement", date=None, published=None, url="https://tdb.gov.in/", source="tdb-agreements"),
        ]
        held = [("kadamb-biolabs", "Kadamb Biolabs", None), ("priya-sharma", "Priya Sharma", None)]
        signals = run.evidence_signals_for(awards, held)
        self.assertEqual([(s.company_id, s.type, s.date, s.source) for s in signals], [("kadamb-biolabs", "award", "2022", "nsa-dpiit")])
