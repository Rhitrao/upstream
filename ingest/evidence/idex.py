"""iDEX (Innovations for Defence Excellence) — its winners, from two places on idex.gov.in.

1. The home page's map of States/UTs. Each state's slide has a "Startups /MSMEs"
   carousel: a logo per company, its name in the image title, its website on the link.
   The state is the slide's own heading.
2. The coffee-table book "A Runway for INNOVATIONS", linked from /publications. Its
   "iDEX Winners – Success Stories" pages give one winner each: challenge category
   ("DISC - 7", "Open Challenge - 4.0"), challenge title, and the company's name — set
   sideways down the page margin, so it is read from the rotated characters, bottom to
   top, column by column.

One record per company. A company in the book gets the book's line, "iDEX DISC 7
winner: Underwater Navigation System for AUVs", with the book as its url; a company
only on the map gets "iDEX-supported startup (Tamil Nadu)". The two are joined on the
exact name key — the same comparison match.py makes — and never by position.

Dates. Neither place says when anything was awarded; a DISC round's launch year is not
an award date, so `date` is None. The book's card on /publications is dated ("Oct 31,
2025"), which is the book's `published`. The home page carries no date.

idex.gov.in serves no robots.txt (404). Pages go through base.fetch, the PDF through
fetch_bytes: one request a second, cached for 30 days.

    python3 -m ingest.evidence.idex
"""

from __future__ import annotations

import io
import re
import urllib.parse

from bs4 import BeautifulSoup

from ingest.duplicates import name_key
from ingest.evidence import Award, clean, fetch_bytes, is_company, written_date
from ingest.sources.base import fetch

SOURCE = "idex"
HOME = "https://idex.gov.in/"
PUBLICATIONS = "https://idex.gov.in/publications"
BOOK_TITLE = re.compile(r"coffee\s+table\s+book.*runway\s+for\s+innovations", re.IGNORECASE)

CATEGORY = re.compile(r"Challenge Category:\s*(?P<category>.+?)\s*Challenge Title:\s*(?P<title>.+?)\s*Sector of Innovation",
                      re.IGNORECASE | re.DOTALL)


def collect() -> list[Award]:
    grid = home_grid(fetch(HOME))
    if not grid:
        raise ValueError(f"no Startups/MSMEs on {HOME} — the page shape changed")
    book_url, published = book_link(fetch(PUBLICATIONS))
    if book_url is None:
        raise ValueError(f"no coffee-table book linked from {PUBLICATIONS} — the page shape changed")
    winners = book_winners(book_pages(fetch_bytes(book_url)))
    if not winners:
        raise ValueError(f"no winner pages read from {book_url} — the document shape changed")
    return combine(grid, winners, book_url, published)


# ---------------------------------------------------------------------------------------
# The home page


def home_grid(html: str) -> list[dict]:
    """[{"name", "state", "website"}] from every state's Startups/MSMEs carousel."""
    soup = BeautifulSoup(html, "html.parser")
    rows: list[dict] = []
    for heading in soup.find_all("h5"):
        if not re.fullmatch(r"startups\s*/\s*msmes", clean(heading.get_text(" ")) or "", re.IGNORECASE):
            continue
        section = heading.find_parent("div", class_="mapLeftSection")
        slide = heading.find_parent("div", class_="item")
        state_tag = slide.find("h4") if slide else None
        state = clean(state_tag.get_text(" ")) if state_tag else None
        if section is None:
            continue
        for img in section.find_all("img", title=True):
            name = clean(img.get("title")) or clean(img.get("alt"))
            if not name:
                continue
            link = img.find_parent("a", href=True)
            rows.append({"name": name, "state": _state_name(state), "website": clean(link["href"]) if link else None})
    return rows


def _state_name(state: str | None) -> str | None:
    """"TAMIL NADU" → "Tamil Nadu"; the page writes states in capitals."""
    if not state:
        return None
    return " ".join(w if w.lower() in {"and"} else w.capitalize() for w in state.lower().split())


# ---------------------------------------------------------------------------------------
# The book


