"""National Startup Awards (DPIIT) — winners and finalists, from the static results sites.

    https://www.startupindia.gov.in/nsa/index.html              (2020)
    https://www.startupindia.gov.in/nsa2021results/index.html   (2021)
    https://www.startupindia.gov.in/nsa2022results/index.html   (2022)
    https://www.startupindia.gov.in/nsa2023results/index.html   (2023)
    https://www.startupindia.gov.in/nsa5.0results/index.html    (5.0)

Each edition is a small static site: an index page linking one page per sector or
award category. startupindia.gov.in serves no robots.txt (404), so nothing is
disallowed; pages are fetched through base.fetch, one a second, cached for 30 days.

Four page templates across five editions, each read from inside its own record:

- 2020: an accordion panel per winner (category heading "Winner | Post Harvest", name,
  DIPP number), then an "All Finalists" table of name, category, city, state rows.
- 2021: an accordion item per winner ("Agriculture | Irrigation", name, DIPP number),
  then the same four-column finalists table.
- 2022 and 2023: a modal per winner (name, "DPIIT Recognition Number", a place line,
  a Category box), then a #recognisingexceptional list of finalist names.
- 5.0: a winner card (name only), and finalist cards (name only).

A winner is also listed among that page's finalists on most templates. It is kept once,
as a winner; when the finalists table on the same page gives a city for it, that city
is taken, matched by the exact name key on that page, never by position.

The date is the edition's year, and only where the page names its edition by year in
its own title, a heading, the site's edition link or logo ("National Startup Awards
2020", "Agriculture in NSA 2022", "NSA 2021 Report", "Agri Innovation Award In NSA 2025"). It is the year of the edition, not the day the
results were announced; those came later for at least one edition (the 5.0 index page
says the 2023 results were announced on 16 January 2024). A page whose heading does
not name a year gives no date, and the edition stays in the label. `published` stays
None: the pages print a copyright year, which is not a publication date.

Two things the pages show that are not collected: a winner card the site has
commented out (2022 Travel, JetSetGo) is not on the page a reader sees, and the 2022
Drinking Water page's finalist block is the 2021 Agriculture list left in the template.

    python3 -m ingest.evidence.national_startup_awards
"""

from __future__ import annotations

import re
import urllib.parse

from bs4 import BeautifulSoup

from ingest.duplicates import name_key
from ingest.evidence import Award, city_from, clean, is_company
from ingest.sources.base import fetch

SOURCE = "nsa-dpiit"
HOST = "https://www.startupindia.gov.in"

# (edition as the site names it, results site root)
EDITIONS = [
    ("2020", f"{HOST}/nsa/"),
    ("2021", f"{HOST}/nsa2021results/"),
    ("2022", f"{HOST}/nsa2022results/"),
    ("2023", f"{HOST}/nsa2023results/"),
    ("5.0", f"{HOST}/nsa5.0results/"),
]

DIPP = re.compile(r"\bDIPP\s*\d+\b", re.IGNORECASE)
YEAR_IN_HEADING = re.compile(r"\b(?:National Startup Awards|NSA)\s+((?:19|20)\d{2})\b", re.IGNORECASE)


def collect() -> list[Award]:
    awards: list[Award] = []
    for edition, root in EDITIONS:
        index_url = urllib.parse.urljoin(root, "index.html")
        index_html = fetch(index_url)
        pages = page_urls(index_html, root)
        if not pages:
            raise ValueError(f"no category pages linked from {index_url} — the page shape changed")
        edition_awards = parse_page(index_html, index_url, edition, require=False)
        for url in pages:
            edition_awards.extend(parse_page(fetch(url), url, edition, require=False))
        if not edition_awards:
            raise ValueError(f"NSA {edition}: {len(pages)} pages and no winners or finalists — the page shape changed")
        awards.extend(edition_awards)
    return awards


