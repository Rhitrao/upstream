"""Papers a company's own people have published under its name, from OpenAlex.

A research paper with "QuNu Labs Pvt. Ltd., Bengaluru" in an author's affiliation is
one of the few public traces a deep-tech company leaves that nobody paid to put
there: it says the company has people doing work a journal would print. OpenAlex
indexes the raw affiliation string of every author, it is free, and it needs no key.

The whole difficulty is the join, because a name is not an identifier. On the first
backfill (14 Sep 2026) 95 of the 527 searchable companies had papers under their name
and every one was read by hand; but the same run nominated "Monte Rosa Technology" of
California for Rosa Technology, a Korean "Oneomics Co., Ltd." for Oneomics, an
"Industron Technical Services Inc" in Minneapolis, and a court judgment naming a
company as a party. One wrong paper on a row is a reviewer's reason to stop trusting
every other row, and a missing paper costs nothing but a trace we did not show. So
every rule here gives up real papers to avoid a stranger's.

The rule, in the order it is applied:

    1. The needle is the name with its legal form removed (Private Limited, Pvt Ltd,
       LLP, OPC, Inc, "(India)"...). A bracketed registered name wins over the brand
       outside it: "DocsApp (Phasorz Technologies Private Limited)" is searched as
       Phasorz Technologies, because an author's affiliation is written as the entity
       that employs them.
    2. The needle must be distinctive, or nothing is searched and search() says None:
       one word needs seven letters and must not be a dictionary or business word;
       two or more words need at least one word of four letters or more that is not
       one. A person's name is never a needle: raw affiliation strings sometimes carry
       the author's own name, and a researcher-project listed as "Imran Hussain" would
       collect every Imran Hussain in India.
    3. OpenAlex's own affiliation search is stemmed and loose, so it only nominates.
       A work counts when one author's affiliation, read as whole words and ignoring
       case and punctuation, contains the needle, and the same affiliation (the part
       between semicolons, where OpenAlex has glued several together) also says India,
       an Indian state or city, an IIT/IISc/IIIT, or an Indian company form (Pvt,
       Private Limited, LLP, OPC). A one-word needle must also be the organisation of
       its comma-separated piece, followed by nothing or by a company form: "Cancrie,
       Jaipur" and "Renkube Private Limited", not "Chimertech Innovations LLP", because
       a single word cannot tell a company from a differently named one that shares it.
       An affiliation that is a court citation does not count.
    4. Not every work is a paper: retractions, errata, contributor lists and editorials
       are dropped, and one title counts once (a preprint and its journal version).
    5. A needle that nominates more than MAX_RAW works is not a startup's name, it is
       somebody else's, and nothing is claimed for it.

Budget. OpenAlex has metered its API since 2025: an anonymous caller gets $0.10 a day
and an affiliation search costs $0.001, so a hundred searches a day. One search per
company would take a week to cover the list once. lookup() therefore asks for up to
BATCH needles in one request, OR'd together, and assigns the works to companies on
our side with the same verification. The whole list is fourteen requests, so the
monthly refresh fits in one night. When the day's allowance is spent the run stops and
the next night carries on. An OPENALEX_API_KEY in the environment, if the owner ever
makes one, is sent as api_key and raises the allowance; no email address is sent.

    python3 -m ingest.papers "QuNu Labs Private Limited"
"""

from __future__ import annotations

import dataclasses
import datetime
import html
import json
import os
import pathlib
import re
import sys
import time
import urllib.parse
from dataclasses import dataclass

import requests

API = "https://api.openalex.org/works"

# No contact address, deliberately: base.py's user-agent carries one and this module
# does not use base.py's fetch for that reason.
USER_AGENT = "upstream-research/0.1 (+https://rohitrao.in/upstream)"

CACHE_PATH = pathlib.Path(__file__).parent / "cache" / "papers.json"
REFRESH_DAYS = 30

