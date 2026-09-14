"""BIRAC Biotechnology Ignition Grant (BIG) — awardee lists for rounds 15 to 20 and the
North-East special call, from the PDFs linked on https://birac.nic.in/big.php.

Rounds 21 to 24 are already typed into ingest/sources/grants.csv and are not collected
here; `grants_csv_gap()` reads those four PDFs only to count the awardees that file is
missing. birac.nic.in answers /robots.txt with an "Unauthorised Access" page, not a
robots file, so nothing is disallowed; PDFs are fetched one a second and cached.

Each PDF is a printed table: serial number, proposal reference ("BIRAC/IKP01465/BIG-18/21"),
applicant name, and from round 18 a final score, grouped under category headings. A
name that wraps is vertically centred in its cell, so its first line often prints
above the reference and its last line below. Text extraction scrambles that, and the
table extractor duplicates cells, so the parser works on word positions instead:

- every reference code is one record's anchor (a code that wraps onto a second line,
  "BIRAC/FITT01189/BIG-" then "21/22", is one anchor spanning both);
- the lines of words in the applicant-name column, top to bottom, are split into one
  run of consecutive lines per anchor, choosing the split that best lines each run up
  with its anchor — centred on it, or starting level with it, whichever that row does
  (both occur in one PDF). A line that fits no row is left out rather than forced.

So a name is read only from its own row band, and never paired with a name list
collected elsewhere.

Dates. The lists carry no award or sanction date — only BIG 15's header "Date: 3rd Feb.
2020", which is the letter's date and does not say it is the date of the result, so it
is not used. `date` is None throughout. `published` is the upload day in the file
name's epoch prefix ("1630669396_…" → 2021-09-03); BIG 17's file has none.

    python3 -m ingest.evidence.birac_big
"""

from __future__ import annotations

import csv
import io
import pathlib
import re
import urllib.parse

from bs4 import BeautifulSoup

from ingest.duplicates import name_key
from ingest.entity import LEGAL_SUFFIX
from ingest.evidence import Award, clean, fetch_bytes, is_company, upload_date
from ingest.sources.base import fetch

SOURCE = "birac-big"
PAGE = "https://birac.nic.in/big.php"
WANTED = {"15", "16", "17", "18", "19", "20", "NER"}
IN_GRANTS_CSV = {"21", "22", "23", "24"}
GRANTS_CSV = pathlib.Path(__file__).resolve().parent.parent / "sources" / "grants.csv"

REFERENCE = re.compile(r"^BIRAC/[A-Z]+\d+/")
REFERENCE_TAIL = re.compile(r"^\d{2}/\d{2}$")
ROUND = re.compile(r"Final\s+list\s+of\s+BIG\s*[- ]?\s*(\d+|NER\b[^*\n]*?)\s*Awardees", re.IGNORECASE)
NOT_A_NAME = re.compile(
    r"^(?:final\s+list|categor|theme|s\.?\s*no|proposal|applicant|grantee|final\b|scores?\b|no\.$|"
    r"reference|\*|date:|`)",
    re.IGNORECASE,
)


def collect() -> list[Award]:
    awards: list[Award] = []
    links = pdf_links(fetch(PAGE))
    if not links:
        raise ValueError(f"no BIG awardee PDFs linked from {PAGE} — the page shape changed")
    rounds_seen = set()
    for url in links:
        pages = pdf_words(fetch_bytes(url))
        big_round = round_of(pages)
        if big_round is None or big_round not in WANTED:
            continue
        rounds_seen.add(big_round)
        awards.extend(parse(pages, url, big_round))
    missing = WANTED - rounds_seen
    if missing:
        raise ValueError(f"BIG rounds {sorted(missing)} not found among the PDFs on {PAGE} — the page shape changed")
    return awards