def page_urls(index_html: str, root: str) -> list[str]:
    """Every sector or category page the index links to, in the order it lists them."""
    soup = BeautifulSoup(index_html, "html.parser")
    seen: list[str] = []
    for anchor in soup.find_all("a", href=True):
        href = anchor["href"].split("#", 1)[0].strip()
        if not href.lower().endswith(".html") or href.startswith(("http:", "https:", "/")):
            continue
        if href.lower() == "index.html":
            continue
        url = urllib.parse.urljoin(root, urllib.parse.quote(href, safe="/-._~"))
        if url not in seen:
            seen.append(url)
    return seen


def parse_page(html: str, url: str, edition: str, *, require: bool = True) -> list[Award]:
    """Winners and finalists on one page. `require` raises when the page yields none."""
    soup = BeautifulSoup(html, "html.parser")
    year = edition_year(soup, edition)
    sector = sector_name(soup)

    winners: list[dict] = []
    finalists: list[dict] = []
    for reader in (_winners_2020, _winners_2021, _winners_modal, _winners_card):
        winners.extend(reader(soup))
    if not any(url.endswith(path) for path in TEMPLATE_LEFTOVER_FINALISTS):
        for reader in (_finalists_table, _finalists_list, _finalists_card):
            finalists.extend(reader(soup))

    finalist_city = {}
    for row in finalists:
        if row.get("city"):
            finalist_city.setdefault(name_key(row["name"]), row["city"])

    awards: list[Award] = []
    seen: set[tuple[str, str]] = set()
    winner_keys = set()
    for row in winners:
        key = name_key(row["name"])
        winner_keys.add(key)
        category = row.get("category")
        awards.append(_award(row["name"], "winner", edition, year, sector, category, url,
                             row.get("dpiit"), row.get("city") or finalist_city.get(key),
                             institution=_is_enabler(sector, category)))
        seen.add((key, "winner"))
    for row in finalists:
        key = name_key(row["name"])
        if key in winner_keys or (key, "finalist") in seen:
            continue
        seen.add((key, "finalist"))
        awards.append(_award(row["name"], "finalist", edition, year, sector, row.get("category"), url,
                             None, row.get("city"), institution=_is_enabler(sector, row.get("category"))))

    if require and not awards:
        raise ValueError(f"no winners or finalists on {url} — the page shape changed")
    return awards


# ---------------------------------------------------------------------------------------
# What the page says about itself


def edition_year(soup: BeautifulSoup, edition: str) -> str | None:
    """The edition's year as this page states it, or None.

    Read from the title, the headings, the site's own "NSA 2021 Report" link and the
    logo's alt text — the places a page names itself — so a copyright line or a
    sentence about an earlier edition cannot supply it. For a year-named edition the
    year found must be that edition's; on a "5.0" page it is whatever year the page
    gives the edition ("In NSA 2025").
    """
    texts = [soup.title.get_text(" ") if soup.title else ""]
    texts += [h.get_text(" ") for h in soup.find_all(["h1", "h2", "h3", "h4"])]
    # The results site's own navigation names the edition ("NSA 2021 Report") on
    # special-category pages that carry no sector heading.
    texts += [a.get_text(" ") for a in soup.find_all("a") if re.search(r"\bReport\b", a.get_text(" "))]
    texts += [img["alt"] for img in soup.find_all("img", alt=True)]
    for text in texts:
        match = YEAR_IN_HEADING.search(clean(text) or "")
        if match and (not edition.isdigit() or match.group(1) == edition):
            return match.group(1)
    return None


def sector_name(soup: BeautifulSoup) -> str | None:
    """The page's sector or award category, from its title or first heading."""
    title = clean(soup.title.get_text(" ")) if soup.title else None
    if title and "-National Startup Awards" in title:  # 2020: "Agriculture-National Startup Awards 2020"
        name = title.split("-National Startup Awards", 1)[0]
        return clean(re.sub(r"^Special Category\s+", "", name))
    if title and "|" in title:  # 5.0: "Agri Innovation award | National Startup Awards 5.0 Results"
        heading = soup.select_one("h2.page-title")
        if heading:
            return clean(re.sub(r"\s+In\s+NSA\s+\S+\s*$", "", heading.get_text(" "), flags=re.IGNORECASE))
    for heading in soup.select(".section-title h2, .about-sect h2, h2.header-01"):
        text = clean(heading.get_text(" ")) or ""
        text = re.sub(r"\s+in\s+NSA\s+\S+\s*$", "", text, flags=re.IGNORECASE)
        if text and text.lower() not in {"winners", "all finalists"} and not text.lower().startswith("categories"):
            return text
    if title and " - " in title:  # 2023: "National Startup Awards 2023 Results - Rising Star Award"
        tail = clean(title.rsplit(" - ", 1)[1])
        if tail and tail.lower() != "startup india":
            return tail
    if title and "results" not in title.lower():  # 2021: "Agriculture"
        return title
    return None


