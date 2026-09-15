"""A site's other pages are found by its own links, read politely, and described without a model.

    python3 -m unittest discover -s ingest/tests -t .

No test here touches the network: read_site takes the homepage fetch, the page getter and sleep.
"""

from __future__ import annotations

import datetime
import json
import pathlib
import tempfile
import types
import unittest

from ingest import sitepages

HOME = """<html><head><title>Arc Robotics</title></head><body>
<nav><a href="/">Home</a><a href="/about-us/">About Us</a><a href="/products">Products</a>
<a href="/join-our-team">Join our team</a><a href="/our-team">Team</a>
<a href="https://www.linkedin.com/company/arc">LinkedIn</a><a href="/brochure.pdf">Brochure</a>
<a href="https://someagency.com/about">Designed by</a></nav>
<a href="https://github.com/wpthemes">theme</a><a href="https://github.com/ArcRobotics/sdk">SDK</a>
</body></html>"""

CAREERS = """<html><body><header><h2>Careers</h2></header>
<h1>Why work with us</h1>
<h3>Senior Robotics Engineer</h3><h3>Embedded Firmware Developer</h3>
<li><a href="/jobs/1">Senior Robotics Engineer</a></li>
<h3>Summer Internship</h3><p>We are a team of builders.</p>
</body></html>"""


def company(id="arc", website="https://www.arcrobotics.in", identity="verified", **kw):
    return types.SimpleNamespace(id=id, website=website, website_identity=identity, **kw)


class FindingPages(unittest.TestCase):
    def test_each_kind_takes_one_own_domain_link_and_careers_is_claimed_first(self):
        found = sitepages.links(HOME, "https://www.arcrobotics.in")
        self.assertEqual(found["about"], "https://www.arcrobotics.in/about-us/")
        self.assertEqual(found["products"], "https://www.arcrobotics.in/products")
        self.assertEqual(found["careers"], "https://www.arcrobotics.in/join-our-team")
        self.assertEqual(found["team"], "https://www.arcrobotics.in/our-team")
        self.assertNotIn("technology", found)

    def test_a_hiring_platform_counts_as_a_careers_link_and_other_domains_do_not(self):
        html = '<a href="https://jobs.lever.co/arc">Careers</a><a href="https://other.com/about">About</a>'
        found = sitepages.links(html, "https://arcrobotics.in")
        self.assertEqual(found, {"careers": "https://jobs.lever.co/arc"})

    def test_a_repository_must_be_the_sites_own_account(self):
        self.assertEqual(sitepages.repository([HOME], "https://www.arcrobotics.in"), "https://github.com/ArcRobotics")
        self.assertIsNone(sitepages.repository(['<a href="https://github.com/wpthemes">x</a>'], "https://arcrobotics.in"))
        self.assertIsNone(sitepages.repository(['<a href="https://github.com/sponsors/arc">x</a>'], "https://arc.in"))


class CountingRoles(unittest.TestCase):
    def test_distinct_role_titles_are_counted_and_pitches_are_not(self):
        count, titles, says_none = sitepages.roles(CAREERS)
        self.assertEqual(count, 3)
        self.assertIn("Senior Robotics Engineer", titles)
        self.assertFalse(says_none)

    def test_a_page_that_says_it_has_no_openings(self):
        count, _, says_none = sitepages.roles("<body><p>There are no current openings. Write to us anyway.</p></body>")
        self.assertEqual(count, 0)
        self.assertTrue(says_none)


class NotARole(unittest.TestCase):
    def test_sentences_that_name_a_job_are_not_roles(self):
        html = """<body><h3>Design Engineer</h3><li>Clear communication with engineers, vendors, and manufacturing teams.</li>
        <h4>Reporting to Senior Marketing Manager</h4><h3>“Application: Design Engineer”</h3><h3>Lead work that reaches farms</h3>
        <h3>Machine Learning Engineer</h3></body>"""
        count, titles, _ = sitepages.roles(html)
        self.assertEqual(count, 2, titles)

    def test_a_parked_homepage_is_flagged(self):
        site = sitepages.read_site(company(), homepage_fetch=lambda url: ("<body><h1>This domain is for sale</h1></body>", "ok"), get=lambda url, html_only=True: (None, sitepages.MISSING), sleep=lambda s: None)
        self.assertTrue(site.parked)