# Part of every cache entry. Raising it re-checks every company on the next runs,
# which is what should happen after the verification rule changes: a count decided
# under the old rule is an answer to a different question.
RULE_VERSION = 1

MIN_INTERVAL_SECONDS = 1.2
RETRIES = 4
TIMEOUT_SECONDS = 60
# A Retry-After longer than this is OpenAlex saying "tomorrow", not "in a moment".
MAX_RETRY_AFTER_SECONDS = 60

# Needles per request. OpenAlex accepts up to 100 OR'd values in a filter; forty keeps
# the URL short and a batch's combined results inside one page of PER_PAGE nearly
# always, so a batch is one request rather than several.
BATCH = 40
PER_PAGE = 200
# Measured: QuNu Labs, the most published company on the list, has 23. A phrase in
# four hundred affiliations belongs to an institution, not to an obscure startup.
MAX_RAW = 400

WORKS_KEPT = 3

SELECT = "id,doi,title,type,is_retracted,publication_year,publication_date,authorships"

# --- the needle ----------------------------------------------------------------

# Stripped from the end, repeatedly, so "Bionano Integra Healthcare OPC Private
# Limited" loses all three. "India" is here because "Bharati Robotic Systems (India)
# Pvt Ltd" is written "Bharati Robotic Systems Pvt Ltd, Pune, India" in a paper, and
# the needle has to be a contiguous phrase.
LEGAL_TAIL = frozenset("private pvt limited ltd llp opc inc incorporated corp corporation co p gmbh plc india".split())

# Words that say what kind of business a company is, or that half the world's brand
# names are built from. A needle made only of these names a category, not a company.
# Deliberately long: a word wrongly listed here costs one company its papers, a word
# wrongly missing can hand a company a stranger's.
GENERIC = frozenset(
    """
    a an and the of for in on at by to with de
    private pvt limited ltd llp inc corp corporation company co opc india indian bharat bharati
    technologies technology tech technic technical techno solutions solution systems system
    services service labs lab laboratory laboratories innovations innovation innovative innovators
    industries industry industrial enterprises enterprise ventures venture global international
    research products product engineering engineers engineer sciences science scientific health
    healthcare care energy energies motors automation automations devices device digital software
    group robotics robotic robots robot robo automata automotive aerospace aero aviation space
    spacetech dynamics dynamic diagnostics diagnostic therapeutics therapy biosciences bioscience
    lifesciences lifescience life sciences biotech bio biologics biological biologicals pharma
    pharmaceuticals medical medtech healthtech nanotech nano nanotechnology biolabs agritech agro
    agri agriculture agricultural farming farms farm foods food green renewable renewables solar
    power electric electrical electronics electro electronic instruments materials material
    analytics analysis data info infotech intelligent intelligence ai ml iot cyber cybertech cloud
    smart mobility drones drone semiconductor semiconductors semicon photonics optics sensors sensor
    sense sensing networks network hub works studio studios design designs development projects
    project trading financial finance consulting consultants resources advanced applied integrated
    integration precision universal united national general standard modern future next new neo
    nova prime alpha beta delta omega sigma star stars sun blue red white black grey gray golden gold
    silver bright first one two nine open core vision mind brain heart hope true pure spark wave
    flow edge peak apex zen ultra super hyper micro macro meta quantum wellness environmental enviro
    eco earth water air fire climate edutech education learning mobile coin cell cells limb
    genetics genomics research surgery rural vertical polymeric club combat arms infra build
    buildtech construction manufacturing additive printing print shakti neer jana shree sri tatva
    uber ripple trident canary sakura penguin bumblebee sustain phonologies nirvaan robotex genoscope
    trek connect advantage creative elite royal supreme best quality trust value leads approach
    mech mechanical mechatronics chemical chemicals clean cleantech plastics bioplastics biofuels
    """.split()
)

