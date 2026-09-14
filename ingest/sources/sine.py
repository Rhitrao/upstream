"""SINE, IIT Bombay — https://www.sineiitb.org/portfolio/

The portfolio page renders client-side, so there is no list in the HTML to parse. The
data is in the response anyway: Next.js ships the page's props as RSC flight chunks in
`self.__next_f.push([1, "..."])`, and the CMS payload sits inside them — name,
founders, description, website, sector, year of incubation. Reading that beats parsing
a rendered DOM: no browser, no markup guessing, and the fields arrive already named.

Three lists live on that page — incubation, seed investments, grantees — and they
overlap. Companies are deduped by slug and every membership becomes its own signal. A
company on all three lists is a company three sets of people already know, which is
exactly what trace_count is for.

Only the incubation records carry a year, so a company known here solely as a grantee
or a seed investment arrives undated, and the page says so rather than guessing.

Run it: python3 -m ingest.sources.sine
"""

from __future__ import annotations

import json
import re

from ingest.sources.base import Company, Signal, clean, fetch, founder_line, preview, website

SOURCE = "sine-iitb"
URL = "https://www.sineiitb.org/portfolio/"
INCUBATOR = "SINE IIT Bombay"

# Only the first shows people a company was incubated; the other two are money that
# arrived. Both count the same toward trace_count, so the type is about saying what
# the trace actually was.
SIGNAL_TYPES = {
    "portfolio.incubation": "incubator",
    "portfolio.seed-investments": "grant",
    "portfolio.grantees": "grant",
}


def scrape() -> tuple[list[Company], list[Signal]]:
    companies: dict[str, Company] = {}
    signals: list[Signal] = []
    seen: set[tuple[str, str]] = set()

    for entry in _entries(fetch(URL)):
        name = clean(entry.get("title"))
        records = [r for r in entry.get("portfolio_data") or [] if isinstance(r, dict)]
        if not name or not records:
            continue

        company = _company(name, records)
        # Later lists repeat companies. Keep the first, then let a repeat fill in only
        # what was blank — no list here is more authoritative than another.
        existing = companies.get(company.id)
        companies[company.id] = _merge(existing, company) if existing else company

        for record in records:
            label = _label(record)
            if label is None or (company.id, label) in seen:
                continue
            seen.add((company.id, label))
            signals.append(
                Signal(
                    company_id=company.id,
                    type=SIGNAL_TYPES.get(record.get("__component"), "incubator"),
                    label=label,
                    url=URL,
                    source=SOURCE,
                )
            )

    return list(companies.values()), signals


def _entries(html: str) -> list[dict]:
    """Every company object across the three `portfolios` arrays, in page order."""
    decoder = json.JSONDecoder()
    flight = []
    for match in re.finditer(r"self\.__next_f\.push\((\[1,)", html):
        # raw_decode does the unescaping, which hand-rolled \uXXXX handling gets wrong
        # on exactly the non-breaking spaces this CMS is full of.
        try:
            chunk, _ = decoder.raw_decode(html, match.start(1))
        except ValueError:
            continue
        if len(chunk) > 1 and isinstance(chunk[1], str):
            flight.append(chunk[1])

    payload = "".join(flight)
    entries: list[dict] = []
    for match in re.finditer(r'"portfolios":', payload):
        try:
            array, _ = decoder.raw_decode(payload, match.end())
        except ValueError:
            continue
        entries.extend(e for e in array if isinstance(e, dict))

    if not entries:
        raise ValueError(f"no portfolio data in the flight payload at {URL} — the page shape changed")
    return entries


def _company(name: str, records: list[dict]) -> Company:
    """One company from its records, taking the first non-empty value of each field."""
    return Company.named(
        name,
        description=_first(records, "description", clean),
        website=_first(records, "website", website),
        origin_year=_origin_year(records),
        founders=_founders(records),
        founders_source=SOURCE if _founders(records) else None,
    )


def _founders(records: list[dict]) -> str | None:
    """The founder line as SINE prints it, less the full stop some entries end on.

    A company listed in two programmes can carry the line twice, once with its commas
    and once without — "Nisha Yadav, Saugandha Das" and "Nisha Yadav Saugandha Das" —
    and the second reads as one person with four names. The one that separates the
    most names wins; otherwise the first.
    """
    lines = [v for v in (founder_line(r.get("founder_name")) for r in records) if v]
    if not lines:
        return None
    separated = lambda line: len(re.findall(r",|&|;|\band\b", line))
    return max(lines, key=separated)


def _origin_year(records: list[dict]) -> int | None:
    """The earliest incubation year any record gives, as a year.

    Only year_of_incubation is read. The other date field, year_bifurcation, is a
    five-year bucket — "Y-2021-2025" — and reading a bucket as a year would put a 2025
    company four years in the past. Every record that has a bucket has the real year
    too, so nothing is lost by ignoring it.
    """
    years = [_start_year(r.get("year_of_incubation")) for r in records]
    found = [y for y in years if y is not None]
    return min(found) if found else None


def _start_year(value: str | None) -> int | None:
    match = re.search(r"\b(19|20)\d{2}\b", clean(value) or "")
    return int(match.group(0)) if match else None


def _first(records: list[dict], key: str, convert):
    for record in records:
        value = convert(record.get(key))
        if value:
            return value
    return None


def _merge(kept: Company, repeat: Company) -> Company:
    years = [y for y in (kept.origin_year, repeat.origin_year) if y is not None]
    return Company(
        id=kept.id,
        name=kept.name,
        description=kept.description or repeat.description,
        website=kept.website or repeat.website,
        founders=max((f for f in (kept.founders, repeat.founders) if f), key=lambda f: len(re.findall(r",|&|;|\band\b", f)), default=None),
        founders_source=kept.founders_source or repeat.founders_source,
        # The earliest claim wins: a company is no younger than the first list it
        # appeared on.
        origin_year=min(years) if years else None,
    )


def _label(record: dict) -> str | None:
    """What this record says, short enough to read in a list row.

    The cohort and programme names are the useful part: "SINE IIT Bombay DST NIDHI
    PRAYAS, Cohort 1" says more than a bare incubator name ever could.
    """
    component = record.get("__component")

    if component == "portfolio.incubation":
        parts = [INCUBATOR, "incubatee", _years(record.get("year_of_incubation"))]
    elif component == "portfolio.seed-investments":
        parts = [INCUBATOR, "seed investment", clean(record.get("fund_name")) or clean(record.get("funding_agency"))]
    elif component == "portfolio.grantees":
        programme = clean(record.get("program_name"))
        cohort = clean(record.get("cohort"))
        parts = [INCUBATOR, programme, cohort if programme else None]
    else:
        return None

    label = " ".join(p for p in parts[:2] if p)
    tail = ", ".join(p for p in parts[2:] if p)
    return f"{label}, {tail}" if tail else label or None


def _years(value: str | None) -> str | None:
    """"Y-2024-2025" is the CMS's way of writing an academic year. Ours is "2024-2025"."""
    years = clean(value)
    return years[2:] if years and years.lower().startswith("y-") else years


if __name__ == "__main__":
    print(preview(*scrape()))
