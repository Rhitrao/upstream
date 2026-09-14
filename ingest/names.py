"""A company's name as the page prints it.

The DPIIT register prints every name in capitals — "GIGATON RESEARCH PRIVATE LIMITED" —
and the incubators print theirs as the company writes them. In one list that made 175
of 607 rows shout. A name the source already cased is the company's own spelling and is
left alone; only a name with no lower-case letter at all is recased.

Recasing cannot know a brand's own capitals ("VigyanLLM"), so it only lowers what is
plainly a word: a token with no vowel, a short one with a digit, or a single letter is kept in capitals
("NCF", "2D", "A R"), as is a short list of abbreviations these names actually use.
"""

from __future__ import annotations

import re

KEEP_UPPER = frozenset("AI IT IOT EV EMS LLP OPC LLM UAV PCB DNA RNA IIT R&D AVP RAR UOC".split())
LOWER = frozenset("and of the for in".split())
# Legal abbreviations with no vowel to be told apart by.
TITLE = {"PVT": "Pvt", "LTD": "Ltd"}
VOWELS = set("AEIOU")


def _word(word: str, first: bool) -> str:
    core = word.strip("()[],.")
    if not core:
        return word
    if core in TITLE:
        cased = TITLE[core]
    elif core in KEEP_UPPER or len(core) == 1 or (len(core) <= 3 and any(ch.isdigit() for ch in core)) or (core.isalpha() and not VOWELS & set(core)):
        cased = core
    elif core.lower() in LOWER and not first:
        cased = core.lower()
    else:
        cased = "-".join(part[:1] + part[1:].lower() if part not in KEEP_UPPER else part for part in core.split("-"))
    return word.replace(core, cased, 1)


def display(name: str) -> str:
    if not name or re.search(r"[a-z]", name) or not re.search(r"[A-Z]", name):
        return name
    return " ".join(_word(w, i == 0) for i, w in enumerate(name.split()))
