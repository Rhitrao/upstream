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
import re
import dataclasses
import traceback

import requests

from ingest import classify as classifier
from ingest import enrich as enricher
from ingest import gaps as gap_labels
from ingest import contact, duplicates, entity, health, identity, names, papers, places, rdap
from ingest import register_labels
from ingest.taxonomy import SUBSECTORS
from ingest.sources import dpiit, fsid, grants_csv, nmicps, rtbi, sine, tides, venture_center
from ingest.sources import base
from ingest.sources.base import Company, Signal
from ingest.upload import PRODUCTION, TIMEOUT_SECONDS, upload

# Order decides which source's description a shared company keeps, and the
# grants CSV goes last on purpose: "BIG awardee, category: Diagnostics" is a
# worse thing to classify on than whatever the incubator wrote about them.
# Venture Center last: a company it shares with an older source keeps that source's row
# and cached classification, so adding it re-buys nothing that was already placed.
SOURCES = [sine, rtbi, grants_csv, dpiit, venture_center, nmicps, fsid, tides]


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
        # A source that reads a local file fetches nothing, and says for itself how
        # current the file is, or has no date at all.
        used = base.FETCHED_AT[start:]
        own = getattr(module, "data_as_of", None)
        as_of[module.SOURCE] = min(used) if used else (own() if own else None)

    return companies, signals, failed, as_of


# Said by us, not by the model: call one returns a bare "none" with no argument
# attached. Written out rather than left blank so the page never shows a hole
# nobody accounted for.
NO_SECTOR = "No sector fits: the classifier placed this company outside all five sunrise sectors."
NO_SECTOR_LABEL = "outside this taxonomy"

SUBSECTOR_NAMES = {s["subsector_id"]: s["subsector"] for s in SUBSECTORS}


def withhold_label_guesses(results: dict, label_only: dict[str, Company]) -> int:
    """Unplace every company whose sub-sector came from a register label that does not name it.

    `label_only` is the companies no source describes in anything but a register label,
    keyed by id. Their cached answer is kept, so this costs nothing and is undone by
    editing ingest/register_labels.py, not by paying again. The result is a gap under
    "no gap named", which the page files as a record too thin to place — which is what
    it is. Returns how many were withheld.
    """
    withheld = 0
    for cid, company in label_only.items():
        result = results.get(cid)
        if result is None or not result.on_map or register_labels.supports(company.description, result.subsector_id):
            continue
        results[cid] = dataclasses.replace(
            result,
            subsector_id=None,
            project_type=None,
            missing=gap_labels.NO_GAP_NAMED,
            note=register_labels.unsupported_note(
                company.description, result.subsector_id, SUBSECTOR_NAMES.get(result.subsector_id, "")
            ),
        )
        withheld += 1
    return withheld


def label_only_companies(copies: list[Company]) -> dict[str, Company]:
    """Companies whose only published text, across every source, is a register label.

    Keyed by id, valued by the register's copy, because that is the text the rule reads.
    A copy with an empty description is not a description: GIGATON's SINE listing names
    it and says nothing, and counting that as "described" let its placement, and four
    others like it, stand as if a source had said what it builds.
    """
    described = {c.id for c in copies if (c.description or "").strip() and not c.description_is_label}
    return {c.id: c for c in copies if c.description_is_label and c.id not in described}


def from_label(classified: Company, label_only: dict[str, Company]) -> bool:
    """Whether the copy the classifier read had nothing but a register label to go on."""
    return classified.description_is_label or (
        not (classified.description or "").strip() and classified.id in label_only
    )


def stale_label_guesses(rows: list[dict], sent: set[str]) -> list[dict]:
    """The same rule, for rows already on the page that this run did not send.

    withhold_label_guesses judges only what the scrape returned, and the register's API
    returns its most recent recognitions: a company that has scrolled out of that window
    is never sent again, so a placement made before the rule existed is never judged by
    it. On 14 September 2026 the nightly withdrew 154 placements and left 18 more
    standing for that reason, fourteen of them in Tier A or B — ZELBYX and CAFIYN still
    in AI in Healthcare on the strength of "NLP".

    `rows` are the Worker's own copies, as /api/companies returns them. Each unsupported
    one comes back as the gap the rule would have filed, which the Worker turns into a
    removal. Costs nothing: no classification, just the table.
    """
    out = []
    for row in rows:
        if row["id"] in sent or row.get("classify_basis") != "register-label":
            continue
        # Label-only, as the run means it: a row whose stored description is prose came
        # from a source that says what the company does, and the label is not all we know.
        if not register_labels.labels(row.get("description")):
            continue
        if register_labels.supports(row.get("description"), row.get("subsector_id")):
            continue
        out.append(
            {
                "company_id": row["id"],
                "name": row["name"],
                "description": row.get("description"),
                "sector_id": row.get("sector_id"),
                "missing": gap_labels.NO_GAP_NAMED,
                "note": register_labels.unsupported_note(
                    row.get("description"), row.get("subsector_id") or "", SUBSECTOR_NAMES.get(row.get("subsector_id"), "")
                ),
            }
        )
    return out