# Endings that mark a coined business word, so "Denovo Bioinnovations" is not read as a
# person's name the way "Deepak Ghavari" is.
BUSINESS_ENDING = re.compile(r"(?:ics|tech|labs?|ions|als|ogy|ware|care|farma|pharma|ix|ex)$")

_WORD = re.compile(r"[A-Za-z0-9]+")


def _words(text: str) -> list[str]:
    return _WORD.findall(text)


def _looks_like_a_person(words: list[str]) -> bool:
    """Two or three capitalised words, none of them a business word or coinage."""
    if not 2 <= len(words) <= 3:
        return False
    for word in words:
        if not re.fullmatch(r"[A-Z][a-z]+", word):
            return False
        lower = word.lower()
        if lower in GENERIC or BUSINESS_ENDING.search(lower):
            return False
    return True


def _core(name: str) -> tuple[list[str], bool]:
    """The name's words without its legal form, and whether it had one."""
    text = html.unescape(name).strip()
    # "KeraX, A Subsidiary of KeraLink International": the name is before the comma.
    text = text.split(",")[0]
    bracketed = re.findall(r"\(([^)]*)\)", text)
    outside = re.sub(r"\([^)]*\)", " ", text)
    for inner in bracketed:
        inner_words = _words(inner)
        # A registered name in brackets is the entity; the brand outside is marketing.
        if len(inner_words) >= 2 and inner_words[-1].lower() in {"limited", "ltd", "llp"}:
            outside = inner
            break
    words = [w for w in _words(outside.replace("&", " "))]
    had_suffix = False
    while words and words[-1].lower() in LEGAL_TAIL:
        had_suffix = had_suffix or words[-1].lower() != "india"
        words.pop()
    return words, had_suffix


def needle(name: str) -> str | None:
    """The phrase to look for in affiliations, or None when the name is too common to.

    See the module docstring, rule 2. The needle keeps the name's own spelling and
    case; every comparison ignores case.
    """
    words, had_suffix = _core(name or "")
    if not words:
        return None
    if not had_suffix and _looks_like_a_person(words):
        return None
    lowered = [w.lower() for w in words]
    if len(words) == 1:
        word = lowered[0]
        letters = sum(ch.isalpha() for ch in word)
        if letters < 7 or word in GENERIC:
            return None
    else:
        if not any(sum(ch.isalpha() for ch in w) >= 4 and w not in GENERIC for w in lowered):
            return None
    return " ".join(words)


# --- verification --------------------------------------------------------------

INDIA_PLACES = [
    "india", "iit", "iisc", "iiit", "iiser", "iitb", "iitm", "iitd",
    "andhra pradesh", "arunachal pradesh", "assam", "bihar", "chhattisgarh", "goa", "gujarat",
    "haryana", "himachal pradesh", "jharkhand", "karnataka", "kerala", "madhya pradesh",
    "maharashtra", "manipur", "meghalaya", "mizoram", "nagaland", "odisha", "orissa", "rajasthan",
    "sikkim", "tamil nadu", "tamilnadu", "telangana", "tripura", "uttar pradesh", "uttarakhand",
    "west bengal", "puducherry", "pondicherry", "chandigarh", "ladakh",
    "mumbai", "bombay", "delhi", "new delhi", "bengaluru", "bangalore", "chennai", "madras",
    "hyderabad", "secunderabad", "pune", "kolkata", "calcutta", "ahmedabad", "gurugram", "gurgaon",
    "noida", "greater noida", "thane", "navi mumbai", "kochi", "cochin", "thiruvananthapuram",
    "trivandrum", "coimbatore", "mysuru", "mysore", "mangaluru", "mangalore", "jaipur", "lucknow",
    "kanpur", "indore", "bhopal", "nagpur", "nashik", "surat", "vadodara", "baroda", "gandhinagar",
    "bhubaneswar", "visakhapatnam", "vijayawada", "guwahati", "patna", "ranchi", "raipur",
    "dehradun", "roorkee", "mohali", "kharagpur", "tiruchirappalli", "trichy", "madurai", "vellore",
    "manipal", "hubli", "dharwad", "belagavi", "belgaum", "kozhikode", "calicut", "thrissur",
    "varanasi", "prayagraj", "allahabad", "jodhpur", "udaipur", "ludhiana", "amritsar", "faridabad",
    "ghaziabad", "warangal", "tirupati", "rajkot", "aurangabad", "kolhapur", "jamshedpur",
    "dhanbad", "jabalpur", "gwalior", "meerut", "haridwar", "shimla", "shillong", "imphal",
    "silchar", "durgapur", "bhilai", "powai", "taramani", "whitefield", "electronic city",
]
INDIAN_FORM = ["pvt", "private limited", "p ltd", "llp", "opc"]

