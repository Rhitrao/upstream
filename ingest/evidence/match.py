"""Which awards belong to a company we already hold. Exact, or not at all.

    match(awards, held) -> [(award, company_id), ...]

`held` is [(company_id, name, dpiit_number or None), ...]. Two ways to match, and no
third:

1. The same DPIIT number, when both the award and the held company carry one. A
   number both sides print is the strongest identity either has; when it disagrees,
   the names are not consulted at all — two different registrations are two companies.
2. Otherwise, the same duplicates.name_key: the name once spaces, punctuation and
   legal suffixes are gone ("SNL Innovations Pvt Ltd" and "Snl Innovations Private
   Limited").

Never fuzzy. A near-miss on a list of awards is how a grant to "Aerospace Engineers"
lands on "Aero Space Engineering"; a missed match costs one dated event, a wrong one
puts somebody else's grant on a company's page. An award whose key is shared by two
held companies matches neither — which one it is cannot be decided from a name.
An award that matches nothing is dropped by the caller; nothing here creates a company.
"""

from __future__ import annotations

import re
from collections.abc import Iterable

from ingest.duplicates import name_key
from ingest.evidence import Award


def dpiit_key(number: str | None) -> str | None:
    """"DIPP 49386" and "dipp49386" are one number."""
    if not number:
        return None
    digits = re.sub(r"\D", "", number)
    return f"DIPP{int(digits)}" if digits else None


def match(awards: Iterable[Award], held: Iterable[tuple[str, str, str | None]]) -> list[tuple[Award, str]]:
    by_dpiit: dict[str, set[str]] = {}
    by_name: dict[str, set[str]] = {}
    dpiit_of: dict[str, str] = {}
    for company_id, name, dpiit in held:
        number = dpiit_key(dpiit)
        if number:
            by_dpiit.setdefault(number, set()).add(company_id)
            dpiit_of[company_id] = number
        key = name_key(name) if name else ""
        if key:
            by_name.setdefault(key, set()).add(company_id)

    out: list[tuple[Award, str]] = []
    for award in awards:
        number = dpiit_key(award.dpiit_number)
        if number and number in by_dpiit:
            ids = by_dpiit[number]
            if len(ids) == 1:
                out.append((award, next(iter(ids))))
            continue
        ids = by_name.get(name_key(award.name), set()) if award.name else set()
        if number:
            # The award has a number and so does a same-named company, and they differ.
            ids = {cid for cid in ids if dpiit_of.get(cid) in (None, number)}
        if len(ids) == 1:
            out.append((award, next(iter(ids))))
    return out
