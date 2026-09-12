"""Put each company on the RDI map, or admit we cannot.

Two calls to Claude, both constrained by the taxonomy's own ids rather than by
hope: call one picks a sector from five or says `none`, call two picks a
sub-sector from only that sector's four to sixteen, the closest project type,
and a one-line reason. Choosing from 44 sub-sectors and 250 project types in one
prompt is less accurate and no cheaper.

`none` means the company is dropped. A wrongly tagged company corrupts the
coverage map, which is the one thing on the page that claims to be complete.

Every result is cached in ingest/cache/classify.json, keyed by company id and a
hash of the exact text we sent. Re-running is free; changing a description, the
prompt or the model re-classifies that company and nothing else. The cache is
committed, so the classifications are reproducible without an API key.

    python3 -m ingest.classify --limit 20 --table    # look before you spend
    python3 -m ingest.classify --estimate            # what the rest would cost
    python3 -m ingest.classify                       # everything not cached
"""

from __future__ import annotations

import argparse
import concurrent.futures
import dataclasses
import datetime
import hashlib
import json
import pathlib
import threading

import os

import anthropic

from ingest.sources.base import Company, clean
from ingest.taxonomy import SUBSECTORS, TAXONOMY

MODEL = "claude-haiku-4-5"

# $ per million tokens, from the model's pricing page. Only used to print what a
# run cost; nothing branches on it.
PRICE_IN = 1.00
PRICE_OUT = 5.00

# Part of the cache key, so a reworded prompt re-classifies rather than silently
# mixing two generations of judgement. Scoped per source, because the prompt is
# shared code but our confidence in the answers is not: SINE and the grant
# compendium publish real descriptions and their classifications have never been
# in doubt, while the register publishes an industry label and its placements are
# the ones worth revisiting. Bumping one source re-pays for that source alone.
#
# Raising a number here spends money. 1,542 companies at once is about $3.70.
DEFAULT_PROMPT_VERSION = 3
PROMPT_VERSIONS = {
    "sine-iitb": 3,
    "rtbi-iitm": 3,
    "grants-csv": 3,
    "dpiit-startup-india": 3,
}


def prompt_version(source: str | None) -> int:
    return PROMPT_VERSIONS.get(source or "", DEFAULT_PROMPT_VERSION)

CACHE_PATH = pathlib.Path(__file__).parent / "cache" / "classify.json"
OVERRIDES_PATH = pathlib.Path(__file__).parent / "overrides.json"

SECTORS = [s for s in TAXONOMY["sectors"] if s["type"] == "sunrise"]
SECTOR_BY_ID = {s["id"]: s for s in SECTORS}

MAX_TOKENS = 400
WORKERS = 8

# What one run is allowed to spend before it stops and says so.
#
# The whole budget for this project is $5, and the thing that could take it in an
# afternoon is not a price rise — it is a scraper that starts returning 5,000 rows
# because someone redesigned a page. A ceiling turns that from an empty balance
# into a log line. Overridable per run, and by the scheduled job, which has
# nobody watching it.
DEFAULT_MAX_COST = 0.25
MAX_COST_ENV = "UPSTREAM_MAX_COST"

# What one company has cost, measured over 1,542 of them. Used to reserve against
# the ceiling for calls already in flight: without it, eight workers all pass the
# check at zero and the first batch is unconditional, which on a small ceiling
# means spending double it.
COST_PER_COMPANY = 0.003


def max_cost(explicit: float | None = None) -> float:
    if explicit is not None:
        return explicit
    from_env = os.environ.get(MAX_COST_ENV)
    if from_env:
        try:
            return float(from_env)
        except ValueError:
            raise SystemExit(f"{MAX_COST_ENV} is not a number: {from_env!r}") from None
    return DEFAULT_MAX_COST


class BudgetReached(Exception):
    """Not an error: the run did what it was told and stopped."""

# Both answers are short: an id, a project string, one sentence. Measured at 76
# per company over the first 20; rounded up because it is the one part of the
# bill that cannot be counted before the call is made.
OUTPUT_TOKENS_ASSUMED = 85


@dataclasses.dataclass(slots=True)
class Classification:
    """What we decided about one company, and why.

    Two ways to come back unplaced, and the difference is worth keeping: no
    sector fits at all, or a sector fits but none of its sub-sectors do. Both
    stay off the map; only the second tells you the taxonomy has a hole in it.
    """

    sector_id: str | None
    subsector_id: str | None = None
    project_type: str | None = None
    note: str | None = None
    missing: str | None = None
    source: str = "claude"

    @property
    def on_map(self) -> bool:
        return self.sector_id is not None and self.subsector_id is not None


