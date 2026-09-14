"""Evidence: public lists that say something happened to a company we already hold.

A source in ingest/sources/ finds companies. A collector here never does. An award
list, a grant PDF or a funding register names its recipients, and those names are
only worth anything once an integrator has matched them — exactly, see match.py — to
a company already on file and attached the record as a dated event. A name on one of
these lists that matches nothing is dropped there, not created: these lists include
individuals, institutions and big manufacturers, and none of that is a startup we
would have found.

Every collector exposes SOURCE and `collect() -> list[Award]`, and raises ValueError
when a page or document yields no records, because a list that silently shrinks to
nothing is a shape change, not a quiet year.

Two dates, never merged. `date` is when the source says the thing happened — a full
ISO date, or a bare year when that is all it says, never a year padded to 1 January.
`published` is when the list itself was published or uploaded. A page date or an
upload timestamp is never copied into `date` for want of one.
"""

from __future__ import annotations

import datetime
import hashlib
import json
import re
import time
import urllib.parse
from dataclasses import dataclass

import requests

from ingest.entity import LEGAL_SUFFIX, NOT_A_PERSONAL_NAME
from ingest.sources import base
from ingest.sources.base import USER_AGENT, clean


@dataclass(frozen=True)
class Award:
    name: str  # the recipient as the source writes it
    type: str  # "award" or "grant"
    label: str  # human line, e.g. "National Startup Awards 2022, winner — Agriculture"
    date: str | None  # "YYYY-MM-DD" or "YYYY" as the source states it; None if it does not
    published: str | None  # when the list/page was published or uploaded, kept apart from date
    url: str  # the public page or PDF a reader can open
    source: str  # the collector's SOURCE id
    dpiit_number: str | None = None
    city: str | None = None
    is_company: bool = True  # False when the recipient is plainly an individual or institution


# ---------------------------------------------------------------------------------------
# Individuals and institutions


# Words that make a short name a business rather than a person, on top of the ones
# entity.py already uses. Cheap, and deliberately one-sided: missing a business word
# only ever mislabels a two-word company as a person, which the integrator does not act
# on — it matches names against companies already held either way.
BUSINESS_WORDS = NOT_A_PERSONAL_NAME | frozenset(
    """
    creators care crop wireless dynamics defence defense security software services
    enterprises enterprise diagnostics pharma sciences science genomics medtech agritech
    fintech edtech mobility automation automations electronics electric instruments
    sensors photonics semiconductors chemicals polymers textiles designs design
    consulting consultancy logistics motors vehicles drones aviation marine naval
    research innovation creations organics nutrition wellness therapeutics biologics
    biosciences lifesciences life cell cells water waste recycling solar international
    global india exports imports trading traders
    """.split()
)

# "Energicals", "Genetics", "Medtech": endings a surname does not have.
BUSINESS_ENDING = re.compile(r"(?:icals|ics|tech|labs|ware|logy)$", re.IGNORECASE)

INSTITUTION = re.compile(
    r"\b(?:foundation|university|institute|institution|college|centre|center|council|society|"
    r"trust|hospital|school|association|federation|programme|program|iit|iim|nit|iisc|"
    r"incubation|incubator|accelerator|mission|department|ministry|government|govt)\b",
    re.IGNORECASE,
)
TITLE = re.compile(r"^\s*(?:dr|prof|mr|mrs|ms|shri|smt|capt|col|gp capt)\b\.?", re.IGNORECASE)
INITIAL = re.compile(r"^[A-Za-z]{1,2}\.?$")


def is_company(name: str, *, people_possible: bool = True) -> bool:
    """False only when the name is plainly a person or an institution.

    A legal suffix settles it as a company before anything else is looked at: "Villgro
    Innovations Foundation Private Limited" is a company. Then a title ("Dr.", "Prof.",
    "Mr") or an institution word makes it not one. Then a name of exactly two
    alphabetic words, or one word with initials, initials allowed alongside either
    ("Ajaya P Katti", "Madhumohan R") — with no
    business word in it reads as a person — unless the list cannot hold people
    (`people_possible=False`: DPIIT's awards go to recognised entities, so "Soil Sathi"
    is a brand, not a name). Everything else stays a company.
    """
    text = clean(name) or ""
    if LEGAL_SUFFIX.search(text):
        return True
    if TITLE.match(text) or INSTITUTION.search(text):
        return False
    if not people_possible:
        return True
    tokens = [t for t in re.split(r"[\s,]+", text) if t]
    full = [t for t in tokens if not INITIAL.fullmatch(t)]
    person_shaped = len(full) == 2 or (len(full) == 1 and len(tokens) > 1)
    if person_shaped and len(tokens) <= 4 and all(re.fullmatch(r"[A-Za-z]+\.?", t) for t in tokens):
        if not any(t.strip(".").lower() in BUSINESS_WORDS or BUSINESS_ENDING.search(t.strip(".")) for t in tokens):
            return False
    return True


# ---------------------------------------------------------------------------------------
# Places

