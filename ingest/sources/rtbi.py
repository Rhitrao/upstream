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

from ingest.sources.base import Company, Signal, clean, fetch, preview

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

        company = Company.named(
            name,
            description=_pitch(textbox.get_text(" ")),
            website=_website(textbox),
        )
        if company.id in companies:
            continue

        companies[company.id] = company
        signals.append(Signal(company_id=company.id, type="incubator", label=LABEL, url=URL, source=SOURCE))

    return list(companies.values()), signals


def _pitch(text: str) -> str | None:
    """The "What it offers?" sentence — the only part of the prose worth classifying."""
    body = clean(text)
    if body is None:
        return None
    match = PITCH.search(body)
    if match:
        body = match.group(1)
    return clean(AFTER_PITCH.split(body, maxsplit=1)[0])


def _website(textbox) -> str | None:
    """The first real outbound link, which on every block is the logo.

    Some logos link to a relative image path instead of the company, so the scheme
    check is doing real work here, not being defensive for its own sake.
    """
    for anchor in textbox.find_all("a", href=True):
        href = clean(anchor["href"])
        if href and href.lower().startswith(("http://", "https://")) and not SOCIAL.search(href):
            return href
    return None


if __name__ == "__main__":
    print(preview(*scrape()))