def register_rows(base_url: str) -> list[dict] | None:
    """Every row the register put on the page, or None if that cannot be read completely."""
    rows: dict[str, dict] = {}
    sectors = sorted({s["subsector_id"].split(".")[0] for s in SUBSECTORS})
    try:
        for sector in sectors:
            for undated in ("0", "1"):
                response = requests.get(
                    f"{base_url.rstrip('/')}/api/companies",
                    params={"source": dpiit.SOURCE, "sector": sector, "undated": undated, "tier": "all", "age": "all", "limit": "500"},
                    timeout=TIMEOUT_SECONDS,
                )
                response.raise_for_status()
                data = response.json()
                # At the cap the answer may be cut short, and a sweep that silently
                # misses rows is the failure it exists to fix.
                if data["count"] >= data["limit"]:
                    print(f"  sector {sector} returned {data['count']} register rows, the API's cap: not sweeping")
                    return None
                for row in data["companies"]:
                    rows[row["id"]] = row
    except (requests.RequestException, ValueError, KeyError, TypeError) as error:
        print(f"  could not read the register's rows ({error}): not sweeping")
        return None
    return list(rows.values())


# Sources that publish what a company builds, and so are only worth classifying where a
# record actually does. A name from one of them with no description is not asked about:
# the classifier would be guessing from a name, which this page does not print.
DESCRIBED_SOURCES = frozenset({nmicps.SOURCE, fsid.SOURCE, tides.SOURCE})

# Who is asked first when a run's ceiling cannot cover everyone: what the older sources
# still need, then the new portfolios from the richest descriptions to the thinnest.
CLASSIFY_ORDER = {fsid.SOURCE: 1, tides.SOURCE: 2, nmicps.SOURCE: 3}


def _is_label_or_empty(company: Company) -> bool:
    return not company.description or company.description_is_label


def to_classify(unique: list[Company]) -> list[Company]:
    kept = [c for c in unique if c.description or c.source not in DESCRIBED_SOURCES]
    return sorted(kept, key=lambda c: CLASSIFY_ORDER.get(c.source or "", 0))


DIPP_NUMBER = re.compile(r"\((DIPP\d+)\)")


def evidence_modules() -> list:
    """The evidence collectors, imported here so a missing optional dependency (a PDF
    reader) costs its own list and not the run."""
    from ingest.evidence import birac_big, idex, national_startup_awards, tdb

    return [national_startup_awards, birac_big, tdb, idex]


def held_for_evidence(unique: list[Company], sent: set[str], signals_by_source: dict[str, list[Signal]]) -> list[tuple[str, str, str | None]]:
    """(id, name, DIPP number) for every company this run put on the page. The DIPP
    number is read off the register's own evidence line, where the register gave one."""
    numbers: dict[str, str] = {}
    for signal in signals_by_source.get(dpiit.SOURCE, []):
        found = DIPP_NUMBER.search(signal.label or "")
        if found:
            numbers[signal.company_id] = found.group(1)
    return [(c.id, c.name, numbers.get(c.id)) for c in unique if c.id in sent]


def evidence_signals_for(awards, held) -> list[Signal]:
    """Matched awards as signals. Individuals are never matched: a person on a grant
    list is not a company on ours, whatever their name shares with one."""
    from ingest.evidence import match as evidence_match

    matched = evidence_match.match([a for a in awards if a.is_company], held)
    return [
        Signal(company_id=cid, type=a.type, label=a.label, date=a.date, url=a.url, source=a.source, published=a.published)
        for a, cid in matched
    ]


