"""What else a company's own website says, past the front page: about, products,
technology, team and careers.

The homepage read (enrich.py) asks a model one question of one page. Most of what a
reader would check next is not a question for a model at all: whether the company is
hiring and for roughly what, whether it publishes code, whether it names its team,
what its pages call themselves. Those are read here, deterministically, at no API cost.

Only the homepage's own links are followed. Nothing is guessed: a site with no link to
a careers page has not published one as far as a visitor can tell, and spraying
/careers, /jobs and /join-us at two hundred small servers to find out would be rude
and would turn "no page" into a pile of 404s. A link counts only on the company's own
registrable domain. A careers link to a hiring platform (Lever, Greenhouse, Keka...) is
recorded as hosted there and not fetched.

Politeness: robots.txt is read once per site and obeyed for this reader's user agent;
pages on one site are fetched one after another at least a second apart, with the same
self-identifying user agent as every other request this pipeline makes. Different sites
are read concurrently, since no one server is any busier for it.

What every field is and is not:

    title, meta     what the page calls itself and the summary it gives search engines.
                    The site's wording, not a verified statement about the company.
    careers.roles   roughly how many distinct role titles the careers page lists, by
                    matching job-title words in its headings and links. A careers page
                    with roles is a sign of activity. It is not headcount, and it is not
                    revenue.
    repo            a link from the site to a code-hosting account whose name matches the
                    site's own. A theme author's GitHub in a footer does not count.
    team            a team page answered. Names on it are not extracted.

Each page keeps its outcome: ok, thin (answered with almost no readable text, usually a
JavaScript shell), missing (404/410), refused (401/403/429), robots (disallowed), or
unreachable (timeout, DNS, connection). None of these means a company is inactive.
"""

from __future__ import annotations

import concurrent.futures
import datetime
import json
import os
import pathlib
import re
import time
import urllib.parse
import urllib.robotparser
from dataclasses import dataclass, field

import requests
from bs4 import BeautifulSoup

from ingest import contact, identity
from ingest.rdap import is_hosted, registrable
from ingest.sources.base import USER_AGENT, clean, fetch_optional

CACHE_PATH = pathlib.Path(__file__).parent / "cache" / "sitepages.json"
REFRESH_AFTER = datetime.timedelta(days=30)
FETCHERS = 8
SAME_SITE_DELAY = 1.0
TIMEOUT_SECONDS = 10

# Text shorter than this on an answered page is a shell, not a page.
MIN_PAGE_CHARS = 200

# Checked in this order, and one link serves one kind: "join our team" is careers, not team.
KINDS = ("careers", "team", "about", "products", "technology")
PATHS = {
    "careers": re.compile(r"(?:^|[/_.-])(?:careers?|jobs?|join[-_]?(?:us|our[-_]?team)|work[-_]?with[-_]?us|openings|vacanc(?:y|ies)|hiring|opportunities)(?:$|[/_.-])", re.I),
    "team": re.compile(r"(?:^|[/_.-])(?:(?:our|the|meet[-_]?the)[-_]?)?(?:team|people|leadership|founders|management|advisors?)(?:$|[/_.-])", re.I),
    "about": re.compile(r"(?:^|[/_.-])(?:about(?:[-_]?us)?|who[-_]?we[-_]?are|our[-_]?story|company)(?:$|[/_.-])", re.I),
    "products": re.compile(r"(?:^|[/_.-])(?:products?|solutions?|platform|offerings?)(?:$|[/_.-])", re.I),
    "technology": re.compile(r"(?:^|[/_.-])(?:technolog(?:y|ies)|tech|research|science|innovation|how[-_]?it[-_]?works)(?:$|[/_.-])", re.I),
}
TEXTS = {
    "careers": re.compile(r"^\W*(?:careers?|jobs|join us|join our team|work with us|we(?:'|’)re hiring|openings)\W*$", re.I),
    "team": re.compile(r"^\W*(?:(?:our |the |meet the )?team|people|leadership|founders|management)\W*$", re.I),
    "about": re.compile(r"^\W*(?:about(?: us)?|who we are|our story|company)\W*$", re.I),
    "products": re.compile(r"^\W*(?:(?:our )?products?|solutions?|platform|offerings?)\W*$", re.I),
    "technology": re.compile(r"^\W*(?:(?:our )?technolog(?:y|ies)|research|science|innovation|how it works)\W*$", re.I),
}