@dataclasses.dataclass(slots=True)
class Usage:
    """Tokens actually billed, and the calls that were free."""

    calls: int = 0
    input_tokens: int = 0
    output_tokens: int = 0
    cached: int = 0
    overridden: int = 0
    failed: int = 0
    over_budget: int = 0

    def add(self, response) -> None:
        self.calls += 1
        self.input_tokens += response.usage.input_tokens
        self.output_tokens += response.usage.output_tokens

    @property
    def cost(self) -> float:
        return (self.input_tokens * PRICE_IN + self.output_tokens * PRICE_OUT) / 1_000_000

    def __str__(self) -> str:
        said = (
            f"{self.calls} calls, {self.input_tokens:,} in / {self.output_tokens:,} out, "
            f"${self.cost:.4f} — {self.cached} from cache, {self.overridden} overridden"
        )
        if self.failed:
            said += f", {self.failed} FAILED"
        if self.over_budget:
            said += f", {self.over_budget} left unclassified at the cost ceiling"
        return said


# --- the two prompts --------------------------------------------------------


def _company_text(company: Company) -> str:
    description = clean(company.description) or "(no description published)"
    return f"Company: {company.name}\nWhat they do: {description}"


SECTOR_SYSTEM = """You place Indian deep-tech companies into one sector of the government's \
Research, Development and Innovation scheme taxonomy.

Pick the single sector whose scope the company's work actually falls inside. If none of them \
fits, or the description is too thin to tell, answer "none". A wrong sector is worse than \
"none": it puts the company on a map that is supposed to show where we have looked."""


def _sector_prompt(company: Company) -> str:
    lines = [_company_text(company), "", "Sectors:"]
    lines += [f"  {s['id']} — {s['short']}: {s['name']}" for s in SECTORS]
    lines += ["", 'Which sector, or "none"?']
    return "\n".join(lines)


SUBSECTOR_SYSTEM = """You place Indian deep-tech companies into one sub-sector of the \
government's Research, Development and Innovation scheme taxonomy.

The sector is already decided. Pick the sub-sector within it that best matches the company's \
work, then the single closest project type from the ones listed under that sub-sector, and \
give a one-sentence reason a reader could check against the description.

If none of these sub-sectors actually covers what the company does, answer "none" for both \
and say what is missing. Stretching a company into the nearest sub-sector puts a wrong tag \
on a map that is supposed to show where we have looked — "none" is the better answer, and \
the sector being right does not oblige you to find a sub-sector that is not.

When you answer "none", also name the missing capability in two to four lowercase words, as \
a plain noun phrase: "water infrastructure", "geospatial services", "digital health \
infrastructure". Name the field the taxonomy is missing, not this company — two companies \
falling through the same hole must get the same name. Leave it empty when you chose a \
sub-sector."""


def _subsector_prompt(company: Company, sector: dict) -> str:
    lines = [_company_text(company), "", f"Sector {sector['id']} — {sector['name']}", "", "Sub-sectors:"]
    for sub in sector["subsectors"]:
        lines.append(f"  {sub['id']} — {sub['name']}")
        lines += [f"      · {project}" for project in sub["projects"]]
    lines += ["", 'Which sub-sector, which project type, and why? Or "none" for both.']
    return "\n".join(lines)


def _sector_schema() -> dict:
    return {
        "type": "json_schema",
        "schema": {
            "type": "object",
            "properties": {"sector_id": {"type": "string", "enum": [s["id"] for s in SECTORS] + ["none"]}},
            "required": ["sector_id"],
            "additionalProperties": False,
        },
    }


def _subsector_schema(sector: dict) -> dict:
    # The enums are the taxonomy's own ids and project strings, so an invalid
    # answer is not something the model can return — no parsing, no fuzzy
    # matching, no tag that looks real but is not.
    projects = [p for sub in sector["subsectors"] for p in sub["projects"]]
    return {
        "type": "json_schema",
        "schema": {
            "type": "object",
            "properties": {
                "subsector_id": {"type": "string", "enum": [sub["id"] for sub in sector["subsectors"]] + ["none"]},
                "project_type": {"type": "string", "enum": projects + ["none"]},
                "reason": {"type": "string"},
                # Free text, unlike everything else here, because the holes in a
                # taxonomy cannot be enumerated in advance — that is what makes
                # them holes. Grouped by exact match on the page, with
                # ingest/gap-labels.json to tidy the near-misses by hand.
                "missing": {"type": "string"},
            },
            "required": ["subsector_id", "project_type", "reason", "missing"],
            "additionalProperties": False,
        },
    }


