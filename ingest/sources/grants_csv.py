"""Government grant winners, typed up by hand from published lists.

BIRAC, DST and the rest publish their awardees as PDFs laid out for printing, in
a different shape every year. Scraping that is a week of work that breaks on the
next call, so the rows live in grants.csv and this module only reads the file.
Automate it when it has proved worth automating.

Every row traces to a published list, and the url column says which. Nothing is
in this file that was not read off one of those documents.

This is the highest-signal source in the system: a government technical panel has
already reviewed the science. No website, no press release and no incubator badge
says as much about whether the work is real.

    python3 -m ingest.sources.grants_csv
"""

from __future__ import annotations

import csv
import pathlib
import re

from ingest.sources.base import Company, Signal, clean, preview, website

SOURCE = "grants-csv"
CSV_PATH = pathlib.Path(__file__).parent / "grants.csv"

# Columns beyond BUILD's five. The published lists carry a site and a city for
# some awardees, and throwing away a verified fact to match a sketch of the file
# format would be a strange kind of tidiness.
FIELDS = ["company_name", "scheme", "award_date", "project_summary", "url", "website", "city"]


def scrape() -> tuple[list[Company], list[Signal]]:
    if not CSV_PATH.exists():
        raise ValueError(f"{CSV_PATH} is missing")

    companies: dict[str, Company] = {}
    signals: list[Signal] = []
    seen: set[tuple[str, str]] = set()

    with CSV_PATH.open(encoding="utf-8", newline="") as handle:
        reader = csv.DictReader(handle)
        missing = [f for f in FIELDS if f not in (reader.fieldnames or [])]
        if missing:
            raise ValueError(f"{CSV_PATH} is missing columns: {', '.join(missing)}")

        for row in reader:
            name = clean(row["company_name"])
            scheme = clean(row["scheme"])
            if not name or not scheme:
                continue

            company = Company.named(
                name,
                description=clean(row["project_summary"]),
                website=website(row["website"]),
                city=clean(row["city"]),
                origin_year=_year(row["award_date"]),
            )
            # A company can win twice. The first row owns the company record and
            # every row contributes its own signal.
            companies.setdefault(company.id, company)

            if (company.id, scheme) not in seen:
                seen.add((company.id, scheme))
                signals.append(
                    Signal(
                        company_id=company.id,
                        type="grant",
                        label=scheme,
                        date=clean(row["award_date"]),
                        url=clean(row["url"]),
                        source=SOURCE,
                    )
                )

    return list(companies.values()), signals


def _year(award_date: str | None) -> int | None:
    """The year off the front of the award date.

    For BIRAC this is the day the awardee list was published, which is the only
    public date attached to a call; for PRAYAS it is the published year of
    support. Both mean "funded by then", which is an upper bound on when the
    company started rather than the founding year itself — the upsert keeps
    whichever year is earliest, so a better-informed source still wins.
    """
    match = re.search(r"\b(19|20)\d{2}\b", award_date or "")
    return int(match.group(0)) if match else None


if __name__ == "__main__":
    print(preview(*scrape()))
