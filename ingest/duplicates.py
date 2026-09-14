"""Which rows are one company listed twice, decided before anything is classified or sent.

A company's id is a slug of its name (sources/base.py), so any spelling difference
between two listings made two rows: "Call X Ringers Pvt Ltd" and "CallX Ringers",
"Cancrie Private Limited" and "Cancrie Inc.". Counted on 14 September 2026 in
docs/near-duplicates-2026-09-14.md: six pairs in 607 rows.

Two ways to be the same company, and no third:

1. The same name once spaces, punctuation and legal suffixes are gone. Automatic.
   On 14 September this found two pairs and nothing wrong.
2. A hand-read entry in ingest/aliases.json, with the reason written beside it. For
   typos, a brand beside a company name, and a word dropped between two lists — the
   cases a looser automatic rule could only catch alongside 200 false pairs.

A shared website is not on the list. The address two rows share is as often a
source giving one company's site to another (Arc Robotics and Driblet) as it is one
company twice, and whether an address is a company's own is only known after the
homepage has been read, which is after ids are fixed.

Costs nothing: the classification cache is keyed by name and description, not id.
"""

from __future__ import annotations

import json
import pathlib

from ingest.sources.base import Company, Signal, slugify

ALIASES_PATH = pathlib.Path(__file__).parent / "aliases.json"

# Stripped from the end of the key only, never from the id: adding "inc" to slugify
# would re-key every company whose name ends in it.
KEY_SUFFIXES = frozenset({"inc"})


def aliases() -> dict[str, str]:
    return {alias: entry["into"] for alias, entry in json.loads(ALIASES_PATH.read_text(encoding="utf-8")).items()}


def name_key(name: str) -> str:
    words = slugify(name).split("-")
    while len(words) > 1 and words[-1] in KEY_SUFFIXES:
        words.pop()
    return "".join(words)


def merges(companies: list[Company], hand: dict[str, str] | None = None) -> dict[str, str]:
    """Every duplicate id this run can see, mapped to the id that stays.

    By name, the smallest id in the group stays: an order that does not depend on
    which source was scraped first, so the surviving row cannot flip between runs.
    """
    out: dict[str, str] = {}
    groups: dict[str, set[str]] = {}
    for company in companies:
        groups.setdefault(name_key(company.name), set()).add(company.id)
    for ids in groups.values():
        keep = min(ids)
        out.update({cid: keep for cid in ids if cid != keep})

    out.update(aliases() if hand is None else hand)

    # Follow chains, so nothing is merged into a row that is itself going.
    def resolve(cid: str, seen: frozenset[str] = frozenset()) -> str:
        nxt = out.get(cid)
        return cid if nxt is None or nxt in seen else resolve(nxt, seen | {cid})

    return {cid: resolve(cid) for cid in out if resolve(cid) != cid}


def apply(by_source: dict[str, list[Company]], signals_by_source: dict[str, list[Signal]], mapping: dict[str, str]) -> None:
    """Send every copy under the id that stays. Changes the lists in place."""
    for companies in by_source.values():
        seen: set[str] = set()
        kept = []
        for company in companies:
            company.id = mapping.get(company.id, company.id)
            # One source listing a company twice (Venture Center, Call X Ringers) sends it once.
            if company.id in seen:
                continue
            seen.add(company.id)
            kept.append(company)
        companies[:] = kept
    for signals in signals_by_source.values():
        for signal in signals:
            signal.company_id = mapping.get(signal.company_id, signal.company_id)
