"""The whole pipeline: scrape, classify, upload, say what happened.

One source failing must never stop the others. A scraper breaks when someone
redesigns a page, which is a Tuesday, not an emergency — the rest of the run
still has work to do and the summary says which source went quiet.

    python3 -m ingest.run --dry-run                     # scrape and classify, upload nothing
    python3 -m ingest.run --base-url http://127.0.0.1:8788/upstream
    python3 -m ingest.run                               # production
"""

from __future__ import annotations

import argparse
import traceback

from ingest import classify as classifier
from ingest import gaps as gap_labels
from ingest.sources import dpiit, grants_csv, rtbi, sine
from ingest.sources.base import Company, Signal
from ingest.upload import PRODUCTION, upload

# Order decides which source's description a shared company keeps, and the
# grants CSV goes last on purpose: "BIG awardee, category: Diagnostics" is a
# worse thing to classify on than whatever the incubator wrote about them.
SOURCES = [sine, rtbi, grants_csv, dpiit]


def scrape_all() -> tuple[dict[str, list[Company]], dict[str, list[Signal]], list[str]]:
    """Every source that works, and the names of the ones that did not."""
    companies: dict[str, list[Company]] = {}
    signals: dict[str, list[Signal]] = {}
    failed: list[str] = []

    for module in SOURCES:
        try:
            found, traces = module.scrape()
            companies[module.SOURCE] = found
            signals[module.SOURCE] = traces
            print(f"  {module.SOURCE}: {len(found)} companies, {len(traces)} signals")
        except Exception:
            # Loud in the log, fatal to nothing.
            failed.append(module.SOURCE)
            print(f"  {module.SOURCE}: FAILED")
            traceback.print_exc()

    return companies, signals, failed


# Said by us, not by the model: call one returns a bare "none" with no argument
# attached. Written out rather than left blank so the page never shows a hole
# nobody accounted for.
NO_SECTOR = "No sector fits: the classifier placed this company outside all five sunrise sectors."
NO_SECTOR_LABEL = "outside this taxonomy"


def gap(company: Company, result) -> dict:
    """An unplaced company as the row the page's off-map section reads.

    Both ways of being unplaced land here. The difference is in the label: a
    named hole ("water infrastructure") is a gap in the taxonomy, while
    "outside this taxonomy" is a company that is not deep tech by its lights.
    Both are worth counting; only the first is worth fixing.
    """
    return {
        "company_id": company.id,
        "name": company.name,
        "description": company.description,
        "sector_id": result.sector_id,
        # Grouped by the canonical name a person has reviewed, not by the
        # wording of the one call that happened to produce it.
        "missing": gap_labels.canonical(result.missing) or NO_SECTOR_LABEL,
        "note": result.note or NO_SECTOR,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", default=PRODUCTION)
    parser.add_argument("--dry-run", action="store_true", help="scrape and classify, upload nothing")
    parser.add_argument("--mode", choices=["backfill", "live"], help="override what the Worker would infer")
    args = parser.parse_args()

    print("Scraping")
    by_source, signals_by_source, failed = scrape_all()
    if not by_source:
        print("Every source failed. Nothing to upload.")
        return 1

    # One company can appear in two portfolios. The first source to mention it
    # owns the row; the other's signals still attach, because a signal is keyed
    # by company id and both sources genuinely saw it.
    seen: set[str] = set()
    unique: list[Company] = []
    for source in by_source:
        for company in by_source[source]:
            if company.id not in seen:
                seen.add(company.id)
                unique.append(company)

    print(f"\nClassifying {len(unique)} companies")
    results, usage = classifier.classify(unique)
    print(f"  {usage}")

    placed = {cid for cid, result in results.items() if result.on_map}
    dropped = len(unique) - len(placed)
    print(f"  {len(placed)} placed on the map, {dropped} unplaced")

    print("\nUploading" if not args.dry_run else "\nDry run: nothing uploaded")
    uploaded = 0
    recorded = 0
    sent: set[str] = set()
    for source, companies in by_source.items():
        # A company Claude could not place is not sent at all. Guessing would
        # corrupt the coverage map, and an unplaced row would sit there claiming
        # a sub-sector nobody chose.
        keep = []
        gaps = []
        for company in companies:
            result = results.get(company.id)
            if result is None:
                continue
            if company.id not in placed:
                gaps.append(gap(company, result))
                continue
            keep.append(
                Company(
                    **{
                        **{f.name: getattr(company, f.name) for f in company.__dataclass_fields__.values()},
                        "sector_id": result.sector_id,
                        "subsector_id": result.subsector_id,
                        "project_type": result.project_type,
                        "classify_note": result.note,
                    }
                )
            )

        kept_ids = {c.id for c in keep}
        traces = [s for s in signals_by_source[source] if s.company_id in kept_ids]
        # A company already sent as a placed row by an earlier source is not a
        # gap, whatever this source's copy of it looks like.
        gaps = [g for g in gaps if g["company_id"] not in sent]
        sent.update(c.id for c in keep)

        if args.dry_run:
            print(f"  {source}: would send {len(keep)} companies, {len(traces)} signals, {len(gaps)} gaps")
            continue
        upload(source, keep, traces, gaps, base_url=args.base_url, mode=args.mode)
        uploaded += len(keep)
        recorded += len(gaps)

    print("\nSummary")
    print(f"  sources: {len(by_source)} ok, {len(failed)} failed{' — ' + ', '.join(failed) if failed else ''}")
    print(f"  companies: {len(unique)} seen, {len(placed)} placed, {dropped} dropped")
    print(f"  classification: {usage}")
    print(f"  uploaded: {uploaded} companies, {recorded} gaps" if not args.dry_run else "  uploaded: nothing (dry run)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
