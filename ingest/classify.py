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
import time

import os

import anthropic

from ingest import entity
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
# The thing that could take the balance in an afternoon is not a price rise — it is
# a scraper that starts returning 5,000 rows because someone redesigned a page. A
# ceiling turns that from an empty balance into a log line. Overridable per run,
# and by the scheduled job, which has nobody watching it.
#
# Five cents, not twenty-five, because what is left of the balance has to outlast a
# date that is already fixed. At the old ceiling a fortnight of runaway mornings
# spends more than there is, and a pipeline that stops days before it is due to be
# shown to anyone is worse than one that never ran. At COST_PER_COMPANY that is
# about sixteen new companies a night, which is far more than any day's genuine
# arrivals; and a run that reaches the ceiling has not failed. It says what it
# stopped at, banks what it bought, and the next morning starts where it stopped.
DEFAULT_MAX_COST = 0.05
MAX_COST_ENV = "UPSTREAM_MAX_COST"

# What one company has cost, measured over 1,542 of them. Used to reserve against
# the ceiling for calls already in flight: without it, eight workers all pass the
# check at zero and the first batch is unconditional, which on a small ceiling
# means spending double it.
COST_PER_COMPANY = 0.003

# The Message Batches API answers the same requests at half the price, within an hour
# as a rule and within 24 at most. Right for a backfill of hundreds, wrong for a night
# of ten — so it is chosen by hand for a run, never by default.
BATCH_ENV = "UPSTREAM_BATCH"
BATCH_DISCOUNT = 0.5
BATCH_STATE_PATH = pathlib.Path(__file__).parent / "cache" / "batch_pending.json"
BATCH_POLL_SECONDS = 30
BATCH_WAIT_ENV = "UPSTREAM_BATCH_WAIT_MINUTES"
BATCH_WAIT_MINUTES = 150


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


class ConfigurationError(Exception):
    """The key, the account or the balance is wrong, so every call will fail alike.

    Kept apart from every other failure because the response is different. A
    company whose answer will not parse is one company lost; an invalid key is
    the whole run lost, and retrying it 1,500 times produces 1,500 identical
    401s, a log nobody reads to the end, and a green tick on a job that did
    nothing. This is a configuration failure, and a configuration failure has to
    stop the run rather than be counted by it.
    """


class Aborted(Exception):
    """This company was never attempted: the run was already over."""


# A 401 means the key is wrong, a 403 means it is not allowed here, and a
# credit-balance message means there is nothing left to spend. None of the three
# gets better by being retried, and the SDK does not retry them either.
#
# The message check is deliberately narrow. Billing arrives as a plain 400, which
# is the same status as a malformed request, so matching on the status alone
# would turn every bad request into a run-ending error and hide real bugs.
_FATAL_PHRASES = (
    "credit balance",
    "billing",
    "insufficient_quota",
    "insufficient funds",
    "payment required",
    "purchase credits",
)


def fatal_reason(error: BaseException) -> str | None:
    """Why this error ends the run, or None if it is just one company's bad day."""
    if isinstance(error, anthropic.AuthenticationError):
        return "the API key was rejected (401)"
    if isinstance(error, anthropic.PermissionDeniedError):
        return "the API key is not permitted to use this model or account (403)"
    if isinstance(error, anthropic.APIStatusError):
        text = str(getattr(error, "message", "") or error).lower()
        for phrase in _FATAL_PHRASES:
            if phrase in text:
                return f"the account cannot be billed for this run ({error.status_code}: {phrase})"
    return None

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
    never_attempted: int = 0
    # Answers asked for in a Message Batch that had not come back when the run stopped
    # waiting. Not lost and not billed yet: the batch id is kept, and the next run
    # collects them instead of asking again.
    pending: int = 0
    # Batch requests bill at half the price of the same request made directly.
    price_factor: float = 1.0

    def add(self, response) -> None:
        self.calls += 1
        self.input_tokens += response.usage.input_tokens
        self.output_tokens += response.usage.output_tokens

    @property
    def cost(self) -> float:
        return self.price_factor * (self.input_tokens * PRICE_IN + self.output_tokens * PRICE_OUT) / 1_000_000

    def __str__(self) -> str:
        said = (
            f"{self.calls} calls, {self.input_tokens:,} in / {self.output_tokens:,} out, "
            f"${self.cost:.4f} — {self.cached} from cache, {self.overridden} overridden"
        )
        if self.failed:
            said += f", {self.failed} FAILED"
        if self.over_budget:
            said += f", {self.over_budget} left unclassified at the cost ceiling"
        if self.never_attempted:
            said += f", {self.never_attempted} never attempted"
        if self.pending:
            said += f", {self.pending} still in a batch for the next run to collect"
        if self.price_factor != 1.0:
            said += " (Message Batches, half price)"
        return said


