"""A contact route is the company's own, or it is not reported.

    python3 -m unittest discover -s ingest/tests -t .
"""

from __future__ import annotations

import unittest

from ingest.contact import Contact, extract

SITE = "https://www.planystech.co.in/"


class OnlyTheCompanysOwnAddress(unittest.TestCase):
    def test_a_mailto_on_the_company_domain_is_kept(self):
        html = '<footer><a href="mailto:info@planystech.co.in?subject=Hi">Write to us</a></footer>'
        self.assertEqual(extract(html, SITE).email, "info@planystech.co.in")

    def test_an_address_written_in_the_page_text_counts_too(self):
        html = "<p>Reach the team at hello@planystech.co.in.</p>"
        self.assertEqual(extract(html, SITE).email, "hello@planystech.co.in")

    def test_a_mail_subdomain_is_still_the_company_domain(self):
        html = '<a href="mailto:sales@mail.planystech.co.in">sales</a>'
        self.assertEqual(extract(html, SITE).email, "sales@mail.planystech.co.in")

    def test_a_webmail_address_is_never_the_companys(self):
        html = '<a href="mailto:planys.founder@gmail.com">Email</a><p>or planys@yahoo.co.in or x@outlook.com</p>'
        self.assertIsNone(extract(html, SITE).email)

    def test_an_agency_in_the_footer_is_not_the_company(self):
        html = '<p>Site by <a href="mailto:studio@pixelcraft.in">Pixelcraft</a> &middot; wix@wixpress.com</p>'
        self.assertIsNone(extract(html, SITE).email)

    def test_a_lookalike_domain_is_not_the_same_domain(self):
        html = "<p>info@planystech.co.in.evil.com and info@planystech.com</p>"
        self.assertIsNone(extract(html, SITE).email)

    def test_a_role_address_beats_a_person(self):
        html = '<a href="mailto:vineet@planystech.co.in">Vineet</a><p>General: contact@planystech.co.in</p>'
        self.assertEqual(extract(html, SITE).email, "contact@planystech.co.in")

    def test_a_person_on_the_company_domain_is_kept_when_there_is_nobody_else(self):
        html = '<a href="mailto:vineet@planystech.co.in">Vineet</a>'
        self.assertEqual(extract(html, SITE).email, "vineet@planystech.co.in")

    def test_the_hiring_inbox_is_not_how_to_reach_them(self):
        html = '<a href="mailto:careers@planystech.co.in">Jobs</a>'
        self.assertIsNone(extract(html, SITE).email)

    def test_obfuscated_addresses_are_left_alone(self):
        html = (
            "<p>info [at] planystech [dot] co [dot] in</p>"
            '<a href="/cdn-cgi/l/email-protection#1a73747c75">[email&#160;protected]</a>'
        )
        self.assertIsNone(extract(html, SITE).email)

    def test_an_image_filename_is_not_an_address(self):
        self.assertIsNone(extract('<img src="logo@2x.png"><p>logo@2x.png</p>', SITE).email)


class AContactPageOnTheirOwnDomain(unittest.TestCase):
    def test_a_relative_contact_link_becomes_absolute(self):
        html = '<nav><a href="/careers">Careers</a><a href="/contact-us/">Talk to us</a></nav>'
        self.assertEqual(extract(html, SITE).page, "https://www.planystech.co.in/contact-us/")

    def test_link_text_alone_is_enough(self):
        html = '<a href="/reach">Get in touch</a>'
        self.assertEqual(extract(html, SITE).page, "https://www.planystech.co.in/reach")

    def test_an_address_that_says_contact_beats_text_that_does(self):
        html = '<a href="/about#form">Contact us</a><a href="/contact.html">Offices</a>'
        self.assertEqual(extract(html, SITE).page, "https://www.planystech.co.in/contact.html")

    def test_careers_is_not_contact(self):
        html = '<a href="/careers/contact">Contact</a><a href="/jobs">Get in touch</a>'
        self.assertIsNone(extract(html, SITE).page)

    def test_social_profiles_and_other_hosts_are_not_contact_pages(self):
        html = (
            '<a href="https://www.linkedin.com/company/planys/contact">Contact</a>'
            '<a href="https://forms.monday.com/forms/abc">Get in touch</a>'
            '<a href="https://incubator.example.org/contact-us">Contact us</a>'
        )
        self.assertIsNone(extract(html, SITE).page)

    def test_a_section_of_the_homepage_is_not_a_page(self):
        html = '<a href="#contact">Contact</a><a href="https://planystech.co.in/#contact">Contact us</a><a href="./">Contact</a>'
        self.assertIsNone(extract(html, SITE).page)

    def test_contactless_is_not_contact(self):
        self.assertIsNone(extract('<a href="/contactless-inspection">Products</a>', SITE).page)

    def test_a_mailto_is_an_email_not_a_page(self):
        found = extract('<a href="mailto:info@planystech.co.in">Contact</a>', SITE)
        self.assertEqual(found, Contact("info@planystech.co.in", None))


class NothingRatherThanAGuess(unittest.TestCase):
    def test_nothing_qualifying_is_none_none(self):
        self.assertEqual(extract("<h1>Underwater robots</h1>", SITE), Contact(None, None))

    def test_malformed_html_does_not_raise(self):
        for html in ("<a href='mailto:info@planystech.co.in'", "<<<>>><a href=>", "\x00�<div", ""):
            self.assertIsInstance(extract(html, SITE), Contact)

    def test_a_bad_website_does_not_raise(self):
        for website in ("", "not a url", "http://[::1", "https://1.2.3.4/"):
            self.assertEqual(extract('<a href="mailto:a@b.com">x</a>', website), Contact(None, None))

    def test_a_profile_is_not_a_company_domain(self):
        html = '<a href="mailto:info@linkedin.com">x</a><a href="/contact">Contact</a>'
        self.assertEqual(extract(html, "https://www.linkedin.com/company/planys"), Contact(None, None))


if __name__ == "__main__":
    unittest.main()


class ContactsRemembered(unittest.TestCase):
    def test_only_verified_sites_are_read_and_a_fresh_answer_is_not_read_again(self):
        import datetime
        import pathlib
        import tempfile

        from ingest import contact
        from ingest.sources.base import Company

        now = datetime.datetime(2026, 9, 14, tzinfo=datetime.UTC)
        pages = {"https://acme.example": '<a href="mailto:info@acme.example">x</a><a href="/contact">Contact</a>'}
        fetched = []

        def fetch(url):
            fetched.append(url)
            return pages.get(url), "ok"

        with tempfile.TemporaryDirectory() as tmp:
            path = pathlib.Path(tmp) / "contacts.json"
            acme = Company(id="acme", name="Acme", website="https://acme.example", website_identity="verified")
            stranger = Company(id="other", name="Other", website="https://agency.example", website_identity="associated")
            found = contact.lookup([acme, stranger], cache_path=path, fetch=fetch, now=lambda: now)
            self.assertEqual(found["acme"], contact.Contact("info@acme.example", "https://acme.example/contact"))
            self.assertNotIn("other", found)
            self.assertEqual(fetched, ["https://acme.example"])
            # The next night, from the cache.
            again = contact.lookup([acme], cache_path=path, fetch=fetch, now=lambda: now + datetime.timedelta(days=1))
            self.assertEqual(again["acme"].email, "info@acme.example")
            self.assertEqual(fetched, ["https://acme.example"])
