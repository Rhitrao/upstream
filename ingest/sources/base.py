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
    # How far the website got through ingest/identity.py: discovered, associated or
    # verified, and why. None until enrichment has looked; a scraper never sets them.
    website_identity: str | None = None
    website_identity_note: str | None = None
    # company, researcher-project, lab or unverified — ingest/entity.py. Set by the
    # pipeline across every source that listed the record, never by one scraper.
    entity_type: str | None = None
    entity_note: str | None = None
    # What the company says it builds, read off its own homepage, and the outcome of
    # having looked. Both stay None in a scraper — filling them is enrich.py's job,
    # for the same reason the classification fields are classify.py's.
    product: str | None = None
    product_status: str | None = None
    # The people a source names as founders, in the source's own words and nothing
    # more: no titles looked up, no profiles followed (decision 006).
    founders: str | None = None
    founders_source: str | None = None
    # Which source the description on the row came from, once the copies are merged.
    description_source: str | None = None
    # What the DPIIT register's own record says, not what being on it implies. A
    # profile on Startup India is not a recognition: 345 of 966 register records we
    # hold carry no DIPP number and no status. See dpiit.recognition.
    dpiit_status: str | None = None
    dpiit_stage: str | None = None
    # Read off a verified homepage and a public registry, never inferred.
    contact_email: str | None = None
    contact_page: str | None = None
    domain_registered: str | None = None
    # The Internet Archive's first copy of the homepage: when the public web noticed
    # the page, not when the company began. See ingest/wayback.py.
    web_first_capture: str | None = None
    # Keyword tags from a real description (ingest/tags.py): what it builds, where it is used.
    build_tags: list[str] | None = None
    domain_tags: list[str] | None = None
    papers: dict | None = None
    city: str | None = None
    state: str | None = None
    cin: str | None = None
    founded_year: int | None = None
    origin_year: int | None = None
    record_year: int | None = None
    # A year a source prints beside a company without saying what it is ("Call X
    # Ringers Pvt Ltd (2026)"). Kept, so nothing is thrown away, and never read as a
    # founding or record year: its type says how much is known about it.
    source_year: int | None = None
    source_year_type: str | None = None
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
    # When the source says the thing happened: a full ISO date, or only the year ("2021")
    # when that is all it says. Never a year padded out to 1 January.
    date: str | None = None
    url: str | None = None
    source: str | None = None
    # When the page carrying it was published or last updated, where it says so. Not an
    # event date, and never copied into `date` for want of one.
    published: str | None = None
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


def fetch_form(url: str, form: dict, *, force: bool = False) -> str:
    """A form-encoded POST, for the WordPress-style search endpoints a portfolio page
    calls for itself (admin-ajax.php). Cached like the rest, the form in the key."""
    return _cached(url, {"__form__": form}, force=force)


def fetch_json(url: str, body: dict, *, force: bool = False) -> dict:
    """The same, for a search API that wants a POST.

    The request body is part of the cache key, because two different queries to
    one url are two different pages as far as anything here is concerned.
    """
    return json.loads(_cached(url, body, force=force))


# When every page handed out was really fetched, cached or not, in the order asked for.
# The pipeline slices this around each scraper to say how old that source's data is: a
# source served entirely from a 29-day-old cache is 29 days old, however new the run.
FETCHED_AT: list[str] = []


def _cached(url: str, body: dict | None, *, force: bool, retries: int = RETRIES, timeout: int = TIMEOUT_SECONDS) -> str:
    """The page, from the cache while it is fresh; otherwise asked for again.

    Asked conditionally when the last answer carried an ETag or Last-Modified: a 304
    means the page has not changed, so the cached copy is kept and only the time it was
    checked moves. Nothing downstream can tell a 304 from a fresh fetch of the same
    bytes, which is the point — an unchanged page must not look like new events.
    """
    path = _cache_path(url, body)
    previous = _read_entry(path)
    if not force and previous is not None and _fresh(previous):
        FETCHED_AT.append(previous["fetched_at"])
        return previous["response"]

    validators = {}
    if previous is not None and previous.get("response") is not None:
        if previous.get("etag"):
            validators["If-None-Match"] = previous["etag"]
        if previous.get("last_modified"):
            validators["If-Modified-Since"] = previous["last_modified"]

    response = _send(url, body, retries=retries, timeout=timeout, extra_headers=validators)
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    if response.status_code == 304 and previous is not None:
        entry = {**previous, "fetched_at": _now().isoformat()}
    else:
        entry = {
            "url": url,
            "body": body,
            "fetched_at": _now().isoformat(),
            "response": response.text,
            "etag": response.headers.get("ETag"),
            "last_modified": response.headers.get("Last-Modified"),
        }
    FETCHED_AT.append(entry["fetched_at"])
    path.write_text(json.dumps(entry), encoding="utf-8")
    return entry["response"]


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
    return _send(url, body, retries=retries, timeout=timeout).text


