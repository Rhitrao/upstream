"""DPIIT Startup India — the public recognition register.

https://www.startupindia.gov.in/content/sih/en/search.html?roles=Startup

473,000 recognised startups, which is both why this source matters and why it
has to be read carefully. It is the earliest public trace most Indian companies
leave: DPIIT recognition arrives long before an incubator portfolio page, a
grant list or a press mention, which is exactly the window this whole project is
trying to see into.

The site's own search calls a public, no-login endpoint — /api/noauth/search/profiles
— so that is what we call, with the same delay, retries and cache as every other
source here. Pages are fixed at nine records and the size parameter is ignored,
so 473,000 startups is 52,000 requests: reading the whole register is off the
table and would be rude besides.

Two things make that fine. The default order runs oldest first, so the LAST
pages of a filtered search are the newest recognitions — the last page of
Nanotechnology today holds companies recognised three days ago. And the industry
filter cuts the register down to the ones this page is about. So we read the
final few pages of each deep-tech industry and leave the other 470,000 alone.

What the endpoint does NOT give: no incorporation date, no description, no
website. Only the name, where they are, their industry and sector, and how far
along they say they are. `registeredOn` is the DPIIT recognition date, not the
date the company was founded — see _origin_year.

    python3 -m ingest.sources.dpiit
"""

from __future__ import annotations

import argparse
import datetime

from ingest.sources.base import Company, Signal, clean, fetch_json, preview, slugify

SOURCE = "dpiit-startup-india"
URL = "https://api.startupindia.gov.in/sih/api/noauth/search/profiles"
PROFILE = "https://www.startupindia.gov.in/content/sih/en/search.html?roles=Startup&query="

# The register's own industry ids. Names are not accepted by the filter, only
# these; they come from the facet block the search returns alongside results.
# Chosen to match the RDI taxonomy's sunrise sectors — the register's other 46
# industries are retail, fashion, travel, events and so on, and nothing there is
# what this page is looking for.
INDUSTRIES = {
    "Nanotechnology": "5f48ce5f2a9bb065cdfa1750",
    "Biotechnology": "5f48d0ca2a9bb065cdfc47b5",
    "Computer Vision": "5f48ce5f2a9bb065cdfa173c",
    "Robotics": "5f48ce5f2a9bb065cdfa1756",
    "Aeronautics Aerospace & Defence": "5f48ce5f2a9bb065cdfa1731",
    "Internet of Things": "5f48ce5f2a9bb065cdfa174c",
    "Green Technology": "5f48ce5f2a9bb065cdfa1743",
    "Renewable Energy": "5f48ce5f2a9bb065cdfa1742",
    "AI": "5f48ce5f2a9bb065cdfa1733",
    "Technology Hardware": "5f48ce5f2a9bb065cdfa1749",
}

# Pages from the end of each industry, nine records each. Ten is about 900
# records and a hundred requests; raising it reaches further back in time, which
# is the opposite of the point.
PAGES = 10


def scrape(pages: int = PAGES) -> tuple[list[Company], list[Signal]]:
    companies: dict[str, Company] = {}
    signals: list[Signal] = []

    for industry, industry_id in INDUSTRIES.items():
        first = _search(industry_id, 0)
        total_pages = first.get("totalPages") or 0
        if total_pages == 0:
            raise ValueError(f"no results for {industry} at {URL} — the industry ids or the API changed")

        for page in range(max(0, total_pages - pages), total_pages):
            for record in _search(industry_id, page).get("content") or []:
                company = _company(record, industry)
                if company is None or company.id in companies:
                    continue
                companies[company.id] = company
                signals.append(
                    Signal(
                        company_id=company.id,
                        type="dpiit",
                        label=_label(record),
                        date=_date(record.get("registeredOn")),
                        url=PROFILE,
                        source=SOURCE,
                    )
                )

    return list(companies.values()), signals


def _search(industry_id: str, page: int) -> dict:
    return fetch_json(URL, {"query": "", "roles": ["Startup"], "industries": [industry_id], "page": page})


def _company(record: dict, industry: str) -> Company | None:
    name = clean(record.get("name"))
    if not name or not slugify(name):
        return None

    return Company.named(
        name,
        description=_description(record, industry),
        city=clean(record.get("city")),
        state=clean(record.get("state")),
        origin_year=_origin_year(record),
    )


def _description(record: dict, industry: str) -> str:
    """All the register publishes about what they do, which is not much.

    Industry, sector and stage, said plainly and marked as the register's own
    words. There is no free-text description behind this endpoint, so this is
    the whole of what the classifier will have to work from — thinner than any
    other source here, and the reason a lot of these will come back unplaced.
    """
    sectors = [s for s in (record.get("sectors") or []) if s and s != "Others"]
    stages = [s for s in (record.get("stages") or []) if s]

    parts = [f"DPIIT-recognised startup. Industry: {industry}."]
    if sectors:
        parts.append(f"Sector: {', '.join(sectors)}.")
    if stages:
        parts.append(f"Stage: {', '.join(stages)}.")
    return " ".join(parts)


def _label(record: dict) -> str:
    number = clean(record.get("dippNumber"))
    year = _origin_year(record)
    recognised = f"DPIIT recognised {year}" if year else "DPIIT recognised"
    return f"{recognised} ({number})" if number else recognised


def _origin_year(record: dict) -> int | None:
    """The year DPIIT recognised them.

    NOT the incorporation year: the register does not publish one through this
    endpoint. Recognition requires incorporation within the previous ten years,
    so this is an upper bound that can be up to a decade late — the only date
    here that errs towards making a company look younger than it is. The upsert
    keeps whichever year is earliest, so any source that knows better wins.
    """
    stamp = record.get("registeredOn")
    if not isinstance(stamp, (int, float)) or stamp <= 0:
        return None
    return datetime.datetime.fromtimestamp(stamp / 1000, datetime.UTC).year


def _date(stamp) -> str | None:
    if not isinstance(stamp, (int, float)) or stamp <= 0:
        return None
    return datetime.datetime.fromtimestamp(stamp / 1000, datetime.UTC).date().isoformat()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pages", type=int, default=PAGES, help="pages from the end of each industry")
    args = parser.parse_args()
    print(preview(*scrape(args.pages)))