def pdf_links(html: str) -> list[str]:
    """The awardee-list PDFs linked from big.php, in page order."""
    soup = BeautifulSoup(html, "html.parser")
    out: list[str] = []
    for anchor in soup.find_all("a", href=True):
        href = anchor["href"]
        low = href.lower()
        if not low.endswith(".pdf") or "big" not in low or not re.search(r"awardee|final_list", low):
            continue
        url = urllib.parse.urljoin(PAGE, href)
        if url not in out:
            out.append(url)
    return out


def pdf_words(data: bytes) -> list[list[dict]]:
    """Every page's words with their positions: the parser's only input."""
    import pdfplumber  # imported here so the HTML collectors never need it

    pages = []
    with pdfplumber.open(io.BytesIO(data)) as pdf:
        for page in pdf.pages:
            pages.append([
                {"text": w["text"], "x0": round(w["x0"], 1), "x1": round(w["x1"], 1),
                 "top": round(w["top"], 1), "bottom": round(w["bottom"], 1)}
                for w in page.extract_words(keep_blank_chars=False, use_text_flow=False)
            ])
    return pages


def round_of(pages: list[list[dict]]) -> str | None:
    """"18", or "NER" for the North-East special call, from the PDF's own title."""
    first = " ".join(w["text"] for w in (pages[0] if pages else []))
    match = ROUND.search(first)
    if not match:
        return None
    value = match.group(1).strip()
    return "NER" if value.upper().startswith("NER") else value


def parse(pages: list[list[dict]], url: str, big_round: str) -> list[Award]:
    published = upload_date(url)
    label = "BIRAC BIG North-East Region special call awardee" if big_round == "NER" else f"BIRAC BIG round {big_round} awardee"
    awards = []
    for name in awardee_names(pages):
        awards.append(Award(
            name=name,
            type="grant",
            label=label,
            date=None,
            published=published,
            url=url,
            source=SOURCE,
            is_company=is_company(name),
        ))
    if not awards:
        raise ValueError(f"no awardees read from {url} — the document shape changed")
    return awards


def awardee_names(pages: list[list[dict]]) -> list[str]:
    names: list[str] = []
    name_x = score_x = None
    for words in pages:
        # The name column starts at the "Applicant"/"Grantee" header; the score column,
        # where there is one, at "Final". A page without a header keeps the last page's.
        for w in words:
            if w["text"].lower() in {"applicant", "grantee"}:
                name_x = w["x0"]
            if w["text"].lower() == "final" and name_x is not None and w["x0"] > name_x + 20:
                score_x = w["x0"]
        if name_x is None:
            continue

        words = _without_furniture(words)
        anchors = _anchors(words)
        if not anchors:
            continue
        ref_right = max(a["x1"] for a in anchors)
        column = [w for w in words
                  if w["x0"] > ref_right - 1
                  and (score_x is None or w["x1"] <= score_x + 2)
                  and not REFERENCE.match(w["text"]) and not REFERENCE_TAIL.match(w["text"])
                  and not re.fullmatch(r"\d+(?:\.\d+)?", w["text"])]
        lines = []
        for line in _lines(column):
            text = clean(" ".join(w["text"] for w in line))
            if text and not NOT_A_NAME.match(text):
                lines.append({"text": text, "top": min(w["top"] for w in line),
                              "bottom": max(w["bottom"] for w in line)})
        for group in _partition(lines, anchors):
            text = clean(" ".join(line["text"] for line in group))
            if text:
                names.append(_dedupe_repeat(text))
    return names


FURNITURE = re.compile(
    r"^(?:`?\s*date:|final\s+list|categor|theme|\*|s\.?\s*no\b|s\.$|no\.$|proposal|applicant|grantee|"
    r"final(?:\s+scores?)?$|scores?$)",
    re.IGNORECASE,
)
HEADING = re.compile(r"^(?:categor|theme)", re.IGNORECASE)