# --- the calls --------------------------------------------------------------


def _ask(client: anthropic.Anthropic, system: str, prompt: str, schema: dict, usage: Usage, lock: threading.Lock) -> dict:
    response = client.messages.create(
        model=MODEL,
        max_tokens=MAX_TOKENS,
        system=system,
        messages=[{"role": "user", "content": prompt}],
        output_config={"format": schema},
    )
    with lock:
        usage.add(response)
    text = next(block.text for block in response.content if block.type == "text")
    return json.loads(text)


def _classify_one(client: anthropic.Anthropic, company: Company, usage: Usage, lock: threading.Lock) -> Classification:
    chosen = _ask(client, SECTOR_SYSTEM, _sector_prompt(company), _sector_schema(), usage, lock)["sector_id"]
    if chosen == "none":
        return Classification(sector_id=None)

    sector = SECTOR_BY_ID[chosen]
    answer = _ask(client, SUBSECTOR_SYSTEM, _subsector_prompt(company, sector), _subsector_schema(sector), usage, lock)

    if answer["subsector_id"] == "none":
        # The sector was right and nothing under it fits. Keep the sector, the
        # reason and the name of the hole: unplaced for want of a sub-sector is a
        # fact about the taxonomy, and this is the only way it ever gets noticed.
        return Classification(
            sector_id=sector["id"],
            note=clean(answer["reason"]),
            missing=clean(answer.get("missing")),
        )

    subsector = next(sub for sub in sector["subsectors"] if sub["id"] == answer["subsector_id"])
    project = answer["project_type"]
    # The enum spans the whole sector, so the model can pick a project that
    # belongs to a different sub-sector than the one it just chose. Keeping that
    # pair would file a real-looking mismatch in the audit trail.
    if project not in subsector["projects"]:
        project = None

    return Classification(
        sector_id=sector["id"],
        subsector_id=subsector["id"],
        project_type=project,
        note=clean(answer["reason"]),
    )


# --- cache and overrides ----------------------------------------------------


def _fingerprint(company: Company) -> str:
    """What we are about to send, as one short hash.

    The model and the prompt version are in here on purpose: re-running after
    either changes is a different question, and answering it from cache would
    quietly mix two generations of judgement.

    The version is this source's. The shape of the hashed material is deliberately
    unchanged from when the version was global — every source starts at the number
    it already had, so scoping the key cost nothing and invalidated nothing.
    """
    material = json.dumps(
        [company.name, clean(company.description), MODEL, prompt_version(company.source)],
        sort_keys=True,
    )
    return hashlib.sha256(material.encode("utf-8")).hexdigest()[:16]


def _client() -> anthropic.Anthropic:
    """The SDK resolves ANTHROPIC_API_KEY itself; .env is here for a Codespace.

    A key in .env never reaches git — the file is ignored — and it keeps the
    pipeline runnable without a shell that persists between commands.
    """
    if os.environ.get("ANTHROPIC_API_KEY"):
        return anthropic.Anthropic()

    env_file = pathlib.Path(__file__).parent.parent / ".env"
    if env_file.exists():
        for line in env_file.read_text(encoding="utf-8").splitlines():
            name, _, value = line.partition("=")
            if name.strip() == "ANTHROPIC_API_KEY" and value.strip():
                return anthropic.Anthropic(api_key=value.strip().strip("\"'"))

    return anthropic.Anthropic()


def _load(path: pathlib.Path) -> dict:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def _save_cache(entries: dict) -> None:
    CACHE_PATH.parent.mkdir(parents=True, exist_ok=True)
    CACHE_PATH.write_text(json.dumps(entries, indent=1, sort_keys=True) + "\n", encoding="utf-8")


def _from_cache(entry: dict) -> Classification:
    return Classification(
        sector_id=entry.get("sector_id"),
        subsector_id=entry.get("subsector_id"),
        project_type=entry.get("project_type"),
        note=entry.get("note"),
        missing=entry.get("missing"),
        source="cache",
    )


def _override(entry: dict) -> Classification:
    return Classification(
        sector_id=entry.get("sector_id"),
        subsector_id=entry.get("subsector_id"),
        project_type=entry.get("project_type"),
        note=entry.get("note") or "Manual override.",
        missing=entry.get("missing"),
        source="override",
    )


