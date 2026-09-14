"""Venture Center, Pune — https://www.venturecenter.co.in/startups-and-success-stories/startups

One plain HTML page of 142 cards, each an <article> inside #StartupsListing with the
name in its h3, a sentence of what the company builds in p.summary, the founders in
p.founded-by, and links. Added for the sentence: a third of this list says nothing
about what a company does, and these cards all do.

Three rules, each against a specific way this goes wrong:

Every field comes from inside its own card. Nothing is collected page-wide and zipped
back together by position — one card with a missing summary would shift every
description after it onto the wrong company, which is RTBI's hyperverge.co error in a
different shape.

The year in brackets after a name is not a founding year. The page never says what
it is — incubation, founding, admission — so it is kept as source_year with its
meaning recorded as unknown, and origin_year and record_year stay empty. Nothing
dates, ages or ranks a company by it. One card reads "(1015)"; an impossible year is
dropped rather than guessed at.

A LinkedIn page is not a company domain. The founders' profiles are links in the same
card, and so, sometimes, is the company's own page; only a link that is not a profile
on another platform can be a website.

Run it: python3 -m ingest.sources.venture_center
"""

from __future__ import annotations

import datetime
import re

from bs4 import BeautifulSoup

from ingest.identity import is_profile
from ingest.sources.base import Company, Signal, clean, fetch, founder_line, preview

SOURCE = "venture-center"
URL = "https://www.venturecenter.co.in/startups-and-success-stories/startups"
LABEL = "Venture Center portfolio"

YEAR_IN_BRACKETS = re.compile(r"\s*\((\d{4})\)\s*$")

# What the bracketed year means, as far as anything on the page says.
YEAR_TYPE_UNKNOWN = "unknown"


def scrape() -> tuple[list[Company], list[Signal]]:
    soup = BeautifulSoup(fetch(URL), "html.parser")
    cards = soup.select("#StartupsListing article")
    if not cards:
        raise ValueError(f"no startup cards under #StartupsListing at {URL} — the page shape changed")

    companies: dict[str, Company] = {}
    signals: list[Signal] = []
    for card in cards:
        company = _card(card)
        if company is None or company.id in companies:
            continue
        companies[company.id] = company
        signals.append(Signal(company_id=company.id, type="incubator", label=LABEL, url=URL, source=SOURCE))
    return list(companies.values()), signals


def _card(card) -> Company | None:
    """One company, from one card and nothing outside it."""
    heading = card.select_one("h3")
    raw = clean(heading.get_text(" ")) if heading else None
    if not raw:
        return None

    year = None
    match = YEAR_IN_BRACKETS.search(raw)
    if match:
        raw = raw[: match.start()].strip()
        year = _plausible(int(match.group(1)))

    summary = card.select_one("p.summary")
    founders = _founders(card)
    return Company.named(
        raw,
        description=clean(summary.get_text(" ")) if summary else None,
        founders=founders,
        founders_source=SOURCE if founders else None,
        website=_website(card),
        source_year=year,
        source_year_type=YEAR_TYPE_UNKNOWN if year is not None else None,
    )


def _founders(card) -> str | None:
    """The names in the card's "Founded by" line, as text. Each name is its own link to
    a LinkedIn profile; the name is what the card says, and the profile is not followed
    or kept (decision 006)."""
    line = card.select_one("p.founded-by")
    if line is None:
        return None
    names = [founder_line(a.get_text(" ")) for a in line.find_all("a")]
    names = [n for n in names if n]
    if not names:
        text = clean(re.sub(r"^\s*Founded\s+by\s*:?", "", line.get_text(" "), flags=re.IGNORECASE))
        names = [founder_line(text)] if text else []
    return ", ".join(n for n in names if n) or None


def _website(card) -> str | None:
    """The card's own link that is not a profile somewhere else.

    The heading's link first, because that is the one the page presents as the
    company; then any other link in the card. Founders' LinkedIn pages are skipped
    wherever they appear.
    """
    anchors = []
    heading = card.select_one("h3 a[href]")
    if heading is not None:
        anchors.append(heading)
    anchors.extend(card.find_all("a", href=True))
    for anchor in anchors:
        href = clean(anchor["href"])
        if href and href.lower().startswith(("http://", "https://")) and not is_profile(href):
            return href
    return None


def _plausible(year: int) -> int | None:
    return year if 1900 <= year <= datetime.date.today().year + 1 else None


if __name__ == "__main__":
    print(preview(*scrape()))
