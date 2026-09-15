"""Which public support programmes have selected a company, counted and never ranked.

A company incubated at SINE that also holds a DST NIDHI PRAYAS grant and DPIIT recognition has
been through three public programmes, each with its own selection. The count is the signal; an
order between them (is TDB above BIRAC?) would be a hierarchy nobody could defend, so there is
none. Two numbers, because two questions are honest:

    programmes      every public programme named: incubation at each incubator, DPIIT recognition,
                    BIRAC, DST (NIDHI and its seed and entrepreneur schemes), TDB, MeitY (TIDE,
                    SAMRIDH and its seed schemes), iDEX, EXIM Bank, the National Startup Awards.
    organisations   one per organisation that published its own decision about the company. SINE's
                    portfolio page listing a NIDHI PRAYAS grant is one organisation speaking, since
                    SINE runs that selection as the scheme's partner; BIRAC's own awardee list is
                    another.

Measured on the 395 described companies on 15 September 2026: 155 in two or more programmes, 35 in
three or more, and 59 of the 155 with no other public trace (no website of their own, no press);
40 with two or more publishing organisations. Programmes are not independent assessments, and the
page does not call them that.

Costs nothing: read from signals already collected.
"""

from __future__ import annotations

import re

INCUBATORS = {
    "sine-iitb": "SINE, IIT Bombay",
    "venture-center": "Venture Center, Pune",
    "tides-iitr": "TIDES, IIT Roorkee",
    "fsid-iisc": "FSID, IISc",
    "rtbi-iitm": "IIT Madras Incubation Cell",
    "nmicps-tih": "an NM-ICPS technology hub",
}

# Scheme names in a grant or award label, and the public body that runs them.
SCHEMES = (
    (re.compile(r"BIRAC|\bBIG\b"), "BIRAC"),
    (re.compile(r"NIDHI|\bDST\b"), "DST"),
    (re.compile(r"\bTDB\b"), "TDB"),
    (re.compile(r"MeitY|\bTIDE\b|SAMRIDH"), "MeitY"),
    (re.compile(r"iDEX"), "iDEX"),
    (re.compile(r"EXIM"), "EXIM Bank"),
)

# Evidence collectors whose whole list is one body's decisions.
EVIDENCE_BODIES = {"birac-big": "BIRAC", "tdb-agreements": "TDB", "idex": "iDEX", "nsa-dpiit": "National Startup Awards"}

RECOGNISED = frozenset({"recognised", "expired", "cancelled"})


def _get(signal, key):
    return signal.get(key) if isinstance(signal, dict) else getattr(signal, key, None)


def programmes(signals, dpiit_status: str | None) -> list[str]:
    """Every public programme the signals name, in a stable order."""
    found: set[str] = set()
    if dpiit_status in RECOGNISED:
        found.add("DPIIT recognition")
    for signal in signals:
        kind, label, source = _get(signal, "type"), _get(signal, "label") or "", _get(signal, "source")
        if kind == "incubator" and source in INCUBATORS:
            found.add(f"incubation at {INCUBATORS[source]}")
        if kind in ("grant", "award"):
            for pattern, body in SCHEMES:
                if pattern.search(label):
                    found.add(body)
            if source == "sine-iitb":
                # SINE lists its own grantees: being on that page is also being in its programme.
                found.add(f"incubation at {INCUBATORS['sine-iitb']}")
        if source in EVIDENCE_BODIES:
            found.add(EVIDENCE_BODIES[source])
    return sorted(found)


def organisations(signals, dpiit_status: str | None) -> list[str]:
    """One per organisation that published its own decision about the company."""
    found: set[str] = set()
    if dpiit_status in RECOGNISED:
        found.add("DPIIT")
    for signal in signals:
        kind, label, source = _get(signal, "type"), _get(signal, "label") or "", _get(signal, "source")
        if kind in ("website", "press"):
            continue
        if source in INCUBATORS:
            found.add(INCUBATORS[source])
        elif source == "grants-csv":
            found.add("BIRAC" if "BIRAC" in label else "DST" if re.search(r"NIDHI|\bDST\b", label) else label)
        elif source in EVIDENCE_BODIES:
            found.add(EVIDENCE_BODIES[source])
    return sorted(found)


def other_traces(signals) -> int:
    """Public traces that are not a programme's own list: a website of their own, press."""
    return sum(1 for signal in signals if _get(signal, "type") in ("website", "press"))