_MARKERS = re.compile(r"\b(?:" + "|".join(re.escape(p).replace(r"\ ", r"\s+") for p in INDIA_PLACES + INDIAN_FORM) + r")\b")


def _normal(text: str) -> str:
    """Lowercase words separated by single spaces, '&' and 'and' removed, padded."""
    words = [w for w in _WORD.findall(text.replace("&", " ").lower()) if w != "and"]
    return f" {' '.join(words)} "


def _affiliations(work: dict) -> list[str]:
    strings: list[str] = []
    for authorship in work.get("authorships") or ():
        for raw in authorship.get("raw_affiliation_strings") or ():
            if raw:
                strings.append(raw)
        for affiliation in authorship.get("affiliations") or ():
            raw = (affiliation or {}).get("raw_affiliation_string")
            if raw:
                strings.append(raw)
    return strings


# What may follow a one-word name inside its own part of an affiliation. Read on the
# backfill: "Chimertech Innovations LLP", "Algosurg Products Pvt Ltd" and "CrisprBits
# Laboratory" are each very likely the company, and each is also a differently named
# organisation, which is exactly what a one-word match cannot tell apart. "India" is
# not here, so '"Electronlab India" Research Facility' is not Electronlab LLP.
FORM_WORDS = frozenset("pvt private ltd limited llp opc inc p corp".split())

# A law report that names the company as a party ("Tharakan Web Innovations Pvt. Ltd.
# v. National Company Law Tribunal") reaches OpenAlex as an affiliation. It is a fact
# about the company, but it is not a paper its people wrote.
COURT = re.compile(r"\b(?:tribunal|court|petition|w\s*p\s*c)\b")


def _opens_part(part: str, target: str) -> bool:
    """A one-word name standing as the organisation of one comma-separated piece."""
    for piece in part.split(","):
        normal = _normal(piece)
        if not normal.startswith(target):
            continue
        rest = normal[len(target):].split()
        if not rest or rest[0] in FORM_WORDS:
            return True
    return False


def matching_affiliation(work: dict, phrase: str) -> str | None:
    """The first affiliation on the work that names this company, by rule 3, or None."""
    target = _normal(phrase)
    if target.strip() == "":
        return None
    single = len(target.split()) == 1
    for raw in _affiliations(work):
        for part in raw.split(";"):
            normal = _normal(part)
            if target not in normal or not _MARKERS.search(normal) or COURT.search(normal):
                continue
            if single and not _opens_part(part, target):
                continue
            return part.strip()
    return None


# --- the result ------------------------------------------------------------------


@dataclass(frozen=True)
class Work:
    title: str
    year: int | None
    url: str  # the DOI when the work has one, else its OpenAlex page


@dataclass(frozen=True)
class Papers:
    count: int
    works: tuple[Work, ...]  # at most 3, newest first
    query_url: str  # a public OpenAlex URL a reader can open to see what was searched


def query_url(phrase: str) -> str:
    """The single-needle search, as a link. It shows OpenAlex's loose superset, which
    is why its count can be higher than ours: we keep only what rule 3 verifies."""
    value = f'raw_affiliation_strings.search:"{phrase}"'
    return f"{API}?filter={urllib.parse.quote(value, safe=':')}&sort=publication_date:desc"


