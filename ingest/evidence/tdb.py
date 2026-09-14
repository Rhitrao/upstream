"""Technology Development Board — funding agreements, one page per financial year.

    https://tdb.gov.in/funded-agreements  →  /agreement-2022-2023, /Agreements-2025-26, …

Each year page holds one table: serial number, project title, company (with its town),
TDB commitment in crore rupees, total project cost. Some years (2018-19 to 2020-21)
put the whole sentence in the title cell and leave the others empty — "#TDB support #
M/s SureWaves MediaTech Pvt. Ltd., Bangalore for “Development and Commercialization of
SkyNet…”" — and the company, town and project are read out of that one cell.

tdb.gov.in answers /robots.txt with 403, so there is no file saying anything is
disallowed; pages are fetched through base.fetch, one a second, cached for 30 days.

Dates. A financial year is not a date, so `date` is None — except where a row itself
says when the agreement was signed ("entered into a grant agreement on 4th May, 2017").
Nothing on these pages says when they were published: `published` is None.

TDB funds established manufacturers as well as startups. That is the integrator's
problem, not this file's: an agreement with a company we do not hold matches nothing.

    python3 -m ingest.evidence.tdb
"""

from __future__ import annotations

import re
import urllib.parse

from bs4 import BeautifulSoup

from ingest.evidence import Award, city_from, clean, is_company, written_date
from ingest.sources.base import fetch

SOURCE = "tdb-agreements"
INDEX = "https://tdb.gov.in/funded-agreements"

FY_IN_PATH = re.compile(r"agreements?-(\d{4})-(\d{2,4})$", re.IGNORECASE)
COMPANY_SUFFIX = re.compile(
    r"^(?P<name>.*?\b(?:Private\s+Limited|Pvt\.?\s*Ltd\.?|\(P\)\s*Ltd\.?|\(I\)\s*Pvt\.?\s*Ltd\.?|Limited|Ltd\.?|LLP))"
    r"(?P<rest>.*)$",
    re.IGNORECASE,
)
MS = re.compile(r"^\s*M/s\.?\s*", re.IGNORECASE)
AMOUNT = re.compile(r"(\d+(?:\.\d+)?)")


def collect() -> list[Award]:
    pages = year_pages(fetch(INDEX))
    if not pages:
        raise ValueError(f"no financial-year pages linked from {INDEX} — the page shape changed")
    awards: list[Award] = []
    for url, fy in pages:
        awards.extend(parse_year(fetch(url), url, fy))
    return awards


def year_pages(html: str) -> list[tuple[str, str]]:
    """(url, "2022-23") for every financial-year page the index links to."""
    soup = BeautifulSoup(html, "html.parser")
    out: list[tuple[str, str]] = []
    for anchor in soup.find_all("a", href=True):
        path = urllib.parse.urlsplit(urllib.parse.urljoin(INDEX, anchor["href"])).path.rstrip("/")
        match = FY_IN_PATH.search(path)
        if not match:
            continue
        start, end = match.group(1), match.group(2)[-2:]
        url = urllib.parse.urljoin(INDEX, path)
        if url not in [u for u, _ in out]:
            out.append((url, f"{start}-{end}"))
    return out


def parse_year(html: str, url: str, fy: str) -> list[Award]:
    soup = BeautifulSoup(html, "html.parser")
    awards: list[Award] = []
    for table in soup.find_all("table"):
        header = [(clean(c.get_text(" ")) or "").lower() for c in table.find("tr").find_all(["th", "td"])] if table.find("tr") else []
        if not any("title" in h for h in header) or not any("company" in h for h in header):
            continue
        column = {key: next((i for i, h in enumerate(header) if key in h), None)
                  for key in ("title", "company", "commitment", "cost")}
        for tr in table.find_all("tr")[1:]:
            cells = [clean(td.get_text(" ")) for td in tr.find_all(["td", "th"])]
            award = _row(cells, column, url, fy)
            if award is not None:
                awards.append(award)
    if not awards:
        raise ValueError(f"no agreements in the table at {url} — the page shape changed")
    return awards