STATES = frozenset(
    s.strip().lower()
    for s in """
    Andhra Pradesh|Arunachal Pradesh|Assam|Bihar|Chhattisgarh|Goa|Gujarat|Haryana|Himachal Pradesh|
    Jharkhand|Karnataka|Kerala|Madhya Pradesh|Maharashtra|Manipur|Meghalaya|Mizoram|Nagaland|Odisha|
    Orissa|Punjab|Rajasthan|Sikkim|Tamil Nadu|Telangana|Tripura|Uttar Pradesh|Uttarakhand|West Bengal|
    Andaman and Nicobar Islands|Dadra and Nagar Haveli and Daman and Diu|Jammu and Kashmir|
    Jammu & Kashmir|Ladakh|Lakshadweep|MP|UP|WB|J&K|TN|AP|India
    """.split("|")
    if s.strip()
)
# Delhi, Chandigarh and Puducherry are left out on purpose: on these pages they are
# the city.


def city_from(place: str | None) -> str | None:
    """The city in a place line — "Telangana, Hyderabad", "Bengaluru Rural, Karnataka",
    "Rewari, (Haryana)" — or None when the line names only a state.

    Parts in brackets are a state by convention on these pages; a part that is a state
    name is dropped; the first part left is the city.
    """
    text = clean(place)
    if not text:
        return None
    text = re.sub(r"\([^)]*\)", ",", text)
    parts = [p.strip(" .,;") for p in re.split(r"[,/]", text)]
    parts = [p for p in parts if p and p.lower() not in STATES]
    return parts[0] if parts else None


# ---------------------------------------------------------------------------------------
# Dates

MONTHS = {m.lower(): i for i, m in enumerate(
    "jan feb mar apr may jun jul aug sep oct nov dec".split(), start=1)}


def written_date(text: str) -> str | None:
    """A date written out in prose — "4th May, 2017", "Oct 31, 2025", "16th January
    2024" — as YYYY-MM-DD, or None when the text holds no whole date."""
    day_first = re.search(r"\b(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,9})\.?,?\s+((?:19|20)\d{2})\b", text)
    month_first = re.search(r"\b([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+((?:19|20)\d{2})\b", text)
    for match, (d, m, y) in ((day_first, (1, 2, 3)), (month_first, (2, 1, 3))):
        if match is None:
            continue
        month = MONTHS.get(match.group(m)[:3].lower())
        if month is None:
            continue
        try:
            return datetime.date(int(match.group(y)), month, int(match.group(d))).isoformat()
        except ValueError:
            continue
    return None


def upload_date(url: str) -> str | None:
    """The upload day a CMS stamps into a file name: a 10-digit Unix epoch in front
    ("1630669396_BIG_18_Awardees.pdf"), or a yyyymmdd run. None when there is neither.

    This is when the file was put online — `published`, never `date`.
    """
    name = urllib.parse.unquote(urllib.parse.urlsplit(url).path.rsplit("/", 1)[-1])
    epoch = re.match(r"(\d{10})(?!\d)", name)
    if epoch:
        stamp = datetime.datetime.fromtimestamp(int(epoch.group(1)), datetime.UTC).date()
        if datetime.date(2005, 1, 1) <= stamp <= datetime.date.today():
            return stamp.isoformat()
    ymd = re.search(r"(?<!\d)((?:19|20)\d{2})(\d{2})(\d{2})(?!\d)", name)
    if ymd:
        try:
            return datetime.date(*map(int, ymd.groups())).isoformat()
        except ValueError:
            return None
    return None


# ---------------------------------------------------------------------------------------
# Binary fetch

_last_binary_call = 0.0


def fetch_bytes(url: str, *, force: bool = False) -> bytes:
    """A PDF, politely: base.py's user-agent, its one-second pacing, its 30-day cache.

    base.fetch hands back decoded text, which is the right thing for a page and ruins
    a PDF, so the bytes are cached beside the pages as <stem>-<hash>.bin with a small
    JSON sidecar that says when they were fetched.
    """
    global _last_binary_call

    parts = urllib.parse.urlsplit(url)
    stem = re.sub(r"[^a-z0-9]+", "-", f"{parts.netloc}{parts.path}".lower()).strip("-")[:60]
    digest = hashlib.sha256(url.encode()).hexdigest()[:8]
    blob = base.CACHE_DIR / f"{stem}-{digest}.bin"
    meta = blob.with_suffix(".json")
    if not force and blob.exists() and meta.exists():
        try:
            fetched = datetime.datetime.fromisoformat(json.loads(meta.read_text())["fetched_at"])
            if (datetime.datetime.now(datetime.UTC) - fetched).total_seconds() <= base.CACHE_TTL_SECONDS:
                return blob.read_bytes()
        except (OSError, ValueError, KeyError):
            pass

    for attempt in range(1, base.RETRIES + 1):
        last = max(_last_binary_call, getattr(base, "_last_call", 0.0))
        pause = base.DELAY_SECONDS - (time.monotonic() - last)
        if pause > 0:
            time.sleep(pause)
        try:
            response = requests.get(url, headers={"User-Agent": USER_AGENT}, timeout=60)
            _last_binary_call = time.monotonic()
            if response.status_code in base.RETRY_STATUSES:
                raise requests.HTTPError(f"{response.status_code} from {url}", response=response)
            response.raise_for_status()
            break
        except requests.RequestException:
            _last_binary_call = time.monotonic()
            if attempt == base.RETRIES:
                raise
            time.sleep(base.DELAY_SECONDS * 2 ** (attempt - 1))

    base.CACHE_DIR.mkdir(parents=True, exist_ok=True)
    blob.write_bytes(response.content)
    meta.write_text(json.dumps({"url": url, "fetched_at": datetime.datetime.now(datetime.UTC).isoformat()}))
    return response.content