def _title(raw: str | None) -> str:
    text = re.sub(r"<[^>]+>", " ", html.unescape(raw or ""))
    return re.sub(r"\s+", " ", text).strip() or "(untitled)"


def _work(raw: dict) -> Work:
    return Work(title=_title(raw.get("title")), year=raw.get("publication_year"), url=raw.get("doi") or raw.get("id") or "")


# Not papers: a journal's list of contributors, a correction notice for a paper already
# counted, a retraction. Read on the backfill, where "Contributors" and "Corrigendum to
# ..." were two of a company's three newest works.
NOT_A_PAPER_TYPES = frozenset({"erratum", "paratext", "retraction", "editorial"})
NOT_A_PAPER_TITLE = re.compile(
    r"^(?:(?:list of )?contributors|peer[- ]review statements?|front matter|back matter|index|preface"
    r"|table of contents|corrigendum|correction|erratum|retraction|retracted)\b",
    re.IGNORECASE,
)


def _is_paper(work: dict) -> bool:
    if work.get("is_retracted") or work.get("type") in NOT_A_PAPER_TYPES:
        return False
    return not NOT_A_PAPER_TITLE.match(_title(work.get("title")))


def _title_key(work: dict) -> tuple[str, bool]:
    """One entry per title: a preprint and its journal version, or a conference poster
    and its abstract, are one piece of work and would otherwise be counted twice. The
    flag says the title carried a "POSTER:" label, so the plain one is shown instead."""
    words = _normal(_title(work.get("title"))).split()
    poster = bool(words) and words[0] == "poster"
    return " ".join(words[1:] if poster else words), poster


def papers_for(phrase: str, works: list[dict]) -> Papers:
    """Rule 3 applied to OpenAlex's nominations for one needle."""
    kept = [w for w in works if _is_paper(w) and matching_affiliation(w, phrase)]
    kept.sort(key=lambda w: (w.get("publication_date") or str(w.get("publication_year") or "")), reverse=True)
    unique: dict[str, dict] = {}
    for work in kept:
        key, poster = _title_key(work)
        if key not in unique or (_title_key(unique[key])[1] and not poster):
            unique[key] = work
    newest = list(unique.values())
    return Papers(count=len(newest), works=tuple(_work(w) for w in newest[:WORKS_KEPT]), query_url=query_url(phrase))


# --- talking to OpenAlex -----------------------------------------------------------


class Unavailable(RuntimeError):
    """OpenAlex could not answer: down, refusing, or out of today's allowance."""


class OutOfAllowance(Unavailable):
    """The day's metered allowance is spent. Nothing to do but wait for tomorrow."""


class TooBroad(Exception):
    """One needle nominated more than MAX_RAW works."""


_last_call = 0.0


def _http(url: str, params: dict) -> tuple[int, dict, str]:
    """One GET. Separate so tests can replace the network with canned answers."""
    response = requests.get(url, params=params, headers={"User-Agent": USER_AGENT}, timeout=TIMEOUT_SECONDS)
    return response.status_code, {k.lower(): v for k, v in response.headers.items()}, response.text


