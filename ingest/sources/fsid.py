"""FSID, IISc Bangalore — https://fsid-iisc.in/our-startups/

The Foundation for Science Innovation and Development incubates companies out of the
Indian Institute of Science. Its "Our Startups" page draws nothing into its HTML: the
list comes from the page's own WordPress search, a form POST to admin-ajax.php with
action=search_incubatees, thirty to a page, which answers in JSON with the company's
name, a description, its sector, its website and its social links. robots.txt
disallows /wp-admin/ and allows admin-ajax.php by name, so this is the call the site
invites. It is posted to www.fsid-iisc.in, the address the page itself posts to; the
bare domain redirects, and a redirected POST comes back as a GET.

The page publishes no dates of any kind — not incubation, not graduation — so the
signal is undated and so is the company. It publishes no founders either.

The answer also carries an email address for most companies, and some descriptions
end in "Other Email IDs:" and a list of people's addresses. None of it is kept.

Two entries read like something other than a startup, "International Center for Nano
Devices" and "Lab to Market (L2M Rail)". The source lists them among its incubatees
and marks them no differently, so they are kept; whether they are companies is
ingest/entity.py's to judge, across every source that lists them.

Run it: python3 -m ingest.sources.fsid
"""

from __future__ import annotations

import json

from ingest.sources.base import Company, Signal, clean, fetch_form, preview
from ingest.sources.portfolio import own_website, text_of

SOURCE = "fsid-iisc"
URL = "https://fsid-iisc.in/our-startups/"
AJAX = "https://www.fsid-iisc.in/wp-admin/admin-ajax.php"
PER_PAGE = 30
LABEL = "FSID IISc incubatee"
# About four pages today. A total_count that would need more than this is a broken
# answer, not a foundation that grew tenfold.
MAX_PAGES = 40


def scrape() -> tuple[list[Company], list[Signal]]:
    companies: dict[str, Company] = {}
    for record in _records():
        company = _company(record)
        if company is None:
            continue
        kept = companies.get(company.id)
        if kept is None:
            companies[company.id] = company
        else:
            kept.description = kept.description or company.description
            kept.website = kept.website or company.website

    if not companies:
        raise ValueError(f"no named incubatees from {AJAX} (action=search_incubatees) — the endpoint changed")
    signals = [Signal(company_id=cid, type="incubator", label=LABEL, url=URL, source=SOURCE) for cid in companies]
    return list(companies.values()), signals


def _records() -> list[dict]:
    """Every incubatee the search hands out, with the form the page's own script sends:
    an empty search, an empty sector, and the page number."""
    records: list[dict] = []
    total = None
    for page in range(1, MAX_PAGES + 1):
        form = {"action": "search_incubatees", "search": "", "domain": "", "paged": page}
        try:
            body = json.loads(fetch_form(AJAX, form))
        except ValueError as error:
            raise ValueError(f"{AJAX} did not answer search_incubatees with JSON — the endpoint changed") from error
        result = body.get("result") if isinstance(body, dict) else None
        if not isinstance(result, list):
            raise ValueError(f"no result list in the answer from {AJAX} — the endpoint changed")
        if total is None and isinstance(body.get("total_count"), int):
            total = body["total_count"]
        records.extend(r for r in result if isinstance(r, dict))
        if len(result) < PER_PAGE or (total is not None and len(records) >= total):
            break
    return records


def _company(record: dict) -> Company | None:
    """One company, from one record and nothing outside it.

    Only the website field can be a website. The twitter, linkedin and instagram fields
    are the company's too, but a profile is not a domain, and they are not kept.
    """
    name = text_of(record.get("title"))
    if not name:
        return None
    company = Company.named(
        name,
        description=text_of(record.get("content")),
        website=own_website(record.get("website")),
    )
    return company if company.id else None


if __name__ == "__main__":
    print(preview(*scrape()))
