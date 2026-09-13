"""The class of error that put HyperVerge's product on Grinntech's row.

Both fixtures are real and unedited: five cards from RTBI's portfolio page, including
the empty hyperverge.co anchors its editor left in other companies' cards, and the
text of hyperverge.co's own homepage. If either check regresses, a stranger's product
becomes a company's evidence again, and nothing downstream would notice.

    python3 -m unittest discover -s ingest/tests -t .
"""

from __future__ import annotations

import pathlib
import unittest
from unittest import mock

from ingest import enrich, identity
from ingest.sources import rtbi
from ingest.sources.base import Company

FIXTURES = pathlib.Path(__file__).parent / "fixtures"

GRINNTECH_DESCRIPTION = (
    "Grinntech aims to enable scaling up of electric vehicles by making them technically and economically "
    "feasible. Battery packs constitute major part of an electric vehicle. Grinntech is building battery "
    "management systems for lithium battery packs & doing electro-mechanical packaging of lithium battery packs."
)


class RtbiCardsKeepTheirOwnLinks(unittest.TestCase):
    def setUp(self):
        html = (FIXTURES / "rtbi_stray_anchors.html").read_text()
        with mock.patch.object(rtbi, "fetch", return_value=html):
            companies, _ = rtbi.scrape()
        self.sites = {c.id: c.website for c in companies}

    def test_an_empty_anchor_is_not_a_website(self):
        # The live page gives Grinntech 24 empty hyperverge.co anchors before its own link.
        self.assertEqual(self.sites["grinntech-motors-services"], "http://grinntech.com/")
        self.assertEqual(self.sites["esmito-solutions"], "http://esmito.co.in/")

    def test_no_card_but_hyperverges_own_gets_hyperverge(self):
        self.assertEqual(
            [cid for cid, site in self.sites.items() if site and "hyperverge" in site],
            ["hyperverge-inc"],
        )

    def test_a_card_whose_only_real_link_is_a_brand_site_keeps_it_for_the_check_to_judge(self):
        # ZedBee's card links Swadha Energies, its product brand. The parser does not
        # invent a better one; identity.py is what declines to call it verified.
        self.assertEqual(self.sites["zedbee-technologies"], "http://www.swadhaenergies.com/green-HVAC.html")

    def test_a_logo_link_still_wins_over_the_founders_linkedin(self):
        self.assertEqual(self.sites["planys-technologies"], "http://www.planystech.com/")


class AReachableUrlIsNotProofOfIdentity(unittest.TestCase):
    hyperverge = (FIXTURES / "hyperverge_home.txt").read_text()

    def test_the_grinntech_case_is_not_verified_three_ways(self):
        shared = {"hyperverge.co"}
        state, note = identity.assess(
            "Grinntech Motors & Services Private Limited",
            "http://hyperverge.co/",
            GRINNTECH_DESCRIPTION,
            self.hyperverge,
            shared,
            name_text=self.hyperverge,
        )
        self.assertEqual(state, identity.DISCOVERED)
        self.assertIn("another company", note)

        # Even alone — no second record giving the address — the page names someone
        # else and describes a different business.
        self.assertIsNone(identity.names_company("Grinntech Motors & Services Private Limited", "http://hyperverge.co/", self.hyperverge))
        self.assertTrue(identity.contradicts(GRINNTECH_DESCRIPTION, self.hyperverge))
        state, _ = identity.assess(
            "Grinntech Motors & Services Private Limited", "http://hyperverge.co/", GRINNTECH_DESCRIPTION, self.hyperverge, set()
        )
        self.assertEqual(state, identity.DISCOVERED)

    def test_hyperverge_is_verified_on_its_own_homepage(self):
        state, _ = identity.assess("Hyperverge Inc", "http://hyperverge.co/", None, self.hyperverge, {"hyperverge.co"})
        self.assertEqual(state, identity.VERIFIED)

    def test_a_linkedin_page_is_not_a_company_domain(self):
        state, _ = identity.assess("KaviRISE Technologies Pvt Ltd", "https://www.linkedin.com/company/kavirise-technologies/", None, None, set())
        self.assertEqual(state, identity.DISCOVERED)

    def test_a_brand_domain_is_associated_until_the_page_names_the_company(self):
        page = "SkillAngels — cognitive skills for children. Programs for schools."
        state, _ = identity.assess("Edsix Brain Lab Private Limited", "http://skillangels.com/", None, page, set(), name_text=page)
        self.assertEqual(state, identity.ASSOCIATED)
        footer = page + " © 2026 Edsix Brain Lab Pvt. Ltd. All rights reserved."
        state, _ = identity.assess("Edsix Brain Lab Private Limited", "http://skillangels.com/", None, page, set(), name_text=footer)
        self.assertEqual(state, identity.VERIFIED)

    def test_one_generic_word_on_a_page_names_nobody(self):
        page = "Green hydrogen and clean energy for industry."
        self.assertIsNone(identity.names_company("NCF GREEN ENERGY PRIVATE LIMITED", "https://ncflabs.com/", page))
        self.assertEqual(identity.names_company("NCF GREEN ENERGY PRIVATE LIMITED", "https://ncflabs.com/", "NCF Green Energy Pvt Ltd"), "page")
        # A name mis-transcribed down to its legal suffix cannot verify anything.
        self.assertIsNone(identity.names_company("Solutions Pvt. Ltd.", "https://www.medevplus.com", "Medical device solutions"))

    def test_an_unreadable_site_is_verified_only_by_its_domain(self):
        self.assertEqual(identity.assess("Fabheads Automation Private Limited", "https://www.fabheads.in/", None, None, set())[0], identity.VERIFIED)
        self.assertEqual(identity.assess("Driblet Pvt Ltd", "https://arcrobotics.in/", None, None, set())[0], identity.ASSOCIATED)


class NothingUnverifiedIsReadOrCounted(unittest.TestCase):
    def company(self, **fields):
        base = dict(id="grinntech-motors-services", name="Grinntech Motors & Services Private Limited", description=GRINNTECH_DESCRIPTION)
        return Company(**{**base, **fields})

    def test_an_unverified_readable_page_is_held_before_any_model_call(self):
        page = (FIXTURES / "hyperverge_home.txt").read_text()
        company = self.company(website="http://hyperverge.co/")
        held = enrich._gate(company, page, "ok", page, shared=set())
        self.assertEqual(held, enrich.UNVERIFIED)
        self.assertEqual(company.website_identity, identity.DISCOVERED)

    def test_a_verified_page_goes_on_to_be_read(self):
        page = "Grinntech — battery packs and battery management systems for electric vehicles. " * 5
        company = self.company(website="http://grinntech.com/")
        self.assertIsNone(enrich._gate(company, page, "ok", page, shared=set()))
        self.assertEqual(company.website_identity, identity.VERIFIED)

    def test_a_stranger_answering_is_not_a_trace(self):
        wrong = self.company(website="http://hyperverge.co/", website_identity=identity.DISCOVERED)
        right = self.company(id="grinntech-2", website="http://grinntech.com/", website_identity=identity.VERIFIED)
        products = {wrong.id: enrich.Product(status=enrich.UNVERIFIED), right.id: enrich.Product(status=enrich.THIN)}
        self.assertEqual([t.company_id for t in enrich.website_traces([wrong, right], products)], ["grinntech-2"])


if __name__ == "__main__":
    unittest.main()