def _get(params: dict, deadline: float | None) -> dict:
    """One paced, retried request to /works. Raises Unavailable, never anything else."""
    global _last_call
    params = dict(params)
    key = os.environ.get("OPENALEX_API_KEY")
    if key:
        params["api_key"] = key
    last_problem = "no attempt made"
    for attempt in range(RETRIES):
        pause = MIN_INTERVAL_SECONDS - (time.monotonic() - _last_call)
        if deadline is not None and time.monotonic() + max(pause, 0) > deadline:
            raise Unavailable("time budget reached")
        if pause > 0:
            time.sleep(pause)
        try:
            status, headers, text = _http(API, params)
        except requests.RequestException as error:
            status, headers, text = None, {}, ""
            last_problem = type(error).__name__
        _last_call = time.monotonic()

        if status == 200:
            try:
                return json.loads(text)
            except ValueError:
                last_problem = "a reply that was not JSON"
        elif status is not None:
            last_problem = f"HTTP {status}"
            remaining = headers.get("x-ratelimit-remaining-usd")
            if status == 429 and remaining is not None and _float(remaining) <= 0:
                raise OutOfAllowance("OpenAlex's daily allowance is spent")
            if status not in (429, 500, 502, 503, 504):
                # Our request is wrong; asking again is only rudeness.
                raise Unavailable(last_problem)
            retry_after = _float(headers.get("retry-after"))
            if retry_after > MAX_RETRY_AFTER_SECONDS:
                raise OutOfAllowance(f"OpenAlex asked us to wait {retry_after:.0f}s")

        if attempt + 1 < RETRIES:
            wait = max(2.0 * 2**attempt, _float(headers.get("retry-after")))
            if deadline is not None and time.monotonic() + wait > deadline:
                raise Unavailable(f"{last_problem}, and no time left to retry")
            time.sleep(wait)
    raise Unavailable(last_problem)


def _float(value) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return 0.0


def _filter(phrases: list[str]) -> str:
    return "raw_affiliation_strings.search:" + "|".join(f'"{p}"' for p in phrases)


def _nominate(phrases: list[str], deadline: float | None) -> list[dict]:
    """Every work OpenAlex's loose search returns for these needles, all pages."""
    params = {"filter": _filter(phrases), "per-page": PER_PAGE, "select": SELECT, "sort": "publication_date:desc"}
    first = _get({**params, "page": 1}, deadline)
    total = int((first.get("meta") or {}).get("count") or 0)
    works = list(first.get("results") or [])
    if total <= len(works):
        return works
    if len(phrases) > 1:
        raise TooBroad()
    if total > MAX_RAW:
        raise TooBroad()
    page = 2
    while len(works) < total:
        more = list(_get({**params, "page": page}, deadline).get("results") or [])
        if not more:
            break
        works.extend(more)
        page += 1
    return works


def _resolve(phrases: list[str], deadline: float | None) -> dict[str, list[dict] | None]:
    """Nominations per needle; None for a needle too broad to be a startup's name.

    A batch whose combined results overflow one page is split in half and each half
    asked again, down to single needles, so one common phrase costs a few extra
    requests rather than the whole batch.
    """
    try:
        works = _nominate(phrases, deadline)
    except TooBroad:
        if len(phrases) == 1:
            return {phrases[0]: None}
        middle = len(phrases) // 2
        return {**_resolve(phrases[:middle], deadline), **_resolve(phrases[middle:], deadline)}
    return {phrase: works for phrase in phrases}


def search(name: str) -> Papers | None:
    """Papers under one company's name; None when the name is too common to search.

    Raises Unavailable when OpenAlex cannot answer, so a failure is never mistaken
    for "no papers". A needle too broad to verify is also None: it is not this
    company's name in any sense a reader could use.
    """
    phrase = needle(name)
    if phrase is None:
        return None
    works = _resolve([phrase], None)[phrase]
    if works is None:
        return None
    return papers_for(phrase, works)


# --- many companies, cached ----------------------------------------------------------


def _now() -> datetime.datetime:
    return datetime.datetime.now(datetime.UTC)


def _load(path: pathlib.Path) -> dict:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def _save(path: pathlib.Path, entries: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".json.tmp")
    temporary.write_text(json.dumps(entries, indent=1, sort_keys=True, ensure_ascii=False) + "\n", encoding="utf-8")
    temporary.replace(path)


