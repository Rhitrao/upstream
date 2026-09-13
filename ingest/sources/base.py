"""Shared plumbing for every scraper.

`fetch` and `fetch_json` are polite by construction: one honest user-agent with a
contact address, a second between calls, three tries with backoff, and a 30-day
disk cache in ingest/cache/. The cache is the part that matters — re-running while you debug a
parser must not hammer someone else's server.

A scraper returns `(list[Company], list[Signal])` and nothing else. No scoring, no
classification, no uploading; those are separate files on purpose.
"""

from __future__ import annotations

import dataclasses
import datetime
import hashlib
import json
import pathlib
import re
import time
import unicodedata
import urllib.parse
from dataclasses import dataclass

import requests

CONTACT = "rhitrao@gmail.com"
USER_AGENT = f"upstream-research/0.1 (+https://rohitrao.in/upstream; {CONTACT})"

CACHE_DIR = pathlib.Path(__file__).resolve().parent.parent / "cache"
CACHE_TTL_SECONDS = 30 * 24 * 60 * 60
DELAY_SECONDS = 1.0
RETRIES = 3
TIMEOUT_SECONDS = 30

# Transient on their end, worth another try. Everything else 4xx is our mistake and
# retrying it is just rudeness with extra steps.
RETRY_STATUSES = frozenset({429, 500, 502, 503, 504})


@dataclass(slots=True)
class Company:
    """One row of `companies`.

    The classification fields stay None in a scraper. Filling them is classify.py's
    job, and a scraper that guessed would put a guess into the audit trail that
    classify_note is supposed to be.

    There is no first_seen field, and that is deliberate. When a company became
    visible, and when it became visible to us, are the Worker's to decide: it knows
    whether this is a source's first sweep (a backfill, where the honest date is the
    cohort year below) or a later run (where a company that was not there last time
    really was found today). A scraper that sent its own date would hand every
    backfilled company a discovery it never had.

    Two date facts, and they are not the same one. `origin_year` is the year the
    source says the company began — incubated or founded — and it is what the age
    gate reads. `record_year` is the year it entered a public record. For an
    incubator cohort or a grant award those coincide and a scraper sets only
    origin_year; a recognition register publishes the second and not the first,
    and saying so is the whole point of having two fields.

    Year precision only, because that is all any of these pages publish.
    """

    id: str
    name: str
    description: str | None = None
    # Which source described it, and whether that description is a description at
    # all. A recognition register publishes an industry label chosen by the founder
    # from a fixed list; calling that a description would let the page imply we know
    # what the company does. Both fields stay inside the pipeline — see payload().
    source: str | None = None
    description_is_label: bool = False
    website: str | None = None
    # False when the source publishes no website field at all. An empty website is
    # then a fact about the source, not about the company, and the page must not
    # mark it as one.
    website_checked: bool = True
    # What the company says it builds, read off its own homepage, and the outcome of
    # having looked. Both stay None in a scraper — filling them is enrich.py's job,
    # for the same reason the classification fields are classify.py's.
    product: str | None = None
    product_status: str | None = None
    city: str | None = None
    state: str | None = None
    cin: str | None = None
    founded_year: int | None = None
    origin_year: int | None = None
    record_year: int | None = None
    sector_id: str | None = None
    subsector_id: str | None = None
    project_type: str | None = None
    classify_note: str | None = None
    # 'description' or 'register-label': what the sub-sector was chosen from. Set
    # by the pipeline from description_is_label, and sent, unlike that flag.
    classify_basis: str | None = None

    @classmethod
    def named(cls, name: str, **fields) -> Company:
        """Build one from a raw source name — the slug is the id and the dedupe key."""
        return cls(id=slugify(name), name=clean(name) or name.strip(), **fields)

    def payload(self) -> dict:
        return payload(self)


@dataclass(slots=True)
class Signal:
    """One row of `signals` — a public trace that somebody already knows about them."""

    company_id: str
    type: str
    label: str
    date: str | None = None
    url: str | None = None
    source: str | None = None
    found_at: str | None = None

    def payload(self) -> dict:
        return payload(self)


# Fields the pipeline uses and the endpoint has never heard of. Listed rather than
# inferred, so adding one is a decision instead of a surprise on the far side.
INTERNAL_FIELDS = frozenset({"source", "description_is_label"})