def attach_evidence(unique: list[Company], sent: set[str], signals_by_source: dict[str, list[Signal]], args) -> int:
    held = held_for_evidence(unique, sent, signals_by_source)
    try:
        modules = evidence_modules()
    except ImportError as error:
        print(f"\nEvidence: not collected ({error})")
        return 0
    print("\nEvidence")
    previous = health.history(args.base_url)
    verdicts = []
    attached = 0
    for module in modules:
        try:
            awards = module.collect()
        except Exception as error:  # noqa: BLE001 - one list, not the run
            verdicts.append(health.failed(module.SOURCE, f"{type(error).__name__}: {error}"))
            print(f"  {module.SOURCE}: FAILED — {error}")
            continue
        last = (previous.get(module.SOURCE) or {}).get("last_success_records")
        verdict = health.judge(module.SOURCE, len(awards), last, None)
        verdicts.append(verdict)
        if verdict.status != health.OK:
            # A list that shrank sharply is a parser problem until shown otherwise; what it
            # attached before stays attached.
            print(f"  {module.SOURCE}: {verdict.status} — {verdict.reason}")
            continue
        signals = evidence_signals_for(awards, held)
        dated = sum(1 for s in signals if s.date)
        print(f"  {module.SOURCE}: {len(awards)} listed, {len(signals)} on companies we hold ({dated} dated)")
        if signals and not args.dry_run:
            upload(module.SOURCE, [], signals, [], base_url=args.base_url, mode=args.mode)
        attached += len(signals)
    if not args.dry_run:
        health.record(args.base_url, verdicts)
    return attached


