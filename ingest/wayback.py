"""When the Internet Archive first kept a copy of a company's homepage.

The second free date about a domain, beside RDAP's (rdap.py), and a different one. A
registration date says the address was bought; a first capture says the public web
had noticed it — a crawler followed a link to the page, or someone asked the archive
to save it. A domain registered in 2015 and first archived in 2025 sat unseen for ten
years. That makes this an obscurity signal as much as an age: a recent first capture
means a page recently new to the public web, whatever the domain's age.

It is neither a founding date nor proof of anything about the company. The archive
crawls unevenly, and India's small-company web far less than most, so "no capture"
says as much about the crawler as about the site.

Asked through the CDX index, not the availability API. The availability API
(archive.org/wayback/available) answers only with captures that returned 200, so on
15 September 2026 it said relsym.com had never been archived while the index held a
capture from 20 November 2023 (a redirect to the site's https address). The index
lists every capture of the exact homepage oldest first, so one row is the answer.

    https://web.archive.org/cdx/search/cdx?url=relsym.com&output=json&limit=1&fl=timestamp,statuscode

The archive is often slow or down, and a failed question is not an answer. Each
cached entry keeps what happened as its own outcome:

    captured      a date, kept for ever: the first capture does not move
    not-archived  the index answered, and holds nothing for the homepage; asked again after 30 days
    unavailable   the archive answered with an error page (503 "Temporarily Offline" and the like)
    timeout       no answer inside the time limit
    error         the request failed some other way (DNS, a reset connection, a body that was not JSON)

The last three are facts about one night's request and are asked again on the next run.
None of the five says anything about whether the company is active.
"""

from __future__ import annotations

import datetime
import json
import os
import pathlib
import re
import time

import requests

from ingest import identity, rdap
from ingest.sources.base import USER_AGENT

CDX_URL = "https://web.archive.org/cdx/search/cdx"

CACHE_PATH = pathlib.Path(__file__).parent / "cache" / "wayback.json"

RETRY_NOT_ARCHIVED_AFTER = datetime.timedelta(days=30)

# The archive asks API users to keep well under a request a second; it answers a burst
# with 429s and then with nothing at all.
DELAY_SECONDS = 1.5
TIMEOUT_SECONDS = 30

VERIFIED = "verified"

CAPTURED = "captured"
NOT_ARCHIVED = "not-archived"
UNAVAILABLE = "unavailable"
TIMEOUT = "timeout"
ERROR = "error"
OUTCOMES = frozenset({CAPTURED, NOT_ARCHIVED, UNAVAILABLE, TIMEOUT, ERROR})


class RateLimited(Exception):
    """The archive said to slow down. The run stops rather than argue."""


def parse_first_capture(rows) -> tuple[str | None, str]:
    """A CDX JSON answer as (YYYY-MM-DD, outcome).

    The answer is a header row and then captures; an empty list or a lone header is
    the index saying it holds nothing. A timestamp that is not a date is an error, not
    an absence: a malformed answer is the archive's problem, not the company's.
    """
    if not isinstance(rows, list):
        return None, ERROR
    captures = [row for row in rows if isinstance(row, list) and row and row[0] != "timestamp"]
    if not captures:
        return None, NOT_ARCHIVED
    stamp = str(captures[0][0])
    if not re.fullmatch(r"\d{8,14}", stamp):
        return None, ERROR
    try:
        day = datetime.date(int(stamp[:4]), int(stamp[4:6]), int(stamp[6:8]))
    except ValueError:
        return None, ERROR
    return day.isoformat(), CAPTURED


_last_call = 0.0


def _query(domain: str, session: requests.Session | None = None) -> tuple[str | None, str]:
    """One polite question about one homepage: (date, outcome). Raises RateLimited on a 429."""
    global _last_call
    pause = DELAY_SECONDS - (time.monotonic() - _last_call)
    if pause > 0:
        time.sleep(pause)
    getter = session.get if session is not None else requests.get
    try:
        response = getter(
            CDX_URL,
            params={"url": domain, "output": "json", "limit": "1", "fl": "timestamp,statuscode"},
            headers={"User-Agent": USER_AGENT},
            timeout=TIMEOUT_SECONDS,
        )
    except requests.Timeout:
        return None, TIMEOUT
    except requests.RequestException as error:
        print(f"  wayback {domain}: {type(error).__name__}")
        return None, ERROR
    finally:
        _last_call = time.monotonic()
    if response.status_code == 429:
        raise RateLimited(domain)
    if response.status_code != 200:
        return None, UNAVAILABLE
    # An empty body is how the index says "nothing" when asked for JSON on some mirrors.
    if not response.text.strip():
        return None, NOT_ARCHIVED
    try:
        return parse_first_capture(response.json())
    except ValueError:
        return None, ERROR