def _fresh(entry, phrase: str, now: datetime.datetime) -> bool:
    # Case-blind: the register prints names in capitals and the page recases them, and
    # the same name in two casings is the same search.
    if not isinstance(entry, dict) or str(entry.get("needle") or "").casefold() != phrase.casefold() or entry.get("rule") != RULE_VERSION:
        return False
    try:
        checked = datetime.datetime.fromisoformat(entry["checked"])
    except (KeyError, TypeError, ValueError):
        return False
    if checked.tzinfo is None:
        checked = checked.replace(tzinfo=datetime.UTC)
    return now - checked < datetime.timedelta(days=REFRESH_DAYS)


def _from_entry(entry: dict) -> Papers | None:
    if entry.get("count") is None:
        return None
    works = tuple(Work(title=w.get("title") or "", year=w.get("year"), url=w.get("url") or "") for w in entry.get("works") or ())
    return Papers(count=int(entry["count"]), works=works, query_url=entry.get("query_url") or query_url(entry["needle"]))


def _entry(phrase: str, papers: Papers | None, now: datetime.datetime) -> dict:
    return {
        "needle": phrase,
        "count": None if papers is None else papers.count,
        "works": [] if papers is None else [dataclasses.asdict(w) for w in papers.works],
        "query_url": query_url(phrase),
        "checked": now.isoformat(timespec="seconds"),
        "rule": RULE_VERSION,
    }


def lookup(companies, max_seconds: float = 900, *, cache_path: pathlib.Path | None = None) -> dict[str, Papers]:
    """Papers for every company whose name can be searched, by company id.

    Answers younger than 30 days come from ingest/cache/papers.json and cost nothing.
    The rest are asked in batches until the time budget or OpenAlex's daily allowance
    runs out; whatever was answered is written to the cache as it arrives, so a
    stopped run loses nothing and the next one carries on where it left off.

    Never raises. A company missing from the result has no searchable name, a name
    too broad to verify, or was not reached this run; one present with count 0 was
    searched and has nothing.
    """
    path = cache_path or CACHE_PATH
    start = time.monotonic()
    deadline = start + max_seconds
    results: dict[str, Papers] = {}
    try:
        cache = _load(path)
        now = _now()
        waiting: dict[str, list[str]] = {}  # needle -> company ids
        for company in companies:
            phrase = needle(company.name)
            if phrase is None:
                continue
            entry = cache.get(company.id)
            if _fresh(entry, phrase, now):
                papers = _from_entry(entry)
                if papers is not None:
                    results[company.id] = papers
                continue
            waiting.setdefault(phrase, []).append(company.id)

        phrases = list(waiting)
        asked = found = 0
        stopped = None
        for offset in range(0, len(phrases), BATCH):
            batch = phrases[offset : offset + BATCH]
            try:
                nominated = _resolve(batch, deadline)
            except OutOfAllowance as error:
                stopped = str(error)
                break
            except Unavailable as error:
                stopped = str(error)
                break
            checked = _now()
            for phrase in batch:
                works = nominated.get(phrase)
                papers = None if works is None else papers_for(phrase, works)
                for company_id in waiting[phrase]:
                    cache[company_id] = _entry(phrase, papers, checked)
                    if papers is not None:
                        results[company_id] = papers
                asked += 1
                found += bool(papers and papers.count)
            _save(path, cache)

        left = len(phrases) - asked
        print(f"  papers: {asked} names searched this run, {found} with papers, {left} left for the next run")
        if stopped and left:
            print(f"  papers: stopped early ({stopped}); the rest wait for the next run")
    except Exception as error:  # noqa: BLE001 - a missing trace must not stop the nightly
        print(f"  papers: gave up ({type(error).__name__}: {error}); keeping what was answered")
    return results


def main(argv: list[str]) -> int:
    for name in argv or ["QuNu Labs Private Limited"]:
        phrase = needle(name)
        print(f"{name!r} -> needle {phrase!r}")
        if phrase is None:
            continue
        papers = search(name)
        if papers is None:
            print("  too broad to verify")
            continue
        print(f"  {papers.count} papers  {papers.query_url}")
        for work in papers.works:
            print(f"    {work.year}  {work.title}  {work.url}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
