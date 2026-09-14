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
website. Only the name, where they are, their industry and sector, how far along
they say they are, and whether DPIIT has recognised them — which not every record
on the register has. `registeredOn` dates the register's record, not the founding
and not necessarily a recognition — see _record_year and recognition.

    python3 -m ingest.sources.dpiit
"""

from __future__ import annotations

import argparse
import datetime

from ingest.sources.base import Company, Signal, clean, fetch_json, preview, slugify

SOURCE = "dpiit-startup-india"
URL = "https://api.startupindia.gov.in/sih/api/noauth/search/profiles"
SEARCH = "https://www.startupindia.gov.in/content/sih/en/search.html?roles=Startup&query="

# dippRecognitionStatus, as the register writes it, to what the page says. Counted
# across the 966 register records cached on 14 September 2026: 598 RECOGNISED with a
# DIPP number, 345 with no status and no number, 15 EXPIRED, 6 PENDING, 1 CANCELLED,
# 1 NA. Every one of them used to be labelled "DPIIT recognised".
RECOGNITION = {"RECOGNISED": "recognised", "EXPIRED": "expired", "CANCELLED": "cancelled", "PENDING": "pending"}
PROFILE_ONLY = "profile"

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
                        # The register's public search page. Not a search for the name:
                        # the public search endpoint returns nothing for an exact name
                        # (tried 14 September 2026), and the profile page asks for a login.
                        url=SEARCH,
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
        # Not a description of the company: an industry label the founder picked
        # from a list of 56 at application time. Everything downstream that would
        # otherwise present it as knowledge reads this flag.
        description_is_label=True,
        # The register has no website field, so its silence is not evidence.
        website_checked=False,
        city=clean(record.get("city")),
        state=clean(record.get("state")),
        dpiit_status=recognition(record),
        dpiit_stage=next((s for s in (record.get("stages") or []) if clean(s)), None),
        # record_year, never origin_year. The register says when it recognised the
        # company, not when the company started, and writing a recognition year
        # into the founding field is the exact lie this split exists to prevent.
        record_year=_record_year(record),
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


def recognition(record: dict) -> str:
    """What the register says about recognition, which is not the same as being on it.

    Anyone can make a Startup India profile. Recognition is DPIIT assessing it and
    issuing a DIPP number, and a record with neither a status nor a number has not
    been through that, whatever the search page lists it under.
    """
    status = (clean(record.get("dippRecognitionStatus")) or "").upper()
    return RECOGNITION.get(status, PROFILE_ONLY)


def _label(record: dict) -> str:
    """The evidence line, saying what the record says and no more.

    No year: registeredOn is on records that were never recognised too, so it dates the
    record, and printing it beside "recognised" would claim it dates a recognition.
    """
    number = clean(record.get("dippNumber"))
    suffix = f" ({number})" if number else ""
    status = recognition(record)
    if status == "recognised":
        return f"DPIIT recognised{suffix}"
    if status in ("expired", "cancelled"):
        return f"DPIIT recognition {status}{suffix}"
    if status == "pending":
        return "Startup India profile, DPIIT recognition pending"
    return "Startup India profile, not DPIIT recognised"


def _record_year(record: dict) -> int | None:
    """The year of the register's record, which dates the record and nothing else.

    Checked three ways before settling for it: the search endpoint publishes 30
    fields and no incorporation date, the CIN lookup wants a CIN this endpoint
    never gives, and the profile page asks you to log in. So there is no founding
    year for these companies anywhere public, and the page says so rather than
    letting a recognition year stand in for one — recognition only requires
    incorporation within the previous ten years, so a company founded in 2019 and
    recognised last week would otherwise read as brand new.
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