class ReadingASite(unittest.TestCase):
    def setUp(self):
        self.requested: list[str] = []

    def getter(self, pages: dict):
        def get(url, html_only=True):
            self.requested.append(url)
            return pages.get(url, (None, sitepages.MISSING))
        return get

    def test_linked_pages_are_read_described_and_robots_obeyed(self):
        long_text = "<p>" + "We build autonomous inspection robots for pipelines. " * 10 + "</p>"
        pages = {
            "https://www.arcrobotics.in/robots.txt": ("User-agent: *\nDisallow: /our-team", sitepages.OK),
            "https://www.arcrobotics.in/about-us/": (f"<title>About</title><meta name='description' content='Robots for pipes'>{long_text}", sitepages.OK),
            "https://www.arcrobotics.in/join-our-team": (CAREERS + long_text, sitepages.OK),
            "https://www.arcrobotics.in/products": ("<body>Loading…</body>", sitepages.OK),
        }
        site = sitepages.read_site(company(), homepage_fetch=lambda url: (HOME, "ok"), get=self.getter(pages), sleep=lambda s: None)
        self.assertEqual(site.pages["team"]["outcome"], sitepages.ROBOTS)
        self.assertNotIn("https://www.arcrobotics.in/our-team", self.requested)
        self.assertEqual(site.pages["about"], {"url": "https://www.arcrobotics.in/about-us/", "outcome": "ok", "title": "About", "meta": "Robots for pipes"})
        self.assertEqual(site.pages["products"]["outcome"], sitepages.THIN)
        self.assertEqual(site.careers["roles"], 3)
        self.assertEqual(site.repo, "https://github.com/ArcRobotics")
        self.assertIsNone(site.team)

    def test_a_homepage_that_did_not_answer_is_recorded_and_nothing_else_is_asked(self):
        site = sitepages.read_site(company(), homepage_fetch=lambda url: (None, "refused"), get=self.getter({}), sleep=lambda s: None)
        self.assertEqual(site.pages, {"home": {"url": "https://www.arcrobotics.in", "outcome": sitepages.REFUSED}})
        self.assertEqual(self.requested, [])

    def test_a_missing_page_is_missing_not_unreachable(self):
        pages = {"https://www.arcrobotics.in/robots.txt": (None, sitepages.MISSING)}
        site = sitepages.read_site(company(), homepage_fetch=lambda url: (HOME, "ok"), get=self.getter(pages), sleep=lambda s: None)
        self.assertEqual(site.pages["about"]["outcome"], sitepages.MISSING)


class TheCache(unittest.TestCase):
    def test_only_verified_own_sites_are_read_and_a_fresh_answer_is_reused(self):
        with tempfile.TemporaryDirectory() as directory:
            path = pathlib.Path(directory) / "sitepages.json"
            now = datetime.datetime(2026, 9, 15, tzinfo=datetime.UTC)
            read: list[str] = []

            def reader(c):
                read.append(c.id)
                return sitepages.Site(website=c.website)

            companies = [
                company("v", "https://v.in"),
                company("a", "https://a.in", "associated"),
                company("h", "https://x.github.io"),
                company("l", "https://linkedin.com/company/x"),
            ]
            sitepages.lookup(companies, cache_path=path, read=reader, now=lambda: now)
            self.assertEqual(read, ["v"])
            read.clear()
            found = sitepages.lookup(companies, cache_path=path, read=reader, now=lambda: now + datetime.timedelta(days=29))
            self.assertEqual(read, [])
            self.assertIn("v", found)
            self.assertEqual(json.loads(path.read_text())["v"]["website"], "https://v.in")


if __name__ == "__main__":
    unittest.main()
