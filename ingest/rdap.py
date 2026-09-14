"""When a company's domain was first registered, from RDAP.

A date that nobody here has to believe a company about. Most of these rows carry no
founding year at all — a recognition register publishes when a company was
recognised, not when it began — and a homepage's copyright line is whatever year
the template was last touched. The registry's own record of when the domain was
registered is neither of those. It is not a founding date either: a founder can
buy a domain years before incorporating, or rebrand onto a new one years after.
What it says, and all it says, is that this address existed from that day. That is
a floor under "how long has this been around", and it is the kind of fact the page
can print beside the link without asking anyone to take it on trust.

RDAP is the structured successor to WHOIS. https://rdap.org is a public bootstrap
service: it answers every query with a redirect to whichever registry runs that
TLD (NIXI for .in, Verisign for .com), so one URL shape covers every suffix those
registries serve. It is free, needs no key, and — measured over 18 sample domains
on 14 September — gave a registration date for 17.

    python3 -c "from ingest import rdap; print(rdap.registered('https://www.fabheads.in'))"

Answers are kept in ingest/cache/rdap.json, committed, keyed by domain. A date is
kept forever, because a domain's registration date does not change while it stays
registered. A domain that gave no date is asked again after 30 days, because "no
answer" is a fact about one night's request as often as about the domain.
"""

from __future__ import annotations

import datetime
import ipaddress
import json
import os
import pathlib
import re
import time
from urllib.parse import urlparse

import requests

from ingest import identity
from ingest.sources.base import USER_AGENT

RDAP_URL = "https://rdap.org/domain/{domain}"

CACHE_PATH = pathlib.Path(__file__).parent / "cache" / "rdap.json"

# A null is a question worth asking again; a date is not.
RETRY_NULL_AFTER = datetime.timedelta(days=30)

DELAY_SECONDS = 1.0
TIMEOUT_SECONDS = 15

VERIFIED = "verified"

# Suffixes under which the registrable name is three labels, not two. A hand list
# rather than the Public Suffix List, because this pipeline has three dependencies
# and every domain it has ever seen fits in this set; a suffix missing from here
# makes "foo.co.xx" look like "co.xx", and RDAP then answers for the wrong name
# rather than not at all — so when a new country turns up, add it here.
MULTI_PART_SUFFIXES = frozenset(
    """
    co.in org.in net.in ac.in edu.in gov.in res.in firm.in gen.in ind.in nic.in mil.in ernet.in
    co.uk org.uk ac.uk gov.uk ltd.uk plc.uk me.uk
    com.au net.au org.au edu.au gov.au
    co.nz org.nz ac.nz
    com.sg edu.sg org.sg
    com.my co.jp co.kr co.za co.id co.il com.br com.cn com.hk com.tw com.tr com.mx com.ar com.bd
    com.pk com.np com.lk com.ph com.vn com.eg com.ng com.sa
    """.split()
)

# Hosts where anyone can have a subdomain. The registrable name is the customer's
# subdomain — anurag49.github.io, not github.io — for deciding what is "the same
# site", but its registration date would be GitHub's, so nothing here asks RDAP about
# one.
HOSTED_SUFFIXES = frozenset(
    """
    github.io gitlab.io vercel.app netlify.app pages.dev web.app firebaseapp.com herokuapp.com
    wixsite.com wordpress.com blogspot.com weebly.com webflow.io square.site godaddysites.com
    business.site mystrikingly.com carrd.co framer.website framer.ai notion.site myshopify.com
    azurewebsites.net onrender.com replit.app glitch.me wix.com
    """.split()
)


def _hostname(website: str | None) -> str | None:
    if not website:
        return None
    text = website.strip()
    try:
        name = urlparse(text if "//" in text else f"//{text}").hostname
    except ValueError:
        return None
    if not name:
        return None
    return name.lower().rstrip(".")


def registrable(website: str | None) -> str | None:
    """The name someone registered: www.foo.co.in and shop.foo.co.in are both foo.co.in.

    Accepts a URL, a bare host or an email domain. None for anything that is not a
    domain name at all — an IP address, localhost, an unparseable string.
    """
    name = _hostname(website)
    if not name or "." not in name:
        return None
    try:
        ipaddress.ip_address(name)
        return None
    except ValueError:
        pass
    labels = [label for label in name.split(".") if label]
    if len(labels) < 2 or not all(re.fullmatch(r"[a-z0-9-]+", label) for label in labels):
        return None
    last_two = ".".join(labels[-2:])
    if last_two in MULTI_PART_SUFFIXES or last_two in HOSTED_SUFFIXES:
        return ".".join(labels[-3:]) if len(labels) >= 3 else None
    return last_two


def is_hosted(domain: str | None) -> bool:
    """A subdomain of a website builder or hosting platform, whose registration is not theirs."""
    if not domain:
        return False
    return ".".join(domain.split(".")[-2:]) in HOSTED_SUFFIXES


def parse_registration(data: dict) -> str | None:
    """The 'registration' event of an RDAP domain response, as YYYY-MM-DD.

    Registries write the timestamp with or without a zone and with or without
    fractions of a second; only the date is kept, and only if it is one.
    """
    try:
        events = data.get("events") or []
        for event in events:
            if not isinstance(event, dict) or event.get("eventAction") != "registration":
                continue
            day = str(event.get("eventDate") or "")[:10]
            datetime.date.fromisoformat(day)
            return day
    except (AttributeError, TypeError, ValueError):
        return None
    return None


# --- asking ------------------------------------------------------------------

_last_call = 0.0


class RateLimited(Exception):
    """rdap.org or a registry said to slow down. The run stops rather than argue."""


