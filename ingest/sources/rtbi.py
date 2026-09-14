"""RTBI, IIT Madras — https://rtbi.in/incubationiitm/portfolio.html

A legacy Google Sites page: every company is a `sites-embed` block with the name in an
h4 and everything else as prose in one textbox. So the parse is deliberately narrow —
the name from the heading, the pitch from the sentence after "What it offers?", and
the website from the logo link — rather than trying to read founders and funding out
of free text that was written for people.

The page carries no cohort or year, so the signal is the membership alone. It is also
plainly not maintained (the newest entries are years old), which the tier rules handle
on their own: a company here with a website and press is a company people know.

Run it: python3 -m ingest.sources.rtbi
"""

from __future__ import annotations

import re

from bs4 import BeautifulSoup

from ingest.identity import names_company
from ingest.sources.base import Company, Signal, clean, fetch, founder_line, preview

SOURCE = "rtbi-iitm"
URL = "https://rtbi.in/incubationiitm/portfolio.html"
LABEL = "IITM RTBI portfolio"

# Social links are the company's, but they are not its website, and on this page they
# outnumber it.
SOCIAL = re.compile(r"(?:twitter|x|facebook|instagram|youtube|crunchbase)\.com|linkedin", re.IGNORECASE)

# The prose is a fixed sequence of headings. Everything before the pitch is founders
# and handles; everything after is funding history we are not trying to read.
PITCH = re.compile(r"What it offers\?\s*(.+)", re.IGNORECASE | re.DOTALL)
AFTER_PITCH = re.compile(r"\s*(?:Visit us online|Funds? raised|Awards?|Recognitions?|Clients?)\b", re.IGNORECASE)


def scrape() -> tuple[list[Company], list[Signal]]:
    soup = BeautifulSoup(fetch(URL), "html.parser")
    blocks = soup.select("div.sites-embed")
    if not blocks:
        raise ValueError(f"no portfolio blocks at {URL} — the page shape changed")

    companies: dict[str, Company] = {}
    signals: list[Signal] = []

    for block in blocks:
        heading = block.select_one("h4.sites-embed-title")
        textbox = block.select_one("div.sites-embed-content-textbox")
        # The page's navigation sidebar is a sites-embed too, and it has neither.
        if heading is None or textbox is None:
            continue

        name = clean(heading.get_text(" "))
        if not name:
            continue

        founders = _founders(textbox.get_text(" "))
        company = Company.named(
            name,
            description=_pitch(textbox.get_text(" ")),
            website=_website(textbox, name),
            founders=founders,
            founders_source=SOURCE if founders else None,
        )
        if company.id in companies:
            continue

        companies[company.id] = company
        signals.append(Signal(company_id=company.id, type="incubator", label=LABEL, url=URL, source=SOURCE))

    return list(companies.values()), signals


FOUNDERS = re.compile(r"Founders?\s*:\s*(.+?)(?=@|\bDomains?\s*:|What it offers|$)", re.IGNORECASE | re.DOTALL)


def _founders(text: str) -> str | None:
    """The "Founder:" line, stopped before the handles and headings that follow it."""
    match = FOUNDERS.search(clean(text) or "")
    return founder_line(match.group(1).rstrip(" ,;|")) if match else None


def _pitch(text: str) -> str | None:
    """The "What it offers?" sentence — the only part of the prose worth classifying."""
    body = clean(text)
    if body is None:
        return None
    match = PITCH.search(body)
    if match:
        body = match.group(1)
    return clean(AFTER_PITCH.split(body, maxsplit=1)[0])


def _website(textbox, name: str) -> str | None:
    """The link in this card that is the company's own, or None.

    It used to be the first outbound link, on the grounds that the logo comes first.
    The page disproves that: its editor left about a hundred empty
    `<a href="http://hyperverge.co/"></a>` tags scattered through other companies'
    cards — no text, no image, nothing a visitor could click — and "first link" gave
    Grinntech, an EV battery maker, the website of an identity-verification company.

    So a link has to be something a reader could see, and the order is: one whose
    domain carries the company's name, then the logo, then the first visible link
    that is not a profile on some other platform. Whether that address really is
    theirs is decided later, in identity.py; this only has to not invent the link.
    """
    visible = []
    for anchor in textbox.find_all("a", href=True):
        href = clean(anchor["href"])
        # Some logos link to a relative image path instead of the company, so the
        # scheme check is doing real work here, not being defensive for its own sake.
        if not href or not href.lower().startswith(("http://", "https://")) or SOCIAL.search(href):
            continue
        if not (anchor.get_text(strip=True) or anchor.find("img")):
            continue
        visible.append((href, anchor.find("img") is not None))

    for href, _ in visible:
        if names_company(name, href, None) == "domain":
            return href
    for href, is_logo in visible:
        if is_logo:
            return href
    return visible[0][0] if visible else None

if __name__ == "__main__":
    print(preview(*scrape()))