def _send(url: str, body: dict | None = None, *, retries: int = RETRIES, timeout: int = TIMEOUT_SECONDS, extra_headers: dict | None = None):
    global _last_call

    headers = {"User-Agent": USER_AGENT, **(extra_headers or {})}
    form = body.get("__form__") if isinstance(body, dict) and "__form__" in body else None
    if body is not None and form is None:
        headers["content-type"] = "application/json"

    for attempt in range(1, retries + 1):
        pause = DELAY_SECONDS - (time.monotonic() - _last_call)
        if pause > 0:
            time.sleep(pause)
        try:
            if body is None:
                response = requests.get(url, headers=headers, timeout=timeout)
            elif form is not None:
                response = requests.post(url, headers=headers, data=form, timeout=timeout)
            else:
                response = requests.post(url, headers=headers, data=json.dumps(body), timeout=timeout)
            _last_call = time.monotonic()
            if response.status_code == 304 and extra_headers:
                return response
            if response.status_code in RETRY_STATUSES:
                raise requests.HTTPError(f"{response.status_code} from {url}", response=response)
            response.raise_for_status()
            # requests falls back to ISO-8859-1 when a server sends no charset, which
            # turns every curly quote on a UTF-8 page into mojibake.
            if "charset" not in response.headers.get("content-type", "").lower():
                response.encoding = response.apparent_encoding or "utf-8"
            return response
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


def _read_entry(path: pathlib.Path) -> dict | None:
    try:
        entry = json.loads(path.read_text(encoding="utf-8"))
        datetime.datetime.fromisoformat(entry["fetched_at"])
        entry["response"]
    except (OSError, ValueError, KeyError, TypeError):
        return None
    return entry


def _fresh(entry: dict) -> bool:
    return (_now() - datetime.datetime.fromisoformat(entry["fetched_at"])).total_seconds() <= CACHE_TTL_SECONDS


def _read_cache(path: pathlib.Path) -> str | None:
    entry = _read_entry(path)
    return entry["response"] if entry is not None and _fresh(entry) else None


TITLE = r"(?:Dr|Prof|Mr|Ms|Mrs)\.?"
# A space before a title that starts a second name: not after another title ("Prof. Dr.")
# and not after a word that already joins two names ("and Prof.").
HONORIFIC = re.compile(rf"(?<=[A-Za-z.)])(?<!\band)(?<!\bAND)\s+(?=(?i:{TITLE})\s)")
JUST_A_TITLE = re.compile(rf"(?i:{TITLE})$")
TRAILING_HANDLE = re.compile(r"\s*/[\w-]+/?\s*$")


def founder_line(text: str | None) -> str | None:
    """A source's founder line with its names told apart, and nothing else changed.

    Sources separate names with commas, slashes or nothing at all: "Rohan M Despande/Ayush
    S Gaikwadi", "Prof. Udayan Ganguly Prof. Swaroop Ganguly". A slash, or a title that
    starts a second name, becomes a comma; a trailing "/fabheads-automation/" handle goes.
    Names are never reordered, recased or looked up.
    """
    line = clean(text)
    if not line:
        return None
    line = TRAILING_HANDLE.sub("", line)
    line = re.sub(r"\s*/\s*", ", ", line)
    parts = HONORIFIC.split(line)
    line = parts[0]
    for part in parts[1:]:
        line += (" " if JUST_A_TITLE.search(line.split()[-1]) else ", ") + part
    return line.strip(" .,;") or None