# --- the run ----------------------------------------------------------------


def classify(
    companies: list[Company],
    *,
    force: bool = False,
    cost_limit: float | None = None,
) -> tuple[dict[str, Classification], Usage]:
    """Classify what is not already known, up to the cost ceiling.

    A company already in the cache is never re-classified and never charged for;
    that is the only reason a daily job is affordable at all.
    """
    ceiling = max_cost(cost_limit)
    cache = _load(CACHE_PATH)
    overrides = _load(OVERRIDES_PATH)
    usage = Usage()
    results: dict[str, Classification] = {}
    todo: list[Company] = []

    for company in companies:
        if company.id in overrides:
            results[company.id] = _override(overrides[company.id])
            usage.overridden += 1
            continue
        entry = cache.get(company.id)
        if entry and not force and entry.get("hash") == _fingerprint(company):
            results[company.id] = _from_cache(entry)
            usage.cached += 1
            continue
        todo.append(company)

    if not todo:
        return results, usage

    client = _client()
    lock = threading.Lock()
    done = 0

    in_flight = 0

    def work(company: Company) -> tuple[Company, Classification]:
        nonlocal in_flight
        # Checked before the calls, and counting what the other workers are already
        # spending. Cost only lands when a response does, so a check against spend
        # alone lets every worker through at zero and blows a small ceiling by the
        # size of one batch.
        with lock:
            if usage.cost + (in_flight + 1) * COST_PER_COMPANY > ceiling:
                raise BudgetReached()
            in_flight += 1
        try:
            return company, _classify_one(client, company, usage, lock)
        finally:
            with lock:
                in_flight -= 1

    # submit/as_completed rather than map: a company that fails must cost us that
    # company, not the rest of the run. An expired key or a dead API arriving at
    # number 800 should not throw away 799 answers, nor block the upload of rows
    # that already have them.
    failures: list[tuple[str, Exception]] = []
    try:
        with concurrent.futures.ThreadPoolExecutor(max_workers=WORKERS) as pool:
            futures = {pool.submit(work, company): company for company in todo}
            for future in concurrent.futures.as_completed(futures):
                try:
                    company, result = future.result()
                except BudgetReached:
                    usage.over_budget += 1
                    continue
                except Exception as error:  # noqa: BLE001 - reported, not swallowed
                    failures.append((futures[future].id, error))
                    usage.failed += 1
                    continue
                results[company.id] = result
                cache[company.id] = {
                    "hash": _fingerprint(company),
                    "name": company.name,
                    "sector_id": result.sector_id,
                    "subsector_id": result.subsector_id,
                    "project_type": result.project_type,
                    "note": result.note,
                    "missing": result.missing,
                    "source": company.source,
                    "model": MODEL,
                    "classified_at": datetime.datetime.now(datetime.UTC).isoformat(timespec="seconds"),
                }
                done += 1
                # Saved as we go, and saved again on the way out of a failure:
                # the work is paid for the moment the call returns, and a crash
                # at company 400 must not throw away the other 399.
                if done % 25 == 0:
                    _save_cache(cache)
    finally:
        _save_cache(cache)

    if failures:
        # Loud, and with one real message: "31 failed" without the reason is a shrug.
        print(f"  {len(failures)} could not be classified, e.g. {failures[0][0]}: {failures[0][1]}")

    if usage.over_budget:
        print(
            f"  STOPPED at the ${ceiling:.2f} cost ceiling after ${usage.cost:.4f}: "
            f"{usage.over_budget} companies left unclassified. They are not lost — "
            f"the next run picks them up, and everything already answered is cached."
        )

    return results, usage