def _without_furniture(words: list[dict]) -> list[dict]:
    """The page with its title, category headings, table headers and footnote removed.

    Judged on whole printed lines, left margin to right, so the tail of a footnote
    ("…further due diligence") that happens to sit over the name column goes with the
    "*" that starts it. A category heading that wraps leaves its second line ("and
    Diagnostics") between the heading and the table header below it; lines there go
    too. So does anything above a page's first table header when no reference code
    comes before it — the document title.
    """
    lines = _lines(words)
    texts = [clean(" ".join(w["text"] for w in line)) or "" for line in lines]
    furniture = [bool(FURNITURE.match(t)) or "due diligence" in t.lower() for t in texts]
    headers = [i for i, t in enumerate(texts) if re.search(r"\b(?:applicant|grantee)\b", t, re.IGNORECASE)]
    has_reference = [any(REFERENCE.match(w["text"]) for w in line) for line in lines]
    for i in range(len(lines)):
        if furniture[i] or has_reference[i]:
            continue
        below = next((k for k in range(i + 1, len(lines)) if k in headers or has_reference[k]), None)
        if below is None or below not in headers:
            continue
        above = [k for k in range(i) if has_reference[k] or (furniture[k] and HEADING.match(texts[k]))]
        if not above or not has_reference[above[-1]]:
            furniture[i] = True
    return [w for line, drop in zip(lines, furniture) if not drop for w in line]


CONTINUES = re.compile(r"^(?:private|limited|pvt\.?|ltd\.?|llp|\(opc\))(?:\s|$)", re.IGNORECASE)
UNFINISHED = re.compile(r"(?:\b(?:private|pvt\.?|and|of|&)|-)$", re.IGNORECASE)
BROKEN_COST = 50.0
SKIP_COST = 25.0  # points: leaving a line out costs about two rows' misalignment
EMPTY_COST = 200.0  # an anchor with no name at all is almost never right


def _partition(lines: list[dict], anchors: list[dict]) -> list[list[dict]]:
    """Consecutive runs of name lines, one per anchor, in order, by least misalignment.

    A run's cost against its anchor is the smaller of the distance between their
    centres and the distance between their tops, plus, for each line, how much nearer
    it sits to some other anchor than to its own. Solved exactly by dynamic programming
    over (lines used, anchors filled); the tables are a page long at most.
    """
    n, m = len(lines), len(anchors)
    inf = float("inf")
    best = [[inf] * (m + 1) for _ in range(n + 1)]
    back: list[list[tuple | None]] = [[None] * (m + 1) for _ in range(n + 1)]
    best[0][0] = 0.0

    def cost(i: int, k: int, j: int) -> float:
        if i == k:
            return EMPTY_COST
        top, bottom = lines[i]["top"], lines[k - 1]["bottom"]
        anchor = anchors[j]
        fit = min(abs((top + bottom) / 2 - anchor["middle"]), abs(top - anchor["top"]))
        # Two splits can fit equally well — a centred three-line name whose first line
        # also reads as the tail of the row above. A line that sits nearer another
        # anchor than its own settles it.
        for line in lines[i:k]:
            middle = (line["top"] + line["bottom"]) / 2
            own = abs(middle - anchor["middle"])
            other = min((abs(middle - a["middle"]) for n_, a in enumerate(anchors) if n_ != j), default=own)
            fit += max(0.0, own - other)
        # And no name starts on a legal suffix or stops halfway through one.
        if CONTINUES.match(lines[i]["text"]):
            fit += BROKEN_COST
        if UNFINISHED.search(lines[k - 1]["text"]):
            fit += BROKEN_COST
        return fit

    for i in range(n + 1):
        for j in range(m + 1):
            here = best[i][j]
            if here == inf:
                continue
            if i < n and here + SKIP_COST < best[i + 1][j]:
                best[i + 1][j] = here + SKIP_COST
                back[i + 1][j] = (i, j, None)
            if j < m:
                for k in range(i, min(n, i + 6) + 1):  # a name runs to five lines at most
                    value = here + cost(i, k, j)
                    if value < best[k][j + 1]:
                        best[k][j + 1] = value
                        back[k][j + 1] = (i, j, (i, k))
    groups: list[list[dict]] = [[] for _ in range(m)]
    i, j = n, m
    while (i, j) != (0, 0):
        step = back[i][j]
        if step is None:
            break
        pi, pj, span = step
        if span is not None:
            groups[pj] = lines[span[0]:span[1]]
        i, j = pi, pj
    return groups


