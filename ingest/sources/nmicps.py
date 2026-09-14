"""NM-ICPS Technology Innovation Hubs — https://nmicps.gov.in/startups

The Department of Science and Technology's cyber-physical systems mission funds 25
technology innovation hubs at IITs and institutes, and each hub seed-funds startups.
The mission's own site lists them all on one page, "Seed funded Startups", which
fills itself from a public JSON endpoint without any login:
nmicpsbck.nmicps.gov.in/newdata/new-startup, a hundred records a page. Each record
carries the startup's name, founders, a product brief, an incubation date, a website
and the hub that funded it.

Every hub keys its own records, and it shows. Four rules follow from what they typed:

The incubation date is an event, written five ways. A full date ("2023-09-22") and a
support period ("2021-07-15 - 2023-07-14") date the signal to the day the support
began; a bare "2023" dates it to the year. A financial year ("2022-23", "2023-2024")
is kept in the label and dates nothing, because it spans two calendar years and
choosing one would be a guess. Only a real date or a single calendar year sets
record_year, and nothing here is a founding year.

The website box is mostly not a website. A hundred and thirty records say "NA" or
nothing; others hold a LinkedIn page, a browser tab's title, or an address a CMS
mangled into "https:--uavio-in-". portfolio.own_website says no to each.

A brief of one to three words is a product name, not a description. "Flow",
"Migrarelief" and "School Transport, AI" say what a thing is called, and a
description field holding one would let the page imply we know what it does.

One hub's list is another hub's list. IIT Patna's 56 records are IIT Indore's 56,
name for name and brief for brief, and Patna's own site lists none of them. A hub
whose every record repeats another hub's is dropped as a copy, and said so.

A company funded by two hubs is one company with two signals: two sets of people chose
it. The same company listed twice under one hub is one signal.

Run it: python3 -m ingest.sources.nmicps
"""

from __future__ import annotations

import datetime
import json
import logging
import re

from ingest.sources.base import Company, Signal, clean, fetch, founder_line, preview, slugify
from ingest.sources.portfolio import own_website, without_contacts

SOURCE = "nmicps-tih"
URL = "https://nmicps.gov.in/startups"
API = "https://nmicpsbck.nmicps.gov.in/newdata/new-startup?page={page}&limit={limit}"
LIMIT = 100
# The endpoint reports about nine pages. Far more than that is a loop that never ends,
# not a mission that grew tenfold overnight.
MAX_PAGES = 60

log = logging.getLogger(__name__)

# The names people know the hubs by, keyed by the registered foundation name the
# endpoint gives. A hub missing here is labelled with its institute and that name,
# which is longer and still true.
HUBS = {
    "iit kharagpur ai4icps i-hub foundation": "IIT Kharagpur AI4ICPS",
    "i-dapt-hub foundation": "IIT BHU I-DAPT",
    "i-hub for robotics and autonomous systems innovation foundation": "IISc ARTPARK",
    "nmicps technology innovation hub on autonomous navigation foundation": "IIT Hyderabad TiHAN",
    "tih foundation for iot and ioe": "IIT Bombay TIH IoT and IoE",
    "iitm pravartak technologies foundation": "IIT Madras Pravartak",
    "ihub ntihac foundation": "IIT Kanpur C3iHub",
    "ihub drishti foundation": "IIT Jodhpur iHub Drishti",
    "iit tirupati navavishkar i-hub foundation": "IIT Tirupati Navavishkar",
    "iit patna vishlesan i-hub foundation": "IIT Patna Vishlesan",
    "iit mandi ihub and hci foundation": "IIT Mandi iHub and HCi",
    "divyasampark ihub roorkee for devices materials and technology foundation": "IIT Roorkee Divyasampark",
    "iit ropar -technology and innovation foundation": "IIT Ropar AWaDH",
    "technology innovation in exploration & mining foundation": "IIT (ISM) Dhanbad TEXMiN",
    "iit palakkad technology ihub foundation": "IIT Palakkad IPTIF",
    "iiitb comet foundation": "IIIT Bangalore COMET",
    "bits biocytih foundation": "BITS Pilani BioCyTiH",
    "ideas- institute of data engineering, analytics and science foundation": "ISI Kolkata IDEAS",
    "iiti drishti cps foundation": "IIT Indore Drishti CPS",
    "ihub anubhuti-iiitd foundation": "IIIT Delhi Anubhuti",
    "i-hub quantum technology foundation": "IISER Pune I-Hub Quantum",
    "iit bhilai innovation and technology foundation": "IIT Bhilai IBITF",
}

# Below this many records, two hubs sharing every one of them can be two hubs that
# funded the same few companies. Patna's copy is 56.
MIN_COPY = 10