# ---------------------------------------------------------------------------------------
# Winners


def _winners_2020(soup: BeautifulSoup) -> list[dict]:
    rows = []
    for button in soup.select("button.accordion"):
        panel = button.find_next_sibling("div", class_="panel")
        if panel is None:
            continue
        heading = panel.select_one("h3.category")
        name_tag = panel.select_one("p.winner-name")
        name = clean(name_tag.get_text(" ")) if name_tag else clean(button.get_text(" "))
        if not name:
            continue
        category = None
        if heading:
            text = clean(heading.get_text(" ")) or ""
            category = clean(text.split("|", 1)[1]) if "|" in text else None
        rows.append({"name": name, "category": category, "dpiit": _dipp(panel)})
    # Single-winner special pages ("Campus") carry no accordion: one winner block.
    if not rows:
        name_tag = soup.select_one("p.winner-name")
        if name_tag and clean(name_tag.get_text(" ")):
            block = name_tag.find_parent("div", class_="acc-desc") or name_tag.parent
            rows.append({"name": clean(name_tag.get_text(" ")), "category": None, "dpiit": _dipp(block)})
    return rows


def _winners_2021(soup: BeautifulSoup) -> list[dict]:
    rows = []
    for item in soup.select(".accordion-item"):
        name_tag = item.select_one(".heading-2-text h1")
        if name_tag is None:
            continue
        name = clean(name_tag.get_text(" "))
        heading = item.select_one("h1.green-clr")
        category = None
        if heading:
            text = clean(heading.get_text(" ")) or ""
            category = clean(text.split("|", 1)[1]) if "|" in text else clean(text)
        if name:
            rows.append({"name": name, "category": category, "dpiit": _dipp(item.select_one(".heading-2-text"))})
    return rows


def _winners_modal(soup: BeautifulSoup) -> list[dict]:
    rows = []
    # Pages copied from one another keep each other's modals. Only a modal the page
    # itself opens — a visible "View" link to its id — is this page's winner.
    opened = {a["href"][1:] for a in soup.find_all("a", href=True) if a["href"].startswith("#") and len(a["href"]) > 1}
    for modal in soup.select("div.modal"):
        right = modal.select_one(".nsa-shapos-services-right")
        if right is None or modal.get("id") not in opened:
            continue
        name_tag = right.find("h4")
        name = clean(name_tag.get_text(" ")) if name_tag else None
        if not name:
            continue
        place = None
        for p in right.find_all("p", recursive=False):
            place = clean(p.get_text(" "))
            if place:
                break
        category = None
        for box in modal.select(".nsa-product-summary"):
            h4 = box.find("h4")
            if h4 and (clean(h4.get_text(" ")) or "").lower() == "category":
                para = box.find("p")
                category = clean(para.get_text(" ")) if para else None
                break
        own = _own_category(category, name, soup)
        if own is FOREIGN:
            continue
        rows.append({"name": name, "category": own, "dpiit": None, "city": city_from(place)})
        for h6 in right.find_all("h6"):
            if "dpiit" in h6.get_text(" ").lower():
                rows[-1]["dpiit"] = _dipp(h6)
    return rows