HIRING_HOSTS = re.compile(
    r"(?:^|\.)(?:lever\.co|greenhouse\.io|keka\.com|zohorecruit\.(?:com|in)|workable\.com|darwinbox\.in|"
    r"freshteam\.com|recruitee\.com|breezy\.hr|smartrecruiters\.com|ashbyhq\.com|wellfound\.com|angel\.co|"
    r"instahyre\.com|cutshort\.io|naukri\.com|internshala\.com|bamboohr\.com|jobvite\.com|teamtailor\.com)$",
    re.I,
)
CODE_HOSTS = ("github.com", "gitlab.com", "bitbucket.org", "huggingface.co")
NOT_AN_ACCOUNT = frozenset({"sponsors", "login", "join", "features", "about", "pricing", "topics", "marketplace", "explore", "orgs", "users", "site", "settings", "apps", "enterprise", "security"})

FILE_SUFFIX = re.compile(r"\.(?:pdf|jpe?g|png|gif|svg|webp|docx?|xlsx?|pptx?|zip|mp4)$", re.I)

ROLE_WORDS = re.compile(
    r"\b(?:engineer|developer|scientist|intern(?:ship)?|manager|designer|analyst|lead|associate|technician|"
    r"specialist|officer|executive|researcher|architect|consultant|fellow|coordinator|head of|director|"
    r"programmer|administrator|representative|operator|chemist|biologist|machinist|welder|accountant|"
    r"trainee|apprentice|marketer|writer|strategist)s?\b",
    re.I,
)
# Headings that name a department or a pitch, not a role.
NOT_A_ROLE = re.compile(r"\b(?:team|culture|benefits|why|life at|join|apply|our|we are|we're|careers?|openings|positions|opportunit|values|perks|hiring process)\b", re.I)
SENTENCE_WORDS = re.compile(r"\b(?:reporting|with|for our|you|we|will|responsible|experience|working|building|side by side|work that|reaches)\b", re.I)
# What a parked or for-sale domain says about itself. A fact about the address, not the company.
PARKED = re.compile(r"domain (?:is )?(?:for sale|may be for sale|parked)|buy this domain|this domain name|parkingcrew|sedoparking|hugedomains|dan\.com|godaddy\.com/domainsearch|coming soon|under construction|website is (?:under|coming)", re.I)
NO_OPENINGS = re.compile(r"\bno (?:current |open )?(?:openings|vacancies|positions|job openings|open roles)\b|\bnot hiring\b|\bcurrently (?:no|not)\b[^.]{0,30}\b(?:openings|vacancies|positions|hiring)", re.I)

OK, THIN, MISSING, REFUSED, ROBOTS, UNREACHABLE = "ok", "thin", "missing", "refused", "robots", "unreachable"


@dataclass
class Site:
    website: str
    pages: dict = field(default_factory=dict)  # kind -> {url, outcome, title, meta}
    careers: dict | None = None  # {url, roles, titles, says_none} or {url, hosted}
    repo: str | None = None
    team: str | None = None
    contact_email: str | None = None
    contact_page: str | None = None
    text_chars: int = 0  # readable product-ish text on about/products/technology, for the estimate only
    parked: bool = False  # the homepage reads as parked, for sale or not built yet

    def as_json(self) -> dict:
        return {k: v for k, v in self.__dict__.items()}


def _base(website: str) -> str:
    text = website.strip()
    return text if "//" in text else f"https://{text}"


def links(html: str, website: str) -> dict[str, str]:
    """The homepage's link for each kind, on the company's own domain; careers may be a hiring platform."""
    own = registrable(website)
    base = _base(website)
    found: dict[str, str] = {}
    used: set[str] = set()
    try:
        soup = BeautifulSoup(html, "html.parser")
    except Exception:  # noqa: BLE001
        return found
    anchors = []
    for anchor in soup.find_all("a", href=True):
        href = str(anchor.get("href") or "").strip()
        if not href or href.startswith("#") or href.lower().startswith(("mailto:", "tel:", "javascript:", "data:")):
            continue
        try:
            parts = urllib.parse.urlsplit(urllib.parse.urljoin(base, href))
        except ValueError:
            continue
        if parts.scheme not in ("http", "https") or not parts.hostname or FILE_SUFFIX.search(parts.path):
            continue
        url = urllib.parse.urlunsplit((parts.scheme, parts.netloc, parts.path, parts.query, ""))
        text = " ".join(anchor.get_text(" ").split())
        anchors.append((parts, url, text))

    for kind in KINDS:
        by_path = by_text = None
        for parts, url, text in anchors:
            if url in used:
                continue
            on_own = registrable(parts.hostname) == own
            if kind == "careers" and not on_own and HIRING_HOSTS.search(parts.hostname):
                by_path = by_path or url
                continue
            if not on_own or parts.path.rstrip("/") in ("", "/index.html", "/index.php"):
                continue
            if PATHS[kind].search(parts.path.rstrip("/")):
                # The shortest address that says so: /careers over /careers/senior-engineer.
                if by_path is None or len(url) < len(by_path):
                    by_path = url
            elif by_text is None and TEXTS[kind].match(text):
                by_text = url
        chosen = by_path or by_text
        if chosen:
            found[kind] = chosen
            used.add(chosen)
    return found