# A brief this short is a product's name.
MIN_BRIEF_WORDS = 4

ISO_DATE = re.compile(r"(\d{4})-(\d{2})-(\d{2})")
DMY_DATE = re.compile(r"(\d{2})-(\d{2})-(\d{4})")
YEAR = re.compile(r"\d{4}")
# "2022-23", "2022 - 23", "2023-2024", "2025 -  2026": one financial year.
FINANCIAL_YEAR = re.compile(r"(\d{4})\s*-\s*(\d{2}|\d{4})")
NOT_FUNDED = re.compile(r"\bnot\s+given\s+any\s+funds?\b|\bno\s+funds?\b", re.IGNORECASE)


def scrape() -> tuple[list[Company], list[Signal]]:
    records = _records()
    records = _without_copies(records)

    companies: dict[str, Company] = {}
    events: dict[tuple[str, str], tuple] = {}
    for index, record in enumerate(records):
        company = _company(record)
        if company is None:
            continue
        kept = companies.get(company.id)
        companies[company.id] = _merge(kept, company) if kept else company

        hub = _hub(record)
        date, when, year = _when(record.get("incub_date"))
        # One signal per company per hub: the dated record where there is one, then
        # the earliest date, then the first listed.
        key = (company.id, hub)
        candidate = (date is None, date or "", index, date, when, year, record)
        if key not in events or candidate < events[key]:
            events[key] = candidate

    signals = []
    for (company_id, hub), (_, _, _, date, when, year, record) in sorted(events.items(), key=lambda item: item[1][2]):
        if year is not None:
            company = companies[company_id]
            company.record_year = year if company.record_year is None else min(company.record_year, year)
        signals.append(
            Signal(
                company_id=company_id,
                type="incubator",
                label=_label(hub, when, record),
                date=date,
                url=URL,
                source=SOURCE,
            )
        )
    return list(companies.values()), signals


def _records() -> list[dict]:
    """Every record the endpoint hands out, page by page until a short page."""
    records: list[dict] = []
    for page in range(1, MAX_PAGES + 1):
        url = API.format(page=page, limit=LIMIT)
        try:
            body = json.loads(fetch(url))
        except ValueError as error:
            raise ValueError(f"{url} did not answer with JSON — the endpoint changed") from error
        data = body.get("data") if isinstance(body, dict) else None
        if not isinstance(data, list):
            raise ValueError(f"no data list in the answer from {url} — the endpoint changed")
        records.extend(r for r in data if isinstance(r, dict))
        if len(data) < LIMIT:
            break
    if not any(clean(r.get("startup_name")) for r in records):
        raise ValueError(f"no named startups from {API.format(page=1, limit=LIMIT)} — the endpoint changed")
    return records


def _without_copies(records: list[dict]) -> list[dict]:
    """The records less any hub's list that is only a copy of another hub's.

    A hub is a copy when it has at least MIN_COPY records and every one of them, by
    name and brief, is also listed under another hub. When two hubs are exact copies of
    each other the page gives no way to tell which is the original, except in the one
    case we have checked by hand: Patna's own site lists none of its records and
    Indore's lists them, so Patna is the copy. Anywhere else the later hub goes, and
    the log says which, so a reader can look.

    Then, whatever the whole-list test found, a Patna record whose name is also under
    Indore goes too, in case the copy is ever partly edited.
    """
    lists: dict[str, set[tuple[str, str]]] = {}
    for record in records:
        lists.setdefault(_hub(record), set()).add(_fingerprint(record))

    order = list(lists)
    copies: set[str] = set()
    for hub in order:
        for other in order:
            if hub == other or other in copies or len(lists[hub]) < MIN_COPY:
                continue
            if not lists[hub] <= lists[other]:
                continue
            if lists[hub] == lists[other]:
                if _institute(other) == "patna" or (_institute(hub) != "patna" and order.index(hub) < order.index(other)):
                    continue
            copies.add(hub)
            log.warning("%s: dropped %d records under %s, a copy of %s's list", SOURCE, len(lists[hub]), hub, other)
            break

    indore = {slugify(clean(r.get("startup_name")) or "") for r in records if _institute(_hub(r)) == "indore"}
    kept = []
    for record in records:
        hub = _hub(record)
        if hub in copies:
            continue
        if _institute(hub) == "patna" and slugify(clean(record.get("startup_name")) or "") in indore:
            log.warning("%s: dropped %r under IIT Patna, also listed under IIT Indore", SOURCE, record.get("startup_name"))
            continue
        kept.append(record)
    return kept