def gap(company: Company, result) -> dict:
    """An unplaced company as the row the page's off-map section reads.

    Both ways of being unplaced land here. The difference is in the label: a
    named hole ("water infrastructure") is a gap in the taxonomy, while
    "outside this taxonomy" is a company that is not deep tech by its lights.
    Both are worth counting; only the first is worth fixing.
    """
    return {
        "company_id": company.id,
        "name": names.display(company.name),
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

    # Before the dedupe below, so a company listed under two spellings is one id from
    # here on and the dedupe treats it like any company two sources share.
    merge_map = duplicates.merges([c for companies in by_source.values() for c in companies])
    duplicates.apply(by_source, signals_by_source, merge_map)
    print(f"\n{len(merge_map)} duplicate spellings folded into the row that stays: "
          + ", ".join(f"{a} -> {b}" for a, b in sorted(merge_map.items())))

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
                continue
            kept = first[company.id]
            # A real description beats a register label and beats nothing, whichever
            # source uploads last. Until 15 September the last upload won, and the
            # register's dropdown line overwrote SINE's sentence for Gigaton, NCF Green
            # Energy, RELSYM and Agnikul. Between two real descriptions the owner's stands.
            if _is_label_or_empty(kept) and not _is_label_or_empty(company):
                kept.description, kept.description_is_label = company.description, False
                kept.description_source = company.source
            if not kept.city and not kept.state and (company.city or company.state):
                kept.city, kept.state = company.city, company.state
            # What only one source publishes still belongs to the row, whichever source
            # owns it: founders from an incubator card, recognition from the register.
            if not kept.founders and company.founders:
                kept.founders, kept.founders_source = company.founders, company.founders_source
            if not kept.dpiit_status and company.dpiit_status:
                kept.dpiit_status, kept.dpiit_stage = company.dpiit_status, company.dpiit_stage
            if not first[company.id].website and company.website:
                # The owning source may publish no website field at all (the DPIIT
                # register does not). The address another source gives is still the
                # one to check, and checking it once means one answer for both copies.
                first[company.id].website = company.website
                first[company.id].website_checked = True

    for company in unique:
        if company.description and company.description_source is None:
            company.description_source = company.source

    # A source that prints a city and no state still gives a state, where the city is
    # one of the few these sources use. See ingest/places.py.
    for company in unique:
        if not company.state and company.city:
            company.state = places.state_for(company.city)
        company.city = places.place_name(company.city)

    # Before classification, because the classifier is told when a record is a
    # person's project: otherwise it writes "the company" about Aishwarya Dasare.
    for company in unique:
        company.entity_type, company.entity_note = entity.assess(company.name, listed_by[company.id], company.dpiit_status)

    print(f"\nClassifying {len(unique)} companies")
    try:
        results, usage = classifier.classify(to_classify(unique), cost_limit=args.max_cost)
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

    # Only a company with no description anywhere: if any source describes it, the
    # label is not all we know, and the sub-sector is not this rule's to withhold.
    copies = [c for companies in by_source.values() for c in companies]
    label_only = label_only_companies(copies)
    classified_from_label = {c.id for c in unique if from_label(c, label_only)}
    withheld = withhold_label_guesses(results, label_only)
    print(f"  {withheld} placed from a register label that does not name the sub-sector: left unplaced")

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

    # Free, and only for the companies placement kept, for the same reason as the
    # product line: a company off the map has nowhere to show an address. Each one is
    # cached in the repo, so a night only asks about what is new or a month old.
    contacts = contact.lookup(on_map, max_seconds=300)
    registered = rdap.lookup(on_map, max_seconds=300)
    # By the name the page prints, which is the name the cache was filled with: a
    # capitalised register name reads differently to the rule that skips people's names.
    found_papers = papers.lookup([dataclasses.replace(c, name=names.display(c.name)) for c in on_map], max_seconds=600)
    for company in on_map:
        found = contacts.get(company.id)
        if found is not None:
            company.contact_email, company.contact_page = found.email, found.page
        company.domain_registered = registered.get(company.id)
        paper = found_papers.get(company.id)
        if paper is not None:
            company.papers = {
                "count": paper.count,
                "works": [{"title": w.title, "year": w.year, "url": w.url} for w in paper.works],
                "query_url": paper.query_url,
            }
    print(
        f"  {sum(1 for c in contacts.values() if c.email or c.page)} verified sites give a contact route; "
        f"{len(registered)} domains have a registration date; "
        f"{sum(1 for p in found_papers.values() if p.count)} companies are named as an author affiliation"
    )

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
                        # Cased here and not earlier: the classifier's cache is keyed by
                        # the name as the source prints it, and recasing it first would
                        # buy every register company's answer again.
                        "name": names.display(company.name),
                        "sector_id": result.sector_id,
                        "subsector_id": result.subsector_id,
                        # A register label says "Robotics" and a stage. That can carry a
                        # company into a sub-sector; it cannot say which kind of robotic
                        # platform they build, and a project type is exactly that claim.
                        # The classifier still names one, because the prompt asks, so the
                        # claim stops here rather than in the model's answer.
                        #
                        # Read off the copy that was classified, not this source's copy:
                        # a SINE company the register also lists was placed from SINE's
                        # description, and the register's batch must not relabel it.
                        "project_type": None if company.id in classified_from_label else result.project_type,
                        "classify_note": result.note,
                        # Said in the row, not only in the note: a sub-sector
                        # chosen from a register's industry label is a different
                        # kind of claim from one chosen from a description.
                        "classify_basis": "register-label" if company.id in classified_from_label else "description",
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
                        # Every copy carries what the merged row knows, so the order the
                        # sources upload in cannot decide whether a row has founders.
                        # The merged row's description on every copy, so a thinner copy
                        # uploaded later cannot put a register label back.
                        "description": enriched.get(company.id, company).description,
                        "description_source": enriched.get(company.id, company).description_source,
                        "city": enriched.get(company.id, company).city,
                        "state": enriched.get(company.id, company).state,
                        "founders": enriched.get(company.id, company).founders,
                        "founders_source": enriched.get(company.id, company).founders_source,
                        "dpiit_status": enriched.get(company.id, company).dpiit_status,
                        "dpiit_stage": enriched.get(company.id, company).dpiit_stage,
                        "contact_email": enriched.get(company.id, company).contact_email,
                        "contact_page": enriched.get(company.id, company).contact_page,
                        "domain_registered": enriched.get(company.id, company).domain_registered,
                        "papers": enriched.get(company.id, company).papers,
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

    # Only into a row this run sent: a duplicate whose surviving row was not placed is
    # left for the run that places it, rather than folded into nothing.
    folds = [{"from": a, "into": b} for a, b in sorted(merge_map.items()) if b in sent]
    if folds and not args.dry_run:
        upload(owner[folds[0]["into"]], [], [], [], base_url=args.base_url, mode=args.mode, merged=folds)
    unfolded = sorted(a for a, b in merge_map.items() if b not in sent)
    print(f"  {len(folds)} of {len(merge_map)} duplicates folded" + (f"; not placed this run, left as they are: {', '.join(unfolded)}" if unfolded else ""))

    # Award and grant lists, as evidence on companies this run placed and never as a
    # source of new ones. After the uploads, so every id they match exists.
    evidence_signals = attach_evidence(unique, sent, signals_by_source, args)

    # After the uploads, so everything this run re-sent has already been judged above.
    swept: int | None = None
    rows = register_rows(args.base_url)
    if rows is not None:
        stale = stale_label_guesses(rows, sent)
        swept = len(stale)
        print(f"  {swept} register rows this run did not send are placed where their label names nothing: withdrawn")
        if stale and not args.dry_run:
            upload(dpiit.SOURCE, [], [], stale, base_url=args.base_url, mode=args.mode)
            recorded += swept

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
    if swept is None:
        print("  REGISTER SWEEP SKIPPED — older label-only placements were not re-judged this run")
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