def _own_category(category: str | None, name: str, soup: BeautifulSoup) -> str | None:
    """The sub-category a modal gives, with its sector prefix dropped.

    "Agriculture – Post Harvest" on the Agriculture page is "Post Harvest". A prefix
    naming a different sector ("Energy – Clean Energy" on the 2022 Drinking Water page)
    is another page's winner left in a copied template: FOREIGN, and the record is
    skipped here — it is collected from its own sector's page. A category box that
    repeats the company's name is not a category.
    """
    if not category:
        return None
    if name_key(category) == name_key(name) or name.lower() in category.lower():
        return None
    parts = re.split(r"\s+[–-]\s+|\s*–\s*", category, maxsplit=1)
    if len(parts) == 2:
        sector = sector_name(soup) or ""
        prefix, rest = clean(parts[0]) or "", clean(parts[1])
        if not rest:
            return None
        if name_key(prefix) and name_key(prefix)[:5] in name_key(sector):
            return rest
        return FOREIGN
    return category


FOREIGN = object()

# Finalist blocks that are another page's list left in a copied template, checked by
# hand against the other edition's page. Skipped rather than labelled with the wrong
# sector.
TEMPLATE_LEFTOVER_FINALISTS = {
    # Identical, name for name and category for category, to the 2021 Agriculture
    # finalists table (G Systems, Gfresh Agrotech, Krushak Mitra, Satyukt Analytics...).
    "nsa2022results/drinking-water.html",
}


def _winners_card(soup: BeautifulSoup) -> list[dict]:
    rows = []
    for card in soup.select(".winner-card"):
        name_tag = card.select_one(".company-name")
        name = clean(name_tag.get_text(" ")) if name_tag else None
        if name:
            rows.append({"name": name, "category": None, "dpiit": None})
    return rows


# ---------------------------------------------------------------------------------------
# Finalists


def _finalists_table(soup: BeautifulSoup) -> list[dict]:
    rows = []
    for table in soup.find_all("table"):
        header = [clean(th.get_text("")) or "" for th in table.find_all("th")]
        if not header or "name" not in header[0].lower():
            continue
        columns = [h.lower() for h in header]
        for tr in table.find_all("tr"):
            cells = [clean(td.get_text("")) for td in tr.find_all("td")]
            if len(cells) < 2 or not cells[0]:
                continue
            record = dict(zip(columns, cells))  # one row's own cells, by its own header
            rows.append({
                "name": cells[0],
                "category": record.get("category"),
                "city": record.get("city"),
            })
    return rows


def _finalists_list(soup: BeautifulSoup) -> list[dict]:
    rows = []
    for box in soup.select("#recognisingexceptional .recognisingexceptional"):
        h6 = box.find("h6")
        name = clean(h6.get_text(" ")) if h6 else None
        if name:
            rows.append({"name": name, "category": None, "city": None})
    return rows


def _finalists_card(soup: BeautifulSoup) -> list[dict]:
    return [{"name": n, "category": None, "city": None}
            for n in (clean(t.get_text(" ")) for t in soup.select(".finalist-card .finalist-name")) if n]


# ---------------------------------------------------------------------------------------


def _dipp(tag) -> str | None:
    if tag is None:
        return None
    match = DIPP.search(tag.get_text(" "))
    return re.sub(r"\s+", "", match.group(0)).upper() if match else None


def _is_enabler(sector: str | None, category: str | None) -> bool:
    text = f"{sector or ''} {category or ''}".lower()
    return "incubator" in text or "accelerator" in text or "accelator" in text


def _award(name, rank, edition, year, sector, category, url, dpiit, city, *, institution=False) -> Award:
    what = sector or ""
    if category and (not sector or category.lower() not in sector.lower()):
        what = f"{sector} ({category})" if sector else category
    label = f"National Startup Awards {edition}, {rank}" + (f" — {what}" if what else "")
    company = is_company(name, people_possible=False)
    if institution and not re.search(r"\b(?:pvt|private|ltd|limited|llp)\b", name, re.IGNORECASE):
        company = False
    return Award(
        name=name,
        type="award",
        label=label,
        date=year,
        published=None,
        url=url,
        source=SOURCE,
        dpiit_number=dpiit,
        city=city,
        is_company=company,
    )


if __name__ == "__main__":
    found = collect()
    print(f"{len(found)} awards")
    for award in found[:10]:
        print(" ", award)
