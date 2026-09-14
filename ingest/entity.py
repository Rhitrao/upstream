"""What kind of thing a record is, before anything calls it a company.

SINE IIT Bombay lists entrepreneurs-in-residence and NIDHI-PRAYAS innovators by their
own names — "Aishwarya Dasare", with a project description — and the pipeline filed
every one as a company. The classifier then wrote "the company extracts plant-based
protein", and the headline counted her. Nothing on record says a company exists.

    company            a registered entity: a legal suffix, or a DPIIT recognition,
                       which is only granted to incorporated companies, LLPs and
                       registered partnerships. A Startup India profile that DPIIT has
                       not recognised is not one: anyone can make a profile.
    researcher-project a person's name standing for a funded project
    lab                a university or institute laboratory (in the vocabulary; no
                       current source lists one)
    unverified         none of the above can be shown: a project or brand name with
                       no registered entity behind it on record

Deterministic, $0, and conservative in one direction only: a record is a company when
something says so, and otherwise it is not called one.
"""

from __future__ import annotations

import re

COMPANY = "company"
RESEARCHER_PROJECT = "researcher-project"
LAB = "lab"
UNVERIFIED = "unverified"

TYPES = (COMPANY, RESEARCHER_PROJECT, LAB, UNVERIFIED)

LEGAL_SUFFIX = re.compile(
    r"\b(?:pvt|private|ltd|limited|llp|inc|opc|corporation|corp|co)\b\.?|\bgmbh\b|\bplc\b",
    re.IGNORECASE,
)

# A name made of these is a business or a product, never a person.
NOT_A_PERSONAL_NAME = frozenset(
    """
    technologies technology tech labs lab systems solutions robotics energy power green
    bio biotech health healthcare medical devices innovations industries engineers
    engineering analytics ai aero aerospace nano materials foundation institute
    ventures motors agro foods farms air sense space works studio hub network
    """.split()
)

LAB_NAME = re.compile(r"\b(?:laboratory|lab of|department of|centre for|center for)\b", re.IGNORECASE)

# DPIIT's own eligibility rule, quoted where the classification rests on it.
DPIIT_NOTE = "DPIIT recognises only incorporated companies, LLPs and registered partnerships"
PROFILE_NOTE = "a Startup India profile DPIIT has not recognised, and no registered entity on record"


def looks_like_a_person(name: str) -> bool:
    """Two or three capitalised alphabetic words, none of them a business word.

    "Aishwarya Dasare" and "Hariharan Sekar" pass; "Plasmo-Sense", "GAZE" and
    "Tavisha Robotics" do not. Cheap, and wrong in both directions sometimes — which
    is why its answer is only ever "researcher-project", never "company".
    """
    words = name.split()
    if not 2 <= len(words) <= 3:
        return False
    for word in words:
        if not re.fullmatch(r"[A-Z][a-z]+", word):
            return False
        if word.lower() in NOT_A_PERSONAL_NAME:
            return False
    return True


# Register statuses that mean DPIIT recognised the company at some point.
WAS_RECOGNISED = frozenset({"recognised", "expired", "cancelled"})


def assess(name: str, sources, dpiit_status: str | None = None) -> tuple[str, str]:
    """The entity type for one record, and the reason in a phrase.

    `sources` is every source that listed it, and `dpiit_status` what the register's
    record says: a DPIIT recognition makes a company a company whichever source
    happened to reach it first, and a profile on the register without one does not.
    """
    if LEGAL_SUFFIX.search(name):
        return COMPANY, "a source lists it with a legal suffix"
    if "dpiit-startup-india" in set(sources or ()):
        if dpiit_status in WAS_RECOGNISED:
            return COMPANY, DPIIT_NOTE
        # Someone made a Startup India profile under this name. That is a startup
        # saying it exists, not a researcher's project, and not a registration either.
        if not LAB_NAME.search(name):
            return UNVERIFIED, PROFILE_NOTE
    if LAB_NAME.search(name):
        return LAB, "the name is a laboratory or department's"
    if looks_like_a_person(name):
        return RESEARCHER_PROJECT, "listed under a person's name for a funded project; no company is on record"
    return UNVERIFIED, "a project or brand name, with no registered entity on record"