def book_link(html: str) -> tuple[str | None, str | None]:
    """The coffee-table book's PDF and the date its card gives, from /publications."""
    soup = BeautifulSoup(html, "html.parser")
    for title in soup.find_all("h2"):
        if not BOOK_TITLE.search(clean(title.get_text(" ")) or ""):
            continue
        card = title.find_parent("div", class_="row") or title.parent
        link = card.find("a", href=re.compile(r"\.pdf$", re.IGNORECASE))
        dated = card.find("h4")
        if link:
            url = urllib.parse.urljoin(PUBLICATIONS, link["href"])
            return url, written_date(dated.get_text(" ")) if dated else None
    return None, None


def book_pages(data: bytes) -> list[dict]:
    """Each page's upright text and its rotated characters, the parser's only input."""
    import pdfplumber

    pages = []
    with pdfplumber.open(io.BytesIO(data)) as pdf:
        for number, page in enumerate(pdf.pages, start=1):
            text = page.extract_text() or ""
            if "Challenge Category" not in text:
                continue
            rotated = [[round(c["x0"], 1), round(c["top"], 1), round(c["bottom"], 1), c["text"]]
                       for c in page.chars if not c.get("upright", True)]
            pages.append({"page": number, "text": text, "rotated": rotated})
    return pages


def book_winners(pages: list[dict]) -> list[dict]:
    winners = []
    for page in pages:
        winner = book_page(page["text"], page["rotated"])
        if winner:
            winners.append(winner)
    return winners


def book_page(text: str, rotated: list[list]) -> dict | None:
    """{"name", "category", "title"} from one success-story page, or None.

    Everything is read from this page alone: the category and title from its text, the
    name from its own sideways characters.
    """
    match = CATEGORY.search(text)
    name = sideways_name(rotated)
    if not match or not name:
        return None
    return {
        "name": name,
        "category": _category(match.group("category")),
        "title": clean(match.group("title")),
    }


def sideways_name(rotated: list[list]) -> str | None:
    """Characters set rotated 90° in the left margin, read as the book prints them:
    columns left to right, each column bottom to top, with a space wherever the gap
    between two characters is wider than a letter's spacing."""
    margin = [c for c in rotated if c[0] < 120]
    columns: dict[int, list[list]] = {}
    for char in margin:
        columns.setdefault(round(char[0] / 6), []).append(char)
    parts = []
    for key in sorted(columns):
        chars = sorted(columns[key], key=lambda c: -c[1])
        piece, previous = "", None
        for x0, top, bottom, ch in chars:
            if previous is not None and previous[1] - bottom > 1.5:
                piece += " "
            piece += ch
            previous = (x0, top, bottom)
        parts.append(piece)
    return clean(" ".join(parts))


def _category(text: str) -> str | None:
    """"DISC - 7" → "DISC 7"; "Open Challenge - 4.0" → "Open Challenge 4.0"."""
    value = clean(re.sub(r"\s*[-–]\s*", " ", text))
    return value or None


# ---------------------------------------------------------------------------------------


def combine(grid: list[dict], winners: list[dict], book_url: str, published: str | None) -> list[Award]:
    awards: list[Award] = []
    seen: set[str] = set()
    for winner in winners:
        key = name_key(winner["name"])
        if key in seen:
            continue
        seen.add(key)
        label = f"iDEX {winner['category']} winner" if winner["category"] else "iDEX winner"
        if winner["title"]:
            label += f": {winner['title']}"
        awards.append(Award(name=winner["name"], type="award", label=label, date=None, published=published,
                            url=book_url, source=SOURCE, is_company=is_company(winner["name"])))
    for row in grid:
        key = name_key(row["name"])
        if key in seen:
            continue
        seen.add(key)
        label = f"iDEX-supported startup ({row['state']})" if row["state"] else "iDEX-supported startup"
        awards.append(Award(name=row["name"], type="award", label=label, date=None, published=None,
                            url=HOME, source=SOURCE, is_company=is_company(row["name"])))
    return awards


if __name__ == "__main__":
    found = collect()
    print(f"{len(found)} iDEX records")
    for award in found[:10]:
        print(" ", award)