def first_capture(website: str) -> tuple[str | None, str]:
    """The raw question, for a person at a prompt. lookup() is the one the pipeline runs."""
    domain = rdap.registrable(website)
    if domain is None or rdap.is_hosted(domain) or identity.is_profile(website):
        return None, ERROR
    try:
        return _query(domain)
    except RateLimited:
        return None, UNAVAILABLE


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
    """Never for a capture; after 30 days for an empty index; on the next run for a failed request."""
    if not isinstance(entry, dict):
        return True
    if entry.get("first_capture"):
        return False
    if entry.get("outcome") != NOT_ARCHIVED:
        return True
    try:
        checked = datetime.datetime.fromisoformat(entry["checked"])
    except (KeyError, TypeError, ValueError):
        return True
    if checked.tzinfo is None:
        checked = checked.replace(tzinfo=datetime.UTC)
    return now - checked >= RETRY_NOT_ARCHIVED_AFTER


# --- the run -----------------------------------------------------------------


def lookup(
    companies,
    max_seconds: float = 300,
    *,
    cache_path: pathlib.Path = CACHE_PATH,
    query=None,
    now=_now,
) -> dict[str, str]:
    """Company id to first-capture date, for every verified website the archive holds.

    The same gate as rdap.lookup and for the same reason: only a 'verified' address,
    so a stranger's page history never sits beside a company's name. Companies that
    share a domain share one question. Written to the cache as each answer arrives, so
    a run cut short keeps what it learned; nothing raises out of here.
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
            domain = rdap.registrable(website)
            if domain is None or rdap.is_hosted(domain) or identity.is_profile(website):
                continue
            by_domain.setdefault(domain, []).append(company.id)

        todo: list[str] = []
        for domain in sorted(by_domain):
            entry = cache.get(domain)
            if isinstance(entry, dict) and entry.get("first_capture"):
                for company_id in by_domain[domain]:
                    results[company_id] = entry["first_capture"]
            if needs_asking(entry, now()):
                todo.append(domain)
        # Never-asked domains first, then failed requests, then month-old empty answers.
        todo.sort(key=lambda d: (d in cache, (cache.get(d) or {}).get("outcome") == NOT_ARCHIVED))

        asked: dict[str, int] = {}
        for domain in todo:
            if time.monotonic() - started >= max_seconds:
                print(f"  wayback: stopped at the {max_seconds:.0f}s budget with {len(todo) - sum(asked.values())} domains left for the next run")
                break
            try:
                day, outcome = ask(domain)
            except RateLimited:
                print(f"  wayback: rate limited at {domain}; stopping, the rest wait for the next run")
                break
            except Exception as error:  # noqa: BLE001 - one domain, not the run
                print(f"  wayback {domain}: {type(error).__name__}: {str(error)[:120]}")
                day, outcome = None, ERROR
            if outcome not in OUTCOMES:
                day, outcome = None, ERROR
            asked[outcome] = asked.get(outcome, 0) + 1
            previous = cache.get(domain) if isinstance(cache.get(domain), dict) else {}
            # A failed request never overwrites an earlier "nothing archived": the older
            # answer is still the index's last word.
            if outcome in (UNAVAILABLE, TIMEOUT, ERROR) and previous.get("outcome") == NOT_ARCHIVED:
                previous = {**previous, "last_failure": outcome, "last_failure_at": now().isoformat(timespec="seconds")}
                cache[domain] = previous
            else:
                cache[domain] = {"first_capture": day, "outcome": outcome, "checked": now().isoformat(timespec="seconds")}
            try:
                save(cache, cache_path)
            except OSError as error:
                print(f"  wayback: could not write {cache_path}: {error}")
            if day:
                for company_id in by_domain[domain]:
                    results[company_id] = day
        if asked:
            print("  wayback: asked " + ", ".join(f"{n} {outcome}" for outcome, n in sorted(asked.items())))
    except Exception as error:  # noqa: BLE001 - a missing date must never fail the ingest
        print(f"  wayback: lookup stopped early: {type(error).__name__}: {str(error)[:120]}")
    return results