def _anchors(words: list[dict]) -> list[dict]:
    refs = sorted((w for w in words if REFERENCE.match(w["text"])), key=lambda w: w["top"])
    tails = [w for w in words if REFERENCE_TAIL.match(w["text"])]
    anchors = []
    for ref in refs:
        top, bottom, x1 = ref["top"], ref["bottom"], ref["x1"]
        if ref["text"].endswith("-"):
            below = [t for t in tails if 0 <= t["top"] - ref["bottom"] < 14 and abs(t["x0"] - ref["x0"]) < 40]
            if below:
                bottom = max(bottom, below[0]["bottom"])
        anchors.append({"top": top, "bottom": bottom, "x1": x1, "middle": (top + bottom) / 2})
    for i, anchor in enumerate(anchors):
        gaps = []
        if i > 0:
            gaps.append(anchor["middle"] - anchors[i - 1]["middle"])
        if i + 1 < len(anchors):
            gaps.append(anchors[i + 1]["middle"] - anchor["middle"])
        # Half the distance to the nearer neighbour, and never more than a tall row.
        anchor["reach"] = min(min(gaps) / 2 + 1 if gaps else 14, 16)
    return anchors


def _lines(words: list[dict]) -> list[list[dict]]:
    lines: list[list[dict]] = []
    for w in sorted(words, key=lambda w: (w["top"], w["x0"])):
        if lines and abs(lines[-1][0]["top"] - w["top"]) <= 2:
            lines[-1].append(w)
        else:
            lines.append([w])
    return [sorted(line, key=lambda w: w["x0"]) for line in lines]


def _dedupe_repeat(text: str) -> str:
    """"Komal Shah Komal Shah" → "Komal Shah": a cell some PDFs print twice over itself."""
    words = text.split()
    half = len(words) // 2
    if len(words) % 2 == 0 and half and words[:half] == words[half:]:
        return " ".join(words[:half])
    return text


# ---------------------------------------------------------------------------------------
# What grants.csv is missing


def grants_csv_gap(path: pathlib.Path = GRANTS_CSV) -> dict[str, dict]:
    """For BIG 21–24: company awardees in the PDF, and those grants.csv does not hold.

    A company is a recipient is_company() calls one; since that rule leaves three-word
    personal names as companies, the missing names that carry a legal suffix are
    listed apart. Matched on the exact name key, the same comparison match.py uses.
    """
    with path.open(encoding="utf-8", newline="") as handle:
        held: dict[str, set[str]] = {}
        for row in csv.DictReader(handle):
            scheme = clean(row.get("scheme")) or ""
            match = re.search(r"BIG\s*(\d+)", scheme)
            if match:
                held.setdefault(match.group(1), set()).add(name_key(row["company_name"]))
    out = {}
    for url in pdf_links(fetch(PAGE)):
        pages = pdf_words(fetch_bytes(url))
        big_round = round_of(pages)
        if big_round not in IN_GRANTS_CSV:
            continue
        names = awardee_names(pages)
        companies = [n for n in names if is_company(n)]
        missing = [n for n in companies if name_key(n) not in held.get(big_round, set())]
        out[big_round] = {
            "url": url,
            "awardees": len(names),
            "companies": len(companies),
            "in_csv": len(held.get(big_round, set())),
            "missing": missing,
            # A legal suffix makes it certain; the rest may be people with three-word names.
            "missing_with_legal_suffix": [n for n in missing if LEGAL_SUFFIX.search(n)],
        }
    return out


if __name__ == "__main__":
    found = collect()
    print(f"{len(found)} awardees")
    for award in found[:10]:
        print(" ", award)