def payload(record: Company | Signal) -> dict:
    """The record as the Worker's ingest endpoint wants it.

    None fields are dropped rather than sent as null: the upsert reads a missing
    column as "leave what is already there", so an empty scrape can never blank out a
    field another source filled in.
    """
    return {k: v for k, v in dataclasses.asdict(record).items() if v is not None and k not in INTERNAL_FIELDS}


# Stripped only from the end of a name: a leading "Limited" is part of the name, a
# trailing one is boilerplate. "p" is here for the Indian "(P) Ltd", which reaches this
# set as a bare token once the punctuation is gone.
NAME_SUFFIXES = frozenset({"private", "limited", "ltd", "pvt", "llp", "p"})


def slugify(name: str) -> str:
    """Lowercase, no company-form boilerplate, no punctuation, hyphenated.

    This is the company `id` and the only thing that stops the same company arriving
    twice under two spellings, so it has to be stable: same name in, same slug out.
    """
    ascii_name = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode("ascii")
    words = re.sub(r"[^a-z0-9]+", " ", ascii_name.lower()).split()
    trimmed = list(words)
    while trimmed and trimmed[-1] in NAME_SUFFIXES:
        trimmed.pop()
    # A name made entirely of suffixes keeps them — a blank id would collide with
    # every other blank id, which is worse than an ugly one.
    return "-".join(trimmed or words)


def clean(text: str | None) -> str | None:
    """Collapse whitespace (including the non-breaking kind CMSes love). None if empty."""
    if text is None:
        return None
    collapsed = re.sub(r"\s+", " ", text.replace("\xa0", " ")).strip()
    return collapsed or None


def website(url: str | None) -> str | None:
    """A source's website field as an http(s) url, or None.

    Sources write "acuradyne.com" as often as they write the scheme. The page only
    linkifies http(s), so a bare domain would render as dead text otherwise.
    """
    cleaned = clean(url)
    if cleaned is None:
        return None
    if cleaned.lower().startswith(("http://", "https://")):
        return cleaned
    if re.fullmatch(r"[\w.-]+\.[a-z]{2,}(?:/.*)?", cleaned, re.IGNORECASE):
        return f"https://{cleaned}"
    return None


def fetch(url: str, *, force: bool = False) -> str:
    """The page body, from the cache when it is younger than 30 days."""
    return _cached(url, None, force=force)


def fetch_optional(url: str, *, force: bool = False, patience: bool = False) -> tuple[str | None, str]:
    """The page body and why, for a fetch that is allowed to fail.

    `fetch` raises, which is right for a source: a portfolio that stops answering is
    a broken scraper and the run should say so. A company's own homepage is the
    opposite case — a dead domain is not a fault in this pipeline, it is a fact about
    the company, and it is one of the more interesting ones a DPIIT-recognised
    startup can present. So the failure comes back as a value to be recorded rather
    than an exception to be handled.

    The three outcomes are kept apart because they mean different things to a reader:
    nothing answered at that address, something answered and refused us, or it
    answered and there was nothing there.

    `patience` is off by default, and that is the other difference from `fetch`. A
    source gets three tries over ninety seconds because a flaky portfolio is this
    pipeline's problem to absorb and there are four of them. A company's own homepage
    gets one try and ten seconds, because there are two hundred of them and a front
    page that cannot answer inside ten seconds has, for every purpose this page has,
    not answered. Waiting ninety seconds to write down "unreachable" reaches the same
    conclusion an hour later.
    """
    retries, timeout = (RETRIES, TIMEOUT_SECONDS) if patience else (1, 10)
    try:
        return _cached(url, None, force=force, retries=retries, timeout=timeout), "ok"
    except requests.HTTPError as error:
        status = getattr(error.response, "status_code", None)
        # 401/403/405/406/429 are a site declining an automated reader, which is its
        # right and not a malfunction. Anything else that got a real HTTP response is
        # a server that is broken rather than defended.
        return None, "refused" if status in {401, 403, 405, 406, 429} else "unreachable"
    except requests.RequestException:
        # DNS, TLS, connection refused, timeout: nothing is listening.
        return None, "unreachable"


def fetch_json(url: str, body: dict, *, force: bool = False) -> dict:
    """The same, for a search API that wants a POST.

    The request body is part of the cache key, because two different queries to
    one url are two different pages as far as anything here is concerned.
    """
    return json.loads(_cached(url, body, force=force))


