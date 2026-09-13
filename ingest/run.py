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
from ingest import enrich as enricher
from ingest import gaps as gap_labels
from ingest import entity, health, identity
from ingest.sources import dpiit, grants_csv, rtbi, sine
from ingest.sources import base
from ingest.sources.base import Company, Signal
from ingest.upload import PRODUCTION, upload

# Order decides which source's description a shared company keeps, and the
# grants CSV goes last on purpose: "BIG awardee, category: Diagnostics" is a
# worse thing to classify on than whatever the incubator wrote about them.
SOURCES = [sine, rtbi, grants_csv, dpiit]


def scrape(module) -> tuple[list[Company], list[Signal]]:
    """One source, with every company stamped with where it came from.

    The only way anything in this pipeline gets companies out of a scraper. The
    cache key is scoped by source, so a company with no source silently falls back
    to the default prompt version — which is how scoping a key can look like it
    works while doing nothing at all. One choke point, so there is nowhere to
    forget it.
    """
    companies, signals = module.scrape()
    for company in companies:
        company.source = module.SOURCE
    return companies, signals


def scrape_all() -> tuple[dict[str, list[Company]], dict[str, list[Signal]], dict[str, str], dict[str, str | None]]:
    """Every source that returned, why each other one did not, and how old each one's pages are."""
    companies: dict[str, list[Company]] = {}
    signals: dict[str, list[Signal]] = {}
    failed: dict[str, str] = {}
    as_of: dict[str, str | None] = {}

    for module in SOURCES:
        start = len(base.FETCHED_AT)
        try:
            found, traces = scrape(module)
            companies[module.SOURCE] = found
            signals[module.SOURCE] = traces
            print(f"  {module.SOURCE}: {len(found)} companies, {len(traces)} signals")
        except Exception as error:  # noqa: BLE001 - recorded, and the run goes red
            failed[module.SOURCE] = f"{type(error).__name__}: {error}"
            print(f"  {module.SOURCE}: FAILED")
            traceback.print_exc()
        # The oldest page used, since a source is only as current as its stalest page.
        # A source that reads a local file fetches nothing and has no such date.
        used = base.FETCHED_AT[start:]
        as_of[module.SOURCE] = min(used) if used else None

    return companies, signals, failed, as_of


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
    parser.add_argument(
        "--max-cost",
        type=float,
        help=f"stop classifying after this much, in dollars (default {classifier.DEFAULT_MAX_COST})",
    )
    args = parser.parse_args()

    print("Scraping")
    by_source, signals_by_source, failed, as_of = scrape_all()

    # Judged before anything is classified or sent: a source that returned nothing, or
    # far less than last time, is set aside whole and yesterday's rows for it stand.
    print("\nSource health")
    previous = health.history(args.base_url)
    verdicts = [health.failed(source, reason) for source, reason in failed.items()]
    for source, companies in by_source.items():
        last = previous.get(source) or {}
        verdicts.append(health.judge(source, len(companies), last.get("last_success_records"), as_of.get(source)))
    for verdict in verdicts:
        print(f"  {verdict.source}: {verdict.status}, {verdict.records} records" + (f" — {verdict.reason}" if verdict.reason else ""))
        if verdict.status != health.OK:
            by_source.pop(verdict.source, None)
            signals_by_source.pop(verdict.source, None)
    unhealthy = [v for v in verdicts if v.status != health.OK]
    if not args.dry_run:
        health.record(args.base_url, verdicts)

    if not by_source:
        print("\nSummary")
        print("  RUN FAILED — no source is fit to upload")
        for verdict in unhealthy:
            print(f"  {verdict.source}: {verdict.status} — {verdict.reason}")
        return 1

    # One company can appear in two portfolios. The first source to mention it
    # owns the row; the other's signals still attach, because a signal is keyed
    # by company id and both sources genuinely saw it.
    owner: dict[str, str] = {}
    unique: list[Company] = []
    first: dict[str, Company] = {}
    listed_by: dict[str, set[str]] = {}
    for source in by_source:
        for company in by_source[source]:
            listed_by.setdefault(company.id, set()).add(source)
            if company.id not in owner:
                owner[company.id] = source
                unique.append(company)
                first[company.id] = company
            elif not first[company.id].website and company.website:
                # The owning source may publish no website field at all (the DPIIT
                # register does not). The address another source gives is still the
                # one to check, and checking it once means one answer for both copies.
                first[company.id].website = company.website
                first[company.id].website_checked = True

    # Before classification, because the classifier is told when a record is a
    # person's project: otherwise it writes "the company" about Aishwarya Dasare.
    for company in unique:
        company.entity_type, company.entity_note = entity.assess(company.name, listed_by[company.id])

    print(f"\nClassifying {len(unique)} companies")
    try:
        results, usage = classifier.classify(unique, cost_limit=args.max_cost)
    except classifier.ConfigurationError as error:
        # Nothing is uploaded and the job goes red. A run that cannot classify has
        # no new placements to publish, and the scraped rows are unchanged from
        # yesterday's — writing them again would turn a broken key into a
        # successful-looking run, which is the failure being fixed here.
        print("\nSummary")
        print("  RUN FAILED — configuration error, not a data problem")
        print(f"  {error}")
        print("  uploaded: nothing")
        print("\nFix the ANTHROPIC_API_KEY secret and re-run; the cache makes the retry cheap.")
        return 2
    print(f"  {usage}")

    placed = {cid for cid, result in results.items() if result.on_map}
    dropped = len(unique) - len(placed)
    print(f"  {len(placed)} placed on the map, {dropped} unplaced")

    # Reading homepages comes after placement, and only for the companies placement
    # kept. An unplaced company is not a row — it is a line in the off-map section
    # under the name of the hole it fell through — so it has nowhere to put a product
    # sentence, and paying to read its website buys a string with no cell to live in.
    # That is a third of the websites in the scrape.
    #
    # Whatever the night's ceiling did not spend on classification is what is left to
    # spend here, in that order: a company that cannot be placed never reaches the
    # page at all, so placing them matters more than describing them. On a normal
    # night classification is entirely cached, costs nothing, and all of it arrives.
    on_map = [company for company in unique if company.id in placed]
    remaining = classifier.max_cost(args.max_cost) - usage.cost
    try:
        products, product_usage = enricher.enrich(
            on_map, max_cost=max(remaining, 0.0), shared=identity.shared_hosts(unique)
        )
    except classifier.ConfigurationError as error:
        # Not fatal to the run. Classification already succeeded, which means there
        # are placements worth publishing; losing the product lines costs this run a
        # column, not its output, and the cache keeps whatever was already bought.
        products, product_usage = {}, classifier.Usage()
        print(f"  reading homepages stopped: {error}")
    described = sum(1 for product in products.values() if product.described)
    print(f"  {described} of {len(products)} homepages said what the company builds. {product_usage}")
    enricher.apply(on_map, products)

    # A homepage that answered is a trace (Part 9's "live website"), and until now
    # nothing collected it. It rides in the batch of the source that owns the row, so
    # the company it attaches to is always in the same request.
    websites = enricher.website_traces(on_map, products)
    for trace in websites:
        signals_by_source[owner[trace.company_id]].append(trace)
    print(f"  {len(websites)} homepages answered and count as a trace")

    enriched = {company.id: company for company in unique}

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
                        # A register label says "Robotics" and a stage. That can carry a
                        # company into a sub-sector; it cannot say which kind of robotic
                        # platform they build, and a project type is exactly that claim.
                        # The classifier still names one, because the prompt asks, so the
                        # claim stops here rather than in the model's answer.
                        "project_type": None if company.description_is_label else result.project_type,
                        "classify_note": result.note,
                        # Said in the row, not only in the note: a sub-sector
                        # chosen from a register's industry label is a different
                        # kind of claim from one chosen from a description.
                        "classify_basis": "register-label" if company.description_is_label else "description",
                        # enrich.apply wrote these onto the deduplicated company, which
                        # is a different object from this one when two sources both
                        # published the same firm.
                        "product": enriched.get(company.id, company).product,
                        "product_status": enriched.get(company.id, company).product_status,
                        # The address that was checked and what the check said, on every
                        # copy of the company, so the second source to send it cannot put
                        # back the address the first one's check rejected.
                        "website": enriched.get(company.id, company).website,
                        "website_checked": enriched.get(company.id, company).website_checked,
                        "website_identity": enriched.get(company.id, company).website_identity,
                        "website_identity_note": enriched.get(company.id, company).website_identity_note,
                        "entity_type": enriched.get(company.id, company).entity_type,
                        "entity_note": enriched.get(company.id, company).entity_note,
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
    # Failures first, before anything that looks like an achievement. A count
    # buried under four lines of progress is a count nobody reads, and the whole
    # point of printing it is that somebody notices.
    if usage.failed:
        print(f"  {usage.failed} COMPANIES COULD NOT BE CLASSIFIED — see the errors above")
    else:
        print("  no classification failures")
    for verdict in unhealthy:
        print(f"  SOURCE {verdict.status.upper()} — {verdict.source}: {verdict.reason}. Nothing uploaded from it; its rows from the last good run stand.")
    print(f"  sources: {len(by_source)} ok, {len(unhealthy)} set aside{' — ' + ', '.join(v.source for v in unhealthy) if unhealthy else ''}")
    print(f"  companies: {len(unique)} seen, {len(placed)} placed, {dropped} dropped")
    print(f"  classification: {usage}")
    print(f"  uploaded: {uploaded} companies, {recorded} gaps" if not args.dry_run else "  uploaded: nothing (dry run)")
    # Per-company failures are tolerated, reported and survivable: one company
    # whose answer would not parse is one row missing, not a broken pipeline.
    #
    # A source that failed or was set aside is not survivable in that sense: the page
    # now carries data that is older than the run's date, and the job has to go red so
    # somebody looks. Everything healthy has already been uploaded by this point.
    return 3 if unhealthy else 0


if __name__ == "__main__":
    raise SystemExit(main())
