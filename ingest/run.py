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
from ingest.sources import rtbi, sine
from ingest.sources.base import Company, Signal
from ingest.upload import PRODUCTION, upload

SOURCES = [sine, rtbi]


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
    print(f"  {len(placed)} placed on the map, {dropped} dropped as none")

    print("\nUploading" if not args.dry_run else "\nDry run: nothing uploaded")
    uploaded = 0
    for source, companies in by_source.items():
        # A company Claude could not place is not sent at all. Guessing would
        # corrupt the coverage map, and an unplaced row would sit there claiming
        # a sub-sector nobody chose.
        keep = []
        for company in companies:
            result = results.get(company.id)
            if company.id not in placed or result is None:
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
        if args.dry_run:
            print(f"  {source}: would send {len(keep)} companies, {len(traces)} signals")
            continue
        upload(source, keep, traces, base_url=args.base_url, mode=args.mode)
        uploaded += len(keep)

    print("\nSummary")
    print(f"  sources: {len(by_source)} ok, {len(failed)} failed{' — ' + ', '.join(failed) if failed else ''}")
    print(f"  companies: {len(unique)} seen, {len(placed)} placed, {dropped} dropped")
    print(f"  classification: {usage}")
    print(f"  uploaded: {uploaded}" if not args.dry_run else "  uploaded: nothing (dry run)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