def estimate(companies: list[Company]) -> str:
    """What classifying these would cost, counted rather than guessed.

    Input tokens come from the real prompts through count_tokens. Output is the
    average of what previous calls actually produced, or a stated assumption if
    nothing has run yet.
    """
    cache = _load(CACHE_PATH)
    overrides = _load(OVERRIDES_PATH)
    todo = [c for c in companies if c.id not in overrides and cache.get(c.id, {}).get("hash") != _fingerprint(c)]
    if not todo:
        return "Nothing to do: every company is cached or overridden. A re-run costs $0.00."

    client = _client()
    sample = todo[: min(12, len(todo))]
    sector_tokens = 0
    subsector_tokens = 0
    for company in sample:
        # The schema goes in the count too. Its enums carry every id and project
        # string in the sector, which is 900-odd tokens of billed input — leaving
        # it out under-counted the first estimate of this run by 40%.
        sector_tokens += client.messages.count_tokens(
            model=MODEL,
            system=SECTOR_SYSTEM,
            messages=[{"role": "user", "content": _sector_prompt(company)}],
            output_config={"format": _sector_schema()},
        ).input_tokens
        # Sector 1 is the biggest of the five (16 sub-sectors), so pricing the
        # second call against it overstates rather than surprises.
        subsector_tokens += client.messages.count_tokens(
            model=MODEL,
            system=SUBSECTOR_SYSTEM,
            messages=[{"role": "user", "content": _subsector_prompt(company, SECTOR_BY_ID["1"])}],
            output_config={"format": _subsector_schema(SECTOR_BY_ID["1"])},
        ).input_tokens

    per_company_in = (sector_tokens + subsector_tokens) / len(sample)
    total_in = per_company_in * len(todo)
    total_out = OUTPUT_TOKENS_ASSUMED * len(todo)
    cost = (total_in * PRICE_IN + total_out * PRICE_OUT) / 1_000_000

    return (
        f"{len(todo)} companies to classify, {len(companies) - len(todo)} already known.\n"
        f"  {per_company_in:,.0f} input tokens each (counted), ~{OUTPUT_TOKENS_ASSUMED} output tokens each (assumed)\n"
        f"  {total_in:,.0f} in + {total_out:,.0f} out on {MODEL}\n"
        f"  about ${cost:.2f}, and $0.00 on every re-run after it"
    )


def table(companies: list[Company], results: dict[str, Classification]) -> str:
    """The classifications as something a person can actually check."""
    names = {s["subsector_id"]: s["subsector"] for s in SUBSECTORS}
    sectors = {s["id"]: s["short"] for s in SECTORS}
    rows = []
    for company in companies:
        result = results.get(company.id)
        if result is None:
            continue
        description = clean(company.description) or ""
        rows.append(
            (
                company.name[:38],
                description[:60] + ("…" if len(description) > 60 else ""),
                f"{result.sector_id} {sectors.get(result.sector_id, '')}" if result.sector_id else "— dropped",
                f"{result.subsector_id} {names.get(result.subsector_id, '')}"
                if result.subsector_id
                else ("— dropped, no sub-sector fits" if result.sector_id else ""),
            )
        )

    widths = [max(len(r[i]) for r in rows) for i in range(4)] if rows else [0, 0, 0, 0]
    header = ("Company", "What they do", "Sector", "Sub-sector")
    widths = [max(w, len(h)) for w, h in zip(widths, header)]
    line = "  ".join("-" * w for w in widths)
    out = ["  ".join(h.ljust(w) for h, w in zip(header, widths)), line]
    out += ["  ".join(cell.ljust(w) for cell, w in zip(row, widths)) for row in rows]
    return "\n".join(out)


def _companies() -> list[Company]:
    """Every company the scrapers can see, deduped the way the upload will.

    The source list is run.py's, imported here rather than kept in step by hand —
    a --estimate that quietly priced two of the four sources would be worse than
    no estimate at all. Imported inside the function because run.py imports this
    module at the top of itself.
    """
    from ingest.run import SOURCES, scrape

    merged: dict[str, Company] = {}
    for module in SOURCES:
        for company in scrape(module)[0]:
            merged.setdefault(company.id, company)
    return list(merged.values())


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--limit", type=int, help="only the first N companies")
    parser.add_argument("--estimate", action="store_true", help="price the run without making it")
    parser.add_argument("--force", action="store_true", help="ignore the cache and re-classify")
    parser.add_argument("--table", action="store_true", help="print the results as a table")
    parser.add_argument("--max-cost", type=float, help=f"stop after this much, in dollars (default {DEFAULT_MAX_COST})")
    args = parser.parse_args()

    companies = _companies()
    if args.limit:
        companies = companies[: args.limit]

    if args.estimate:
        print(estimate(companies))
    else:
        results, usage = classify(companies, force=args.force, cost_limit=args.max_cost)
        on_map = sum(1 for r in results.values() if r.on_map)
        no_sector = sum(1 for r in results.values() if r.sector_id is None)
        no_subsector = len(results) - on_map - no_sector
        print(
            f"{len(results)} companies: {on_map} placed, "
            f"{no_sector} dropped — no sector, {no_subsector} dropped — sector but no sub-sector"
        )
        print(usage)
        if args.table:
            print()
            print(table(companies, results))