def _cached(url: str, body: dict | None, *, force: bool, retries: int = RETRIES, timeout: int = TIMEOUT_SECONDS) -> str:
    path = _cache_path(url, body)
    if not force:
        cached = _read_cache(path)
        if cached is not None:
            return cached

    text = _request(url, body, retries=retries, timeout=timeout)
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    entry = {"url": url, "body": body, "fetched_at": _now().isoformat(), "response": text}
    path.write_text(json.dumps(entry), encoding="utf-8")
    return text


def preview(companies: list[Company], signals: list[Signal], limit: int = 5) -> str:
    """What a scraper prints when you run it directly — enough to see it worked."""
    by_company: dict[str, list[Signal]] = {}
    for signal in signals:
        by_company.setdefault(signal.company_id, []).append(signal)

    lines = [f"{len(companies)} companies, {len(signals)} signals"]
    missing = sum(1 for c in companies if not c.website)
    lines.append(f"{missing} without a website, {sum(1 for c in companies if not c.description)} without a description")
    undated = sum(1 for c in companies if c.origin_year is None and c.record_year is None)
    lines.append(f"{undated} with no year at all, which the page lists as undated rather than ranking")
    no_age = sum(1 for c in companies if c.origin_year is None and c.record_year is not None)
    if no_age:
        lines.append(f"{no_age} on record but with no founding year, so the age gate cannot judge them")
    for company in companies[:limit]:
        lines.append(f"\n  {company.id}\n    {company.name}")
        if company.website:
            lines.append(f"    {company.website}")
        if company.description:
            lines.append(f"    {company.description[:100]}")
        for signal in by_company.get(company.id, []):
            lines.append(f"    [{signal.type}] {signal.label}")
    return "\n".join(lines)


def _now() -> datetime.datetime:
    return datetime.datetime.now(datetime.UTC)


_last_call = 0.0


def _request(url: str, body: dict | None = None, *, retries: int = RETRIES, timeout: int = TIMEOUT_SECONDS) -> str:
    """One polite call: wait our turn, try again, back off between.

    The pacing is global rather than per-host, which is the right conservatism when
    four scrapers are walking four sites. Reading two hundred company homepages is
    the opposite shape — each host is visited exactly once in the whole run — so
    enrich.py fetches those concurrently and this queue is not what holds it back.
    """
    global _last_call

    headers = {"User-Agent": USER_AGENT}
    if body is not None:
        headers["content-type"] = "application/json"

    for attempt in range(1, retries + 1):
        pause = DELAY_SECONDS - (time.monotonic() - _last_call)
        if pause > 0:
            time.sleep(pause)
        try:
            if body is None:
                response = requests.get(url, headers=headers, timeout=timeout)
            else:
                response = requests.post(url, headers=headers, data=json.dumps(body), timeout=timeout)
            _last_call = time.monotonic()
            if response.status_code in RETRY_STATUSES:
                raise requests.HTTPError(f"{response.status_code} from {url}", response=response)
            response.raise_for_status()
            # requests falls back to ISO-8859-1 when a server sends no charset, which
            # turns every curly quote on a UTF-8 page into mojibake.
            if "charset" not in response.headers.get("content-type", "").lower():
                response.encoding = response.apparent_encoding or "utf-8"
            return response.text
        except requests.RequestException:
            _last_call = time.monotonic()
            if attempt == retries:
                raise
            time.sleep(DELAY_SECONDS * 2 ** (attempt - 1))

    raise AssertionError("unreachable")


def _cache_path(url: str, body: dict | None = None) -> pathlib.Path:
    parts = urllib.parse.urlsplit(url)
    stem = re.sub(r"[^a-z0-9]+", "-", f"{parts.netloc}{parts.path}".lower()).strip("-")[:60]
    # The hash keeps two urls that flatten to the same stem apart, and keeps two
    # queries to one url apart; the stem is there so the cache directory is
    # readable when a parser surprises you.
    key = url if body is None else url + json.dumps(body, sort_keys=True)
    return CACHE_DIR / f"{stem}-{hashlib.sha256(key.encode()).hexdigest()[:8]}.json"


def _read_cache(path: pathlib.Path) -> str | None:
    try:
        entry = json.loads(path.read_text(encoding="utf-8"))
        fetched_at = datetime.datetime.fromisoformat(entry["fetched_at"])
    except (OSError, ValueError, KeyError):
        return None
    if (_now() - fetched_at).total_seconds() > CACHE_TTL_SECONDS:
        return None
    return entry["response"]