def repository(htmls: list[str], website: str) -> str | None:
    """A code-hosting account the site links to whose name matches the site's own domain."""
    own = registrable(website) or ""
    label = re.sub(r"[^a-z0-9]", "", own.split(".")[0].lower())
    if len(label) < 3:
        return None
    for html in htmls:
        for href in re.findall(r"""href=["']([^"']+)["']""", html or "", re.I):
            try:
                parts = urllib.parse.urlsplit(href.strip())
            except ValueError:
                continue
            host = (parts.hostname or "").lower().removeprefix("www.")
            if host not in CODE_HOSTS:
                continue
            segments = [s for s in parts.path.split("/") if s]
            if not segments or segments[0].lower() in NOT_AN_ACCOUNT:
                continue
            account = re.sub(r"[^a-z0-9]", "", segments[0].lower())
            if account and (label in account or account in label) and len(account) >= 3:
                return f"https://{host}/{segments[0]}"
    return None


def roles(html: str) -> tuple[int, list[str], bool]:
    """Roughly how many distinct role titles a careers page lists, a few of them, and whether it says it has none."""
    soup = BeautifulSoup(html, "html.parser")
    for tag in soup(["script", "style", "noscript", "svg", "template", "nav", "footer", "header"]):
        tag.decompose()
    seen: dict[str, str] = {}
    for tag in soup.find_all(["h1", "h2", "h3", "h4", "h5", "a", "strong", "b", "li", "td"]):
        text = " ".join(tag.get_text(" ").split()).strip(" \"'“”‘’")
        # A role title is short and is not a sentence: "Reporting to Senior Marketing Manager" and
        # "Clear communication with engineers, vendors..." counted as roles on 15 Sep 2026.
        if not (4 <= len(text) <= 60) or len(text.split()) > 6 or not ROLE_WORDS.search(text) or NOT_A_ROLE.search(text):
            continue
        if text.endswith((".", ",", ";")) or SENTENCE_WORDS.search(text):
            continue
        text = re.sub(r"^(?:application|apply|position|role|job)\s*[:\-–]\s*", "", text, flags=re.I)
        key = re.sub(r"[^a-z0-9]+", " ", text.lower()).strip()
        seen.setdefault(key, text)
    says_none = bool(NO_OPENINGS.search(soup.get_text(" ")))
    titles = list(seen.values())
    return len(titles), titles[:6], says_none


def describe(html: str) -> tuple[str | None, str | None, int]:
    soup = BeautifulSoup(html, "html.parser")
    title = clean(soup.title.string) if soup.title and soup.title.string else None
    meta = None
    for attrs in ({"name": "description"}, {"property": "og:description"}):
        tag = soup.find("meta", attrs=attrs)
        if tag and tag.get("content"):
            meta = clean(str(tag["content"]))[:300] if clean(str(tag["content"])) else None
            break
    for tag in soup(["script", "style", "noscript", "svg", "template", "nav", "footer"]):
        tag.decompose()
    return title, meta, len(" ".join(soup.get_text(" ").split()))


# --- fetching ----------------------------------------------------------------


def _outcome(result: str) -> str:
    return {"ok": OK, "refused": REFUSED}.get(result, UNREACHABLE)


def _get(url: str, html_only: bool = True) -> tuple[str | None, str]:
    """A page, or why not. A 404 is kept apart from a dead server: the page is missing, the site is not."""
    try:
        response = requests.get(url, headers={"User-Agent": USER_AGENT}, timeout=TIMEOUT_SECONDS)
    except requests.RequestException:
        return None, UNREACHABLE
    if response.status_code in (404, 410):
        return None, MISSING
    if response.status_code in (401, 403, 405, 406, 429):
        return None, REFUSED
    if response.status_code >= 400:
        return None, UNREACHABLE
    if "charset" not in response.headers.get("content-type", "").lower():
        response.encoding = response.apparent_encoding or "utf-8"
    if html_only and "html" not in response.headers.get("content-type", "html").lower():
        return None, MISSING
    return response.text, OK


def _robots(website: str, get) -> urllib.robotparser.RobotFileParser | None:
    parts = urllib.parse.urlsplit(_base(website))
    parser = urllib.robotparser.RobotFileParser()
    body, outcome = get(f"{parts.scheme}://{parts.netloc}/robots.txt", False)
    if outcome == MISSING or body is None:
        return None  # no robots.txt, or none readable: nothing forbids
    if "<html" in body[:500].lower():
        return None  # a site that answers every path with its homepage has no rules file
    parser.parse(body.splitlines())
    return parser


