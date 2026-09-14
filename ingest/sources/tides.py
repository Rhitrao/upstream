"""TIDES, IIT Roorkee — https://tides.iitr.ac.in/portfolio

The Technology Incubation and Entrepreneurship Development Society lists every company
it has incubated on one page, about 240 of them. The page is a Next.js site rendered
on the server, and it ships its data in the __NEXT_DATA__ script: one list of records,
each with a title, a description, a link, a status (CURRENT or GRADUATED) and a
sector. That list is what is read, rather than the cards drawn from it, for one
reason: a card whose company has no logo is drawn as the name alone, with no
description and no status, and thirteen of them are. The record behind the card has
both.

Status is kept in the signal label — "TIDES IIT Roorkee, current incubatee" or
"…, graduated" — because a company still in the building and one that left years ago
are different traces, and Company has no field for it.

The link is a website only sometimes. Nearly ninety are "#", empty or missing; others
are a LinkedIn page, a ZaubaCorp or IndiaFilings registry lookup, or a bare
"www.mantiswave.in" that the card renders as a relative link. portfolio.own_website
takes the domains and refuses the rest.

The list block asks the CMS for at most 300 records. At 241 that is not yet a limit,
but a page that one day lists exactly 300 has probably stopped listing the rest.

The page gives no dates of any kind. Two companies are listed twice ("Verdant
Autobots" and "Verdant AutoBots", and "FarmAssistant"), and each is one company with
one signal.

Run it: python3 -m ingest.sources.tides
"""

from __future__ import annotations

import json
import re

from ingest.sources.base import Company, Signal, fetch, preview
from ingest.sources.portfolio import own_website, text_of

SOURCE = "tides-iitr"
URL = "https://tides.iitr.ac.in/portfolio"
INCUBATOR = "TIDES IIT Roorkee"

NEXT_DATA = re.compile(r'<script id="__NEXT_DATA__" type="application/json">(.*?)</script>', re.DOTALL)

STATUS = {"CURRENT": "current incubatee", "GRADUATED": "graduated"}


def scrape() -> tuple[list[Company], list[Signal]]:
    companies: dict[str, Company] = {}
    labels: dict[str, str] = {}
    for record in _records(fetch(URL)):
        company = _company(record)
        if company is None:
            continue
        kept = companies.get(company.id)
        if kept is None:
            companies[company.id] = company
            labels[company.id] = _label(record)
            continue
        kept.description = kept.description or company.description
        kept.website = kept.website or company.website
        # A repeat that gives a status the first listing lacked says more.
        if labels[company.id] == INCUBATOR:
            labels[company.id] = _label(record)

    if not companies:
        raise ValueError(f"no named portfolio records in __NEXT_DATA__ at {URL} — the page shape changed")
    signals = [Signal(company_id=cid, type="incubator", label=labels[cid], url=URL, source=SOURCE) for cid in companies]
    return list(companies.values()), signals


def _records(html: str) -> list[dict]:
    """The portfolio list: every list in the page data whose records carry a title, a
    description and a status, which on this page is exactly one."""
    match = NEXT_DATA.search(html)
    if not match:
        raise ValueError(f"no __NEXT_DATA__ script at {URL} — the page shape changed")
    try:
        data = json.loads(match.group(1))
    except ValueError as error:
        raise ValueError(f"__NEXT_DATA__ at {URL} is not JSON — the page shape changed") from error

    found: list[dict] = []

    def walk(node) -> None:
        if isinstance(node, dict):
            for value in node.values():
                walk(value)
        elif isinstance(node, list):
            if node and all(isinstance(r, dict) and {"title", "desci", "category"} <= r.keys() for r in node):
                found.extend(node)
                return
            for value in node:
                walk(value)

    walk(data)
    return found


def _company(record: dict) -> Company | None:
    """One company, from one record and nothing outside it."""
    name = text_of(record.get("title"))
    if not name:
        return None
    company = Company.named(
        name,
        description=text_of(record.get("desci")),
        website=own_website(record.get("link")),
    )
    return company if company.id else None


def _label(record: dict) -> str:
    status = STATUS.get((record.get("category") or "").strip().upper())
    return f"{INCUBATOR}, {status}" if status else INCUBATOR


if __name__ == "__main__":
    print(preview(*scrape()))