def _query(domain: str, session: requests.Session | None = None) -> str | None:
    """One polite RDAP request for one domain: the date, or None.

    Raises RateLimited on a 429, and nothing else: a timeout, a 404 for a name the
    registry does not know, a registry with no RDAP service, and a response with no
    registration event all come back as None, because to the cache they are the same
    thing — no date tonight, ask again in a month.
    """
    global _last_call
    pause = DELAY_SECONDS - (time.monotonic() - _last_call)
    if pause > 0:
        time.sleep(pause)
    getter = session.get if session is not None else requests.get
    try:
        response = getter(
            RDAP_URL.format(domain=domain),
            headers={"User-Agent": USER_AGENT, "Accept": "application/rdap+json, application/json"},
            timeout=TIMEOUT_SECONDS,
            allow_redirects=True,
        )
    except requests.RequestException as error:
        print(f"  rdap {domain}: {type(error).__name__}")
        return None
    finally:
        _last_call = time.monotonic()
    if response.status_code == 429:
        raise RateLimited(domain)
    if response.status_code != 200:
        print(f"  rdap {domain}: HTTP {response.status_code}")
        return None
    try:
        return parse_registration(response.json())
    except ValueError:
        print(f"  rdap {domain}: response was not JSON")
        return None


def registered(website: str) -> str | None:
    """The date the website's registrable domain was registered, or None.

    No cache here: this is the raw question, for a person at a prompt. lookup() is
    the one the pipeline runs.
    """
    domain = registrable(website)
    if domain is None or is_hosted(domain) or identity.is_profile(website):
        return None
    try:
        return _query(domain)
    except RateLimited:
        print(f"  rdap {domain}: rate limited")
        return None


# --- cache -------------------------------------------------------------------


def _now() -> datetime.datetime:
    return datetime.datetime.now(datetime.UTC)


def load(path: pathlib.Path = CACHE_PATH) -> dict:
    try:
        entries = json.loads(pathlib.Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return entries if isinstance(entries, dict) else {}


def save(entries: dict, path: pathlib.Path = CACHE_PATH) -> None:
    """Written whole and renamed into place, so a run killed mid-write leaves the last good file."""
    path = pathlib.Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(entries, indent=1, sort_keys=True) + "\n", encoding="utf-8")
    os.replace(temporary, path)


def needs_asking(entry: dict | None, now: datetime.datetime) -> bool:
    """Whether a cached answer should be asked again: never for a date, after 30 days for a null."""
    if not isinstance(entry, dict):
        return True
    if entry.get("registered"):
        return False
    try:
        checked = datetime.datetime.fromisoformat(entry["checked"])
    except (KeyError, TypeError, ValueError):
        return True
    if checked.tzinfo is None:
        checked = checked.replace(tzinfo=datetime.UTC)
    return now - checked >= RETRY_NULL_AFTER


# --- the run -----------------------------------------------------------------


def lookup(
    companies,
    max_seconds: float = 600,
    *,
    cache_path: pathlib.Path = CACHE_PATH,
    query=None,
    now=_now,
) -> dict[str, str]:
    """Company id to registration date, for every verified website with a known date.

    Only 'verified' websites, for the reason identity.py gives: an address nothing
    ties to the company would put a stranger's domain age beside its name. Companies
    that share a domain share one request.

    Answers already cached are returned without asking. The rest are asked one a
    second until `max_seconds` is spent, and each is written to the cache as it
    arrives, so a run the nightly job cuts short keeps what it learned and the next
    night carries on from there. Nothing raises out of here: a registry that fails is
    one missing date, not a failed ingest.

    `query` and `now` are there for the tests, which must not touch the network.
    """
    ask = query or _query
    started = time.monotonic()
    results: dict[str, str] = {}
    try:
        cache = load(cache_path)
        by_domain: dict[str, list[str]] = {}
        for company in companies:
            if getattr(company, "website_identity", None) != VERIFIED:
                continue
            website = getattr(company, "website", None)
            domain = registrable(website)
            # A profile's registration date is LinkedIn's; identity.py never verifies
            # one, and this does not rely on that.
            if domain is None or is_hosted(domain) or identity.is_profile(website):
                continue
            by_domain.setdefault(domain, []).append(company.id)

        todo: list[str] = []
        for domain in sorted(by_domain):
            entry = cache.get(domain)
            if isinstance(entry, dict) and entry.get("registered"):
                for company_id in by_domain[domain]:
                    results[company_id] = entry["registered"]
            if needs_asking(entry, now()):
                todo.append(domain)
        # Never-asked domains before stale nulls: a partial night is better spent on
        # a question nobody has asked than on one that failed a month ago.
        todo.sort(key=lambda d: d in cache)

        asked = found = 0
        for domain in todo:
            if time.monotonic() - started >= max_seconds:
                print(f"  rdap: stopped at the {max_seconds:.0f}s budget with {len(todo) - asked} domains left for the next run")
                break
            try:
                day = ask(domain)
            except RateLimited:
                print(f"  rdap: rate limited at {domain}; stopping, the rest wait for the next run")
                break
            except Exception as error:  # noqa: BLE001 - one domain, not the run
                print(f"  rdap {domain}: {type(error).__name__}: {str(error)[:120]}")
                day = None
            asked += 1
            cache[domain] = {"registered": day, "checked": now().isoformat(timespec="seconds")}
            try:
                save(cache, cache_path)
            except OSError as error:
                print(f"  rdap: could not write {cache_path}: {error}")
            if day:
                found += 1
                for company_id in by_domain[domain]:
                    results[company_id] = day
        if asked:
            print(f"  rdap: asked {asked} domains, {found} gave a registration date")
    except Exception as error:  # noqa: BLE001 - a missing date must never fail the ingest
        print(f"  rdap: lookup stopped early: {type(error).__name__}: {str(error)[:120]}")
    return results