def _cell(cells: list[str | None], index: int | None) -> str | None:
    return cells[index] if index is not None and index < len(cells) else None


def _row(cells, column, url, fy) -> Award | None:
    title = _cell(cells, column["title"])
    company_cell = _cell(cells, column["company"])
    commitment = _cell(cells, column["commitment"])
    if not title and not company_cell:
        return None

    project = project_title(title)
    if company_cell:
        name, city = split_company(company_cell)
    else:
        name, city, _ = from_sentence(title or "")
    if not name:
        return None

    amount = None
    if commitment:
        match = AMOUNT.search(commitment)
        amount = match.group(1) if match else None

    label = f"TDB funding agreement, FY {fy}"
    if project:
        label += f": {project}"
    if amount:
        label += f" (₹{amount} cr)"
    return Award(
        name=name,
        type="grant",
        label=label,
        date=written_date(title or ""),
        published=None,
        url=url,
        source=SOURCE,
        city=city,
        is_company=is_company(name),
    )


def split_company(cell: str) -> tuple[str | None, str | None]:
    """"M/s WellRx Technologies Pvt. Ltd. Rewari, (Haryana)" → ("WellRx Technologies Pvt.
    Ltd.", "Rewari"). The name runs to its legal suffix; what follows is the place. With
    no suffix to find, the first comma divides them."""
    text = MS.sub("", clean(cell) or "")
    match = COMPANY_SUFFIX.match(text)
    if match:
        name, rest = match.group("name"), match.group("rest")
    elif "," in text:
        name, rest = text.split(",", 1)
    else:
        name, rest = text, ""
    name = clean(name.strip(" ,"))
    rest = re.sub(r"(?:signed|\s(?:for|has|to|entered))\b.*$", "", rest).strip(" ,.")
    return name, city_from(rest) if rest else None


SENTENCE = re.compile(r"(?:M/s\.?\s*|supports\s+)(?P<company>.+?)(?P<tail>(?:\s+for\b|\s*[“‘\"]|signed\b|\s+to\b).*|)$",
                      re.IGNORECASE)
QUOTED = re.compile(r"[“‘\"](?P<text>[^”’\"]{4,})[”’\"]?")


def from_sentence(title: str) -> tuple[str | None, str | None, str | None]:
    """Company, city and project out of a row that is one sentence: "#TDB support # M/s
    SureWaves MediaTech Pvt. Ltd., Bangalore for “Development of SkyNet…”"."""
    match = SENTENCE.search(title)
    if not match:
        return None, None, None
    name, city = split_company(match.group("company"))
    return name, city, project_title(title)


def project_title(title: str | None) -> str | None:
    """The project a title cell names.

    A plain title is the project. A title that is a sentence about the agreement
    ("TDB financially supports M/s IMCO Alloys Private Limited for “Development and
    Commercialization of…”") gives the quoted part, or what follows "for"; a sentence
    naming no project gives None rather than itself.
    """
    text = clean(title)
    if not text:
        return None
    if not re.search(r"M/s|\bTDB\b|Technology Development Board", text, re.IGNORECASE):
        return clean(text.strip(" .\"“”‘’")) or None
    quoted = QUOTED.search(text)
    if quoted:
        return clean(quoted.group("text").strip(" .")) or None
    after_for = re.search(r"\bfor\s+(?:financial assistance for\s+)?(?:the project\s*[–-]\s*)?(.+)$", text, re.IGNORECASE)
    if after_for and not re.search(r"M/s", after_for.group(1)):
        return clean(after_for.group(1).strip(" .")) or None
    return None


if __name__ == "__main__":
    found = collect()
    print(f"{len(found)} agreements")
    for award in found[:10]:
        print(" ", award)