def _company(record: dict) -> Company | None:
    """One company, from one record and nothing outside it."""
    name = clean(record.get("startup_name"))
    if not name or not slugify(name):
        return None
    founders = founder_line(without_contacts(record.get("founder_name")))
    return Company.named(
        name,
        description=_description(name, record.get("product_brief")),
        founders=founders,
        founders_source=SOURCE if founders else None,
        website=own_website(record.get("website_url")),
    )


def _description(name: str, brief: str | None) -> str | None:
    """The brief, unless it is only the product's name or the company's."""
    text = without_contacts(brief)
    if not text or len(text.split()) < MIN_BRIEF_WORDS:
        return None
    if re.sub(r"[^a-z0-9]", "", text.lower()) == re.sub(r"[^a-z0-9]", "", name.lower()):
        return None
    return text


def _when(value: str | None) -> tuple[str | None, str | None, int | None]:
    """(signal date, the words for the label, record year) from an incubation date.

    Returns the date only at the precision the text gives, and the year only when the
    text names one calendar year or one day in it.
    """
    text = clean(value)
    if not text:
        return None, None, None
    compact = re.sub(r"\s*-\s*", "-", text)

    day = _day(text)
    if day is not None and re.fullmatch(r"\d{4}-\d{2}-\d{2}", text):
        return day.isoformat(), day.isoformat(), _plausible(day.year)

    # A support period: two dates. The first is when support began.
    period = re.fullmatch(r"(\S+)\s+-\s+(\S+)", text)
    if period:
        start, end = _day(period.group(1)), _day(period.group(2))
        if start is not None and _plausible(start.year):
            finish = end.isoformat() if end else period.group(2)
            return start.isoformat(), f"{start.isoformat()} to {finish}", start.year

    if YEAR.fullmatch(text) and _plausible(int(text)):
        return text, text, int(text)

    fy = FINANCIAL_YEAR.fullmatch(text)
    if fy:
        first, second = int(fy.group(1)), fy.group(2)
        following = first + 1
        if (len(second) == 2 and int(second) == following % 100) or (len(second) == 4 and int(second) == following):
            return None, compact, None

    return None, text, None


def _day(text: str) -> datetime.date | None:
    for pattern, order in ((ISO_DATE, (1, 2, 3)), (DMY_DATE, (3, 2, 1))):
        match = pattern.fullmatch(text)
        if match:
            year, month, day = (int(match.group(i)) for i in order)
            try:
                return datetime.date(year, month, day)
            except ValueError:
                return None
    return None


def _label(hub: str, when: str | None, record: dict) -> str:
    """"IIT Ropar AWaDH (NM-ICPS) seed-funded startup, 2025-09-19".

    The page's heading is "Seed funded Startups", so that is what membership means,
    except for the record that says in its own date field that it was not funded.
    """
    if when and NOT_FUNDED.search(when):
        return f"{hub} (NM-ICPS) incubatee, {when}"
    if not when:
        when = _financial_year(record.get("year_id"))
    return f"{hub} (NM-ICPS) seed-funded startup, {when}" if when else f"{hub} (NM-ICPS) seed-funded startup"


def _financial_year(year_id) -> str | None:
    """The year the page's own filter files a record under, for a record with no date.

    The page's code maps 1 to "2020-21" and counts on from there.
    """
    if not isinstance(year_id, int) or year_id < 1:
        return None
    start = 2019 + year_id
    return f"{start}-{(start + 1) % 100:02d}"


def _hub(record: dict) -> str:
    hub = record.get("master_hub") or {}
    name = clean(hub.get("hub_name")) or ""
    short = HUBS.get(name.lower())
    if short:
        return short
    institute = clean((hub.get("master_institute") or {}).get("institute_name"))
    return clean(f"{institute or ''} {name}") or "NM-ICPS hub"


def _institute(hub: str) -> str | None:
    """'patna' or 'indore' for the two hubs the copy rule knows about, else None."""
    lowered = hub.lower()
    for place in ("patna", "indore"):
        if place in lowered:
            return place
    return None


def _fingerprint(record: dict) -> tuple[str, str]:
    name = slugify(clean(record.get("startup_name")) or "")
    brief = re.sub(r"[^a-z0-9]", "", (record.get("product_brief") or "").lower())
    return name, brief


def _merge(kept: Company, repeat: Company) -> Company:
    """The first record's company, with blanks filled from a later one."""
    kept.description = kept.description or repeat.description
    kept.website = kept.website or repeat.website
    if not kept.founders and repeat.founders:
        kept.founders, kept.founders_source = repeat.founders, repeat.founders_source
    return kept


def _plausible(year: int) -> int | None:
    # The mission began in 2018; a year before that, or past next year, is a typo.
    return year if 2018 <= year <= datetime.date.today().year + 1 else None


if __name__ == "__main__":
    print(preview(*scrape()))