def read_site(company, homepage_fetch=fetch_optional, get=_get, sleep=time.sleep) -> Site:
    """Every linked page of one site, one at a time."""
    website = company.website
    site = Site(website=website)
    home, result = homepage_fetch(website)
    if home is None:
        site.pages["home"] = {"url": website, "outcome": _outcome(result)}
        return site
    site.parked = bool(PARKED.search(BeautifulSoup(home, "html.parser").get_text(" ")[:5000]))
    found = links(home, website)
    rules = _robots(website, get) if found else None
    htmls = [home]
    for kind, url in found.items():
        host = urllib.parse.urlsplit(url).hostname or ""
        if kind == "careers" and registrable(host) != registrable(website):
            site.careers = {"url": url, "hosted": host}
            site.pages[kind] = {"url": url, "outcome": "hosted"}
            continue
        if rules is not None and not rules.can_fetch(USER_AGENT, url):
            site.pages[kind] = {"url": url, "outcome": ROBOTS}
            continue
        sleep(SAME_SITE_DELAY)
        html, outcome = get(url)
        entry = {"url": url, "outcome": outcome}
        if html is not None:
            title, meta, chars = describe(html)
            if chars < MIN_PAGE_CHARS:
                entry["outcome"] = THIN
            entry.update({"title": title, "meta": meta})
            htmls.append(html)
            if kind == "careers" and entry["outcome"] == OK:
                count, titles, says_none = roles(html)
                site.careers = {"url": url, "roles": count, "titles": titles, "says_none": says_none}
            if kind == "team" and entry["outcome"] == OK:
                site.team = url
            if kind in ("about", "products", "technology") and entry["outcome"] == OK:
                from ingest.enrich import extract as product_text

                site.text_chars += len(product_text(html))
        site.pages[kind] = entry
    site.repo = repository(htmls, website)
    if not company_has_contact(company):
        for html in htmls[1:]:
            found_contact = contact.extract(html, website)
            if found_contact.email or found_contact.page:
                site.contact_email, site.contact_page = found_contact.email, found_contact.page
                break
    return site


def company_has_contact(company) -> bool:
    return bool(getattr(company, "contact_email", None) or getattr(company, "contact_page", None))


# --- many sites, remembered -------------------------------------------------------


def load(path: pathlib.Path = CACHE_PATH) -> dict:
    try:
        entries = json.loads(pathlib.Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return entries if isinstance(entries, dict) else {}


def save(entries: dict, path: pathlib.Path = CACHE_PATH) -> None:
    path = pathlib.Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(entries, indent=1, sort_keys=True, ensure_ascii=False) + "\n", encoding="utf-8")
    os.replace(temporary, path)


def _fresh(entry, website: str, now: datetime.datetime) -> bool:
    if not isinstance(entry, dict) or entry.get("website") != website:
        return False
    try:
        return now - datetime.datetime.fromisoformat(entry["checked"]) < REFRESH_AFTER
    except (KeyError, TypeError, ValueError):
        return False


def lookup(companies, max_seconds: float = 600, *, cache_path: pathlib.Path = CACHE_PATH, read=read_site, now=None) -> dict[str, dict]:
    """Company id to what its other pages say, for verified websites. Cached 30 days; never raises."""
    clock = now or (lambda: datetime.datetime.now(datetime.UTC))
    started = time.monotonic()
    results: dict[str, dict] = {}
    try:
        cache = load(cache_path)
        todo = []
        for company in companies:
            website = getattr(company, "website", None)
            if getattr(company, "website_identity", None) != "verified" or not website or identity.is_profile(website):
                continue
            domain = registrable(website)
            if domain is None or is_hosted(domain):
                continue
            entry = cache.get(company.id)
            if _fresh(entry, website, clock()):
                results[company.id] = entry
            else:
                todo.append(company)
        read_count = 0
        with concurrent.futures.ThreadPoolExecutor(max_workers=FETCHERS) as pool:
            futures = {pool.submit(read, company): company for company in todo}
            for future in concurrent.futures.as_completed(futures):
                if time.monotonic() - started >= max_seconds:
                    for pending in futures:
                        pending.cancel()
                    print(f"  sitepages: stopped at the {max_seconds:.0f}s budget; the rest wait for the next run")
                    break
                company = futures[future]
                try:
                    site = future.result()
                except Exception as error:  # noqa: BLE001 - one site, not the run
                    print(f"  sitepages {company.id}: {type(error).__name__}: {str(error)[:100]}")
                    continue
                entry = {**site.as_json(), "checked": clock().isoformat(timespec="seconds")}
                cache[company.id] = entry
                results[company.id] = entry
                read_count += 1
                if read_count % 20 == 0:
                    save(cache, cache_path)
        save(cache, cache_path)
        if read_count:
            print(f"  sitepages: read {read_count} sites")
    except Exception as error:  # noqa: BLE001 - never fail the ingest
        print(f"  sitepages: lookup stopped early: {type(error).__name__}: {str(error)[:120]}")
    return results