# --- the two prompts --------------------------------------------------------


def _company_text(company: Company) -> str:
    description = clean(company.description) or "(no description published)"
    if company.entity_type in (None, entity.COMPANY):
        return f"Company: {company.name}\nWhat they do: {description}"
    # Said in the input, not the shared system prompt: changing that would re-key and
    # re-buy every company. Only these records' questions change, so only they re-run.
    kind = "a person's funded project" if company.entity_type == entity.RESEARCHER_PROJECT else "a project or brand"
    return (
        f"Record: {company.name} — {kind}. No incorporated company is on record, so in your reason "
        f"call it \"the project\", never \"the company\".\nWhat it does: {description}"
    )


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
    return _placement(sector, answer)


def _placement(sector: dict, answer: dict) -> Classification:
    """The second call's answer, checked against the sector it was asked about."""
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


def _cache_entry(company: Company, result: Classification) -> dict:
    return {
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


# --- cache and overrides ----------------------------------------------------


def _answered_before_entity_types(company: Company, entry: dict | None) -> bool:
    """A non-company whose earlier answer left it off the map, which stands.

    Telling the classifier a record is a person's project changes only the word it
    uses in its reason. For a record already placed that reason is printed on its
    page, so it is worth the call. For one the classifier placed nowhere, no page
    prints it: re-asking would re-buy 34 answers on 2026-09-13 to reword notes nobody
    reads, and the rule in this project is not to pay for what never reaches the page.
    """
    if entry is None or company.entity_type in (None, entity.COMPANY):
        return False
    # A person's project and a brand are asked the same question in all but one phrase,
    # and both are told to say "the project". A record moved between the two keeps its
    # answer: on 15 September 2026 brands read as people (Zerocircle Alternatives) were
    # corrected, and re-asking would have bought rewordings of reasons that already said
    # "the project".
    other = {entity.RESEARCHER_PROJECT: entity.UNVERIFIED, entity.UNVERIFIED: entity.RESEARCHER_PROJECT}.get(company.entity_type)
    if other is not None and entry.get("hash") == _fingerprint(dataclasses.replace(company, entity_type=other)):
        return True
    unchanged = entry.get("hash") == _fingerprint(company, with_entity=False)
    # Nor for a record whose only text is a register label. The answer rests on the label
    # either way, and where its reasoning still says "company" the page already says
    # nothing on record shows one. On 14 September 2026 the recognition fix turned 21
    # placed register profiles unverified; re-asking them would have bought 21 rewordings
    # ahead of the 65 Venture Center companies still waiting for a first answer.
    return unchanged and (not _from_cache(entry).on_map or company.description_is_label)


def _fingerprint(company: Company, *, with_entity: bool = True) -> str:
    """What we are about to send, as one short hash.

    The model and the prompt version are in here on purpose: re-running after
    either changes is a different question, and answering it from cache would
    quietly mix two generations of judgement.

    The version is this source's. The shape of the hashed material is deliberately
    unchanged from when the version was global — every source starts at the number
    it already had, so scoping the key cost nothing and invalidated nothing.
    """
    material = json.dumps(
        [company.name, clean(company.description), MODEL, prompt_version(company.source)]
        # Appended only for records that are not companies, so every company's key is
        # exactly what it was and nothing already bought is bought again.
        + ([company.entity_type] if with_entity and company.entity_type not in (None, entity.COMPANY) else []),
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

    try:
        return anthropic.Anthropic()
    except Exception as error:
        raise ConfigurationError(
            f"No API key: set ANTHROPIC_API_KEY in the environment, in .env, or as a "
            f"repository secret for the scheduled run ({error})."
        ) from None


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
    batch: bool | None = None,
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
    # The cache is filed by id, but what it answered is the hash. A company listed under
    # two spellings is one id from ingest/duplicates.py on, and the copy classified under
    # that id may be the one whose answer was filed under the other spelling: the same
    # question, already paid for. Found by what was asked, not by where it was filed.
    by_hash = {entry["hash"]: entry for entry in cache.values() if isinstance(entry, dict) and entry.get("hash")}

    for company in companies:
        if company.id in overrides:
            results[company.id] = _override(overrides[company.id])
            usage.overridden += 1
            continue
        entry = cache.get(company.id)
        if entry and not force and (entry.get("hash") == _fingerprint(company) or _answered_before_entity_types(company, entry)):
            results[company.id] = _from_cache(entry)
            usage.cached += 1
            continue
        filed_elsewhere = by_hash.get(_fingerprint(company))
        if filed_elsewhere and not force:
            results[company.id] = _from_cache(filed_elsewhere)
            usage.cached += 1
            continue
        todo.append(company)

    if batch is None:
        batch = os.environ.get(BATCH_ENV) == "1"
    if batch and (todo or BATCH_STATE_PATH.exists()):
        return _classify_in_batches(todo, results, usage, cache, ceiling)

    if not todo:
        return results, usage

    client = _client()
    lock = threading.Lock()
    done = 0

    in_flight = 0
    # Set by the first worker to meet a configuration error. Every other worker
    # reads it before opening a connection, so the run stops making calls at the
    # first 401 instead of collecting 1,500 of them.
    stop = threading.Event()

    def work(company: Company) -> tuple[Company, Classification]:
        nonlocal in_flight
        if stop.is_set():
            raise Aborted()
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
        except BaseException as error:
            # Raised before the next worker picks up its company, so the latch is
            # closed by the time anyone else looks at it.
            if fatal_reason(error):
                stop.set()
            raise
        finally:
            with lock:
                in_flight -= 1

    # submit/as_completed rather than map: a company that fails must cost us that
    # company, not the rest of the run. An expired key or a dead API arriving at
    # number 800 should not throw away 799 answers, nor block the upload of rows
    # that already have them.
    failures: list[tuple[str, Exception]] = []
    fatal: str | None = None
    try:
        with concurrent.futures.ThreadPoolExecutor(max_workers=WORKERS) as pool:
            futures = {pool.submit(work, company): company for company in todo}
            for future in concurrent.futures.as_completed(futures):
                try:
                    company, result = future.result()
                except BudgetReached:
                    usage.over_budget += 1
                    continue
                except Aborted:
                    # Never attempted, never charged for, and not this company's
                    # fault. Counting these as failures would report 1,500
                    # problems when there is exactly one.
                    usage.never_attempted += 1
                    continue
                except Exception as error:  # noqa: BLE001 - reported, not swallowed
                    reason = fatal_reason(error)
                    if reason:
                        # Keep the first one. The later arrivals are the same
                        # misconfiguration reported by whichever workers were
                        # already mid-flight when the latch closed.
                        if fatal is None:
                            fatal = reason
                            stop.set()
                            for pending in futures:
                                pending.cancel()
                        continue
                    failures.append((futures[future].id, error))
                    usage.failed += 1
                    continue
                results[company.id] = result
                cache[company.id] = _cache_entry(company, result)
                done += 1
                # Saved as we go, and saved again on the way out of a failure:
                # the work is paid for the moment the call returns, and a crash
                # at company 400 must not throw away the other 399.
                if done % 25 == 0:
                    _save_cache(cache)
    finally:
        _save_cache(cache)

    # After the save, never before it: the answers bought before the key went bad
    # are paid for, and the next run must not pay for them twice.
    if fatal:
        raise ConfigurationError(
            f"Classification stopped: {fatal}. "
            f"{usage.never_attempted + usage.failed} of {len(todo)} companies were left unclassified "
            f"and no further calls were made. Nothing here is retryable — fix the credential or the "
            f"balance and run again; the {done} answers this run did buy are cached."
        )

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


# --- Message Batches ----------------------------------------------------------


def _request(custom_id: str, system: str, prompt: str, schema: dict) -> dict:
    return {
        "custom_id": custom_id,
        "params": {
            "model": MODEL,
            "max_tokens": MAX_TOKENS,
            "system": system,
            "messages": [{"role": "user", "content": prompt}],
            "output_config": {"format": schema},
        },
    }


def _wait(client, batch_id: str, minutes: float, sleep=time.sleep, clock=time.monotonic) -> bool:
    """Poll until the batch has ended or the wait runs out. True when it ended."""
    deadline = clock() + minutes * 60
    while True:
        status = client.messages.batches.retrieve(batch_id).processing_status
        if status == "ended":
            return True
        if clock() >= deadline:
            return False
        sleep(BATCH_POLL_SECONDS)


def _answers(client, batch_id: str, usage: Usage) -> tuple[dict[str, dict], dict[str, str]]:
    """custom_id -> parsed JSON answer, and custom_id -> why there is none. Results come
    back in any order, so nothing here is positional."""
    answers: dict[str, dict] = {}
    problems: dict[str, str] = {}
    for item in client.messages.batches.results(batch_id):
        result = item.result
        if result.type != "succeeded":
            problems[item.custom_id] = result.type
            continue
        usage.add(result.message)
        text = next((block.text for block in result.message.content if block.type == "text"), None)
        try:
            answers[item.custom_id] = json.loads(text) if text else None
        except ValueError:
            answers[item.custom_id] = None
        if answers[item.custom_id] is None:
            del answers[item.custom_id]
            problems[item.custom_id] = "unreadable answer"
    return answers, problems


def _save_state(state: dict | None) -> None:
    if state is None:
        BATCH_STATE_PATH.unlink(missing_ok=True)
        return
    BATCH_STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
    BATCH_STATE_PATH.write_text(json.dumps(state, indent=1, sort_keys=True) + "\n", encoding="utf-8")


def _classify_in_batches(
    todo: list[Company],
    results: dict[str, Classification],
    usage: Usage,
    cache: dict,
    ceiling: float,
    *,
    client=None,
    sleep=time.sleep,
    clock=time.monotonic,
) -> tuple[dict[str, Classification], Usage]:
    """The two calls per company, as two Message Batches at half price.

    The first batch asks every company's sector; the second asks the sub-sector of
    those that have one. A batch that has not ended when the wait runs out is written to
    ingest/cache/batch_pending.json — committed with the cache — and the next run
    collects it rather than asking, and paying, again. The ceiling is reserved up
    front at half of COST_PER_COMPANY, so a batch cannot be sent that the run could
    not afford.
    """
    usage.price_factor = BATCH_DISCOUNT
    client = client or _client()
    minutes = float(os.environ.get(BATCH_WAIT_ENV) or BATCH_WAIT_MINUTES)
    by_id = {company.id: company for company in todo}
    state = _load(BATCH_STATE_PATH) or None

    try:
        if state is None:
            affordable = int(ceiling // (COST_PER_COMPANY * BATCH_DISCOUNT))
            asked, usage.over_budget = todo[:affordable], max(0, len(todo) - affordable)
            if not asked:
                return results, usage
            ids = [company.id for company in asked]
            batch = client.messages.batches.create(
                requests=[_request(f"c{i}", SECTOR_SYSTEM, _sector_prompt(c), _sector_schema()) for i, c in enumerate(asked)]
            )
            state = {"stage": "sector", "batch_id": batch.id, "ids": ids, "created": datetime.datetime.now(datetime.UTC).isoformat(timespec="seconds")}
            _save_state(state)
            print(f"  batch {batch.id}: asked the sector of {len(ids)} companies")
        else:
            print(f"  collecting batch {state['batch_id']} ({state['stage']}) left by an earlier run")

        if state["stage"] == "sector":
            if not _wait(client, state["batch_id"], minutes, sleep, clock):
                usage.pending = len(state["ids"])
                return results, usage
            answers, problems = _answers(client, state["batch_id"], usage)
            sectors: dict[str, str] = {}
            for i, cid in enumerate(state["ids"]):
                answer = answers.get(f"c{i}")
                if answer is None:
                    usage.failed += cid in by_id
                    continue
                sectors[cid] = answer["sector_id"]
            second = [(i, cid) for i, cid in enumerate(state["ids"]) if sectors.get(cid) not in (None, "none") and cid in by_id]
            for cid, chosen in sectors.items():
                if chosen == "none" and cid in by_id:
                    results[cid] = Classification(sector_id=None)
                    cache[cid] = _cache_entry(by_id[cid], results[cid])
            _save_cache(cache)
            if not second:
                _save_state(None)
                return results, usage
            batch = client.messages.batches.create(
                requests=[
                    _request(f"c{i}", SUBSECTOR_SYSTEM, _subsector_prompt(by_id[cid], SECTOR_BY_ID[sectors[cid]]), _subsector_schema(SECTOR_BY_ID[sectors[cid]]))
                    for i, cid in second
                ]
            )
            state = {"stage": "subsector", "batch_id": batch.id, "ids": state["ids"], "sectors": sectors, "created": state.get("created")}
            _save_state(state)
            print(f"  batch {batch.id}: asked the sub-sector of {len(second)} companies")

        if not _wait(client, state["batch_id"], minutes, sleep, clock):
            usage.pending = len(state["sectors"])
            return results, usage
        answers, problems = _answers(client, state["batch_id"], usage)
        for i, cid in enumerate(state["ids"]):
            chosen = state["sectors"].get(cid)
            if chosen in (None, "none"):
                continue
            answer = answers.get(f"c{i}")
            company = by_id.get(cid)
            if answer is None or company is None:
                # Nothing to file: the company is no longer asked for (its record
                # changed since), or its answer did not come back.
                usage.failed += company is not None
                continue
            results[cid] = _placement(SECTOR_BY_ID[chosen], answer)
            cache[cid] = _cache_entry(company, results[cid])
        _save_cache(cache)
        _save_state(None)
        if problems:
            print(f"  {len(problems)} batch answers did not come back, e.g. {next(iter(problems.items()))}")
        return results, usage
    except anthropic.APIStatusError as error:
        reason = fatal_reason(error)
        if reason:
            raise ConfigurationError(f"Batch classification stopped: {reason}.") from error
        raise


def check_key() -> str:
    """Is the credential usable at all? One free call, before anything is scraped.

    count_tokens is not billed, so this costs nothing and answers in a second —
    which is the whole point of running it before three minutes of scraping. It
    proves the key is accepted; it cannot prove the account has credit, because a
    free endpoint is never refused for want of it. A balance that runs out mid-run
    is caught by fatal_reason on the first real call instead.
    """
    client = _client()
    try:
        client.messages.count_tokens(
            model=MODEL,
            system=SECTOR_SYSTEM,
            messages=[{"role": "user", "content": "ping"}],
        )
    except Exception as error:
        reason = fatal_reason(error)
        if reason:
            raise ConfigurationError(f"ANTHROPIC_API_KEY is not usable: {reason}.") from None
        raise
    return f"ANTHROPIC_API_KEY accepted by the API; {MODEL} addressable."


def estimate(companies: list[Company]) -> str:
    """What classifying these would cost, counted rather than guessed.

    Input tokens come from the real prompts through count_tokens. Output is the
    average of what previous calls actually produced, or a stated assumption if
    nothing has run yet.
    """
    cache = _load(CACHE_PATH)
    overrides = _load(OVERRIDES_PATH)
    todo = [
        c
        for c in companies
        if c.id not in overrides
        and cache.get(c.id, {}).get("hash") != _fingerprint(c)
        and not _answered_before_entity_types(c, cache.get(c.id))
    ]
    if not todo:
        return "Nothing to do: every company is cached or overridden. A re-run costs $0.00."

    client = _client()
    sample = todo[: min(12, len(todo))]
    sector_tokens = 0
    subsector_tokens = 0
    try:
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
    except Exception as error:
        reason = fatal_reason(error)
        if reason:
            raise ConfigurationError(f"Cannot price the run: {reason}.") from None
        raise

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
    listed_by: dict[str, set[str]] = {}
    for module in SOURCES:
        for company in scrape(module)[0]:
            merged.setdefault(company.id, company)
            listed_by.setdefault(company.id, set()).add(module.SOURCE)
    # As run.py does, because the entity type is part of a project's cache key: an
    # estimate without it would miss every record whose question just changed.
    for company in merged.values():
        company.entity_type, company.entity_note = entity.assess(company.name, listed_by[company.id], founders=company.founders)
    return list(merged.values())


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--limit", type=int, help="only the first N companies")
    parser.add_argument("--estimate", action="store_true", help="price the run without making it")
    parser.add_argument("--force", action="store_true", help="ignore the cache and re-classify")
    parser.add_argument("--table", action="store_true", help="print the results as a table")
    parser.add_argument("--max-cost", type=float, help=f"stop after this much, in dollars (default {DEFAULT_MAX_COST})")
    parser.add_argument("--check-key", action="store_true", help="verify the credential and exit, scraping nothing")
    args = parser.parse_args()

    # Before _companies(), which scrapes four sites: the point is to fail in a
    # second rather than after the slow part.
    if args.check_key:
        try:
            print(check_key())
        except ConfigurationError as error:
            raise SystemExit(f"::error::{error}") from None
        raise SystemExit(0)

    companies = _companies()
    if args.limit:
        companies = companies[: args.limit]

    if args.estimate:
        print(estimate(companies))
    else:
        try:
            results, usage = classify(companies, force=args.force, cost_limit=args.max_cost)
        except ConfigurationError as error:
            raise SystemExit(f"::error::{error}") from None
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
