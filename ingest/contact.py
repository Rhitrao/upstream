"""How to reach a company, read off a homepage already fetched.

The page lists companies nobody has written about, and the useful thing to do with
one is usually to write to it. A reader who has to hunt for a contact route has
been handed half an answer. Most of these homepages say — measured over 207
readable ones on 14 September, 163 carried a contact route — so this reads it out
of HTML enrich.py has already fetched. No request, no model, no cost.

What counts is deliberately narrow, because the wrong address is worse than none:

    email   only an address on the company's own registrable domain, from a mailto:
            link or written out in the page text. A gmail address in a footer may
            well be the founder's, but nothing on the page says so, and a web
            agency's address in a "designed by" line is certainly not the company's.
            Where several qualify, a role address (info@, contact@) is preferred to a
            person's, since it is the one the company chose to publish for strangers.
    page    a link on the same registrable domain whose address or text says
            contact, get in touch or reach us. Not a careers page, not a social
            profile, not a form hosted somewhere else.

Obfuscated addresses — "info [at] foo dot com", Cloudflare's email protection — are
left alone. Undoing them is guessing, and a site that hides its address from
scrapers has said something about whether it wants this.
"""

from __future__ import annotations

import concurrent.futures
import datetime
import json
import pathlib
import re
import time
import urllib.parse
from dataclasses import dataclass

from bs4 import BeautifulSoup

from ingest import identity
from ingest.rdap import registrable


@dataclass(frozen=True)
class Contact:
    email: str | None
    page: str | None  # a contact page URL


NOTHING = Contact(None, None)

# Mailboxes that belong to a mail provider, a website builder or a form service. An
# address here is never the company's domain, and the domain check already refuses
# them; listed so that a company whose "website" is one of these still gets nothing.
NOT_A_COMPANY_DOMAIN = frozenset(
    """
    gmail.com googlemail.com yahoo.com yahoo.co.in yahoo.in ymail.com rediffmail.com outlook.com
    hotmail.com live.com msn.com icloud.com me.com aol.com proton.me protonmail.com zoho.com
    zohomail.in gmx.com mail.com yandex.com example.com domain.com yourdomain.com email.com
    wix.com wixpress.com sentry.io sentry-next.wixpress.com godaddy.com squarespace.com
    """.split()
)

# In the order they are preferred. What a company publishes for strangers to write to.
ROLE_MAILBOXES = (
    "info", "contact", "contactus", "hello", "sales", "business", "enquiry", "enquiries", "inquiry",
    "inquiries", "connect", "support", "office", "admin", "team", "mail",
)

# Local parts that are a template's placeholder or a machine, never a mailbox to write to.
NOT_A_MAILBOX = re.compile(
    r"^(?:no-?reply|do-?not-?reply|donotreply|mailer-daemon|postmaster|example|test|user|"
    r"name|your-?name|yourname|you|email|someone|username|abuse|webmaster|wordpress)$",
    re.IGNORECASE,
)

# Mailboxes that are on the company's domain but are for something other than
# getting in touch: applying for a job, a legal notice. Publishing career@ as "how to
# reach them" sends every reader to the hiring inbox.
NOT_FOR_CONTACT = re.compile(r"career|jobs?$|^hr$|humancapital|human\.?resources|recruit|hiring|talent|resume|^cv$|privacy|grievance|legal|^dpo$", re.IGNORECASE)

EMAIL = re.compile(r"(?<![\w.%+-])([a-z0-9][a-z0-9._%+-]{0,63}@(?:[a-z0-9-]+\.)+[a-z]{2,24})(?![\w-])", re.IGNORECASE)

# Asked of a link's path and of its text separately. Plain words at word boundaries,
# so /contact-us, /contactus.html and "Contact Us" match and /contactless-payments
# does not.
CONTACT_PATH = re.compile(r"(?:^|[/_.-])(?:contacts?(?:[-_]?us)?|get[-_]?in[-_]?touch|reach[-_]?us)(?:$|[/_.-])", re.IGNORECASE)
CONTACT_TEXT = re.compile(r"^\W*(?:contacts?(?:\s+us)?|get\s+in\s+touch|reach\s+us)\W*$", re.IGNORECASE)
NOT_CONTACT = re.compile(r"career|jobs?\b|hiring|join[-_ ]?us|vacanc|recruit", re.IGNORECASE)

# A link to a file is not a page, whatever it is called.
FILE_SUFFIX = re.compile(r"\.(?:pdf|jpe?g|png|gif|svg|webp|docx?|xlsx?|zip|vcf)$", re.IGNORECASE)


def _base_url(website: str) -> str:
    text = website.strip()
    return text if "//" in text else f"https://{text}"


def _rank(address: str) -> int:
    local = address.split("@", 1)[0].lower()
    try:
        return ROLE_MAILBOXES.index(local)
    except ValueError:
        return len(ROLE_MAILBOXES)


def _email(soup: BeautifulSoup, own: str) -> str | None:
    """The company's own address, role mailbox first, else the first that appears."""
    candidates: list[str] = []

    for anchor in soup.find_all("a", href=True):
        href = str(anchor.get("href") or "").strip()
        if not href.lower().startswith("mailto:"):
            continue
        target = urllib.parse.unquote(href[len("mailto:"):]).split("?", 1)[0]
        candidates.extend(part.strip() for part in target.split(","))

    for tag in soup(["script", "style", "noscript", "template"]):
        tag.decompose()
    candidates.extend(EMAIL.findall(soup.get_text(" ")))

    kept: list[str] = []
    for candidate in candidates:
        match = EMAIL.fullmatch(candidate.strip().strip(".,;:()<>[]\"'"))
        if not match:
            continue
        address = match.group(1).lower()
        local, domain = address.rsplit("@", 1)
        if domain in NOT_A_COMPANY_DOMAIN or NOT_A_MAILBOX.match(local) or NOT_FOR_CONTACT.search(local):
            continue
        if registrable(domain) != own:
            continue
        if address not in kept:
            kept.append(address)
    if not kept:
        return None
    # Stable: among equals, the one the page put first.
    return min(kept, key=_rank)


def _page(soup: BeautifulSoup, website: str, own: str) -> str | None:
    """A contact page on the company's own domain: an address saying so beats link text saying so."""
    base = _base_url(website)
    homepage = urllib.parse.urldefrag(base)[0].rstrip("/")
    by_path: str | None = None
    by_text: str | None = None

    for anchor in soup.find_all("a", href=True):
        href = str(anchor.get("href") or "").strip()
        if not href or href.startswith("#") or href.lower().startswith(("mailto:", "tel:", "javascript:", "data:")):
            continue
        try:
            absolute = urllib.parse.urljoin(base, href)
            parts = urllib.parse.urlsplit(absolute)
        except ValueError:
            continue
        if parts.scheme not in ("http", "https") or registrable(parts.hostname) != own:
            continue
        # The homepage with a #contact on the end is a section of the page the reader
        # is already on, not somewhere to go. A #contact on another page is kept whole,
        # fragment included, because that is where the link actually points.
        without_fragment = urllib.parse.urlunsplit((parts.scheme, parts.netloc, parts.path, parts.query, ""))
        is_root = parts.path.rstrip("/") in ("", "/index.html", "/index.php") and not parts.query
        if is_root or without_fragment.rstrip("/") == homepage or FILE_SUFFIX.search(parts.path):
            continue
        if NOT_CONTACT.search(parts.path):
            continue
        if CONTACT_PATH.search(parts.path.rstrip("/")):
            # An address that says contact is enough, even beside "Contact & Jobs".
            by_path = without_fragment
            break
        text = " ".join(anchor.get_text(" ").split())
        if by_text is None and CONTACT_TEXT.match(text) and not NOT_CONTACT.search(text):
            by_text = urllib.parse.urlunsplit(parts)
    return by_path or by_text


def extract(html: str, website: str) -> Contact:
    """The company's own email address and contact page, where the homepage gives them.

    Contact(None, None) when nothing qualifies, when the website is a profile on
    another platform rather than the company's domain, or when the HTML is too broken
    to read. Never raises: a malformed homepage is a missing contact, not a failed run.
    """
    try:
        if not html or not website or identity.is_profile(website):
            return NOTHING
        own = registrable(website)
        if own is None or own in NOT_A_COMPANY_DOMAIN:
            return NOTHING
        soup = BeautifulSoup(html, "html.parser")
        # The page first, because looking for an email strips scripts and styles out
        # of the tree it reads.
        page = _page(soup, website, own)
        email = _email(soup, own)
        return Contact(email, page)
    except Exception:  # noqa: BLE001 - see the docstring
        return NOTHING


# --- many companies, remembered ------------------------------------------------

CACHE_PATH = pathlib.Path(__file__).parent / "cache" / "contacts.json"

# A homepage's contact line changes about as often as its footer. Reading every one
# every night would refetch two hundred sites to learn nothing; reading them never
# again would keep an address a company has since dropped.
REFRESH_AFTER = datetime.timedelta(days=30)
FETCHERS = 8


def _load(path: pathlib.Path) -> dict:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def _save(entries: dict, path: pathlib.Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(entries, indent=1, sort_keys=True), encoding="utf-8")


def _fresh(entry, website: str, now: datetime.datetime) -> bool:
    if not isinstance(entry, dict) or entry.get("website") != website:
        return False
    try:
        return now - datetime.datetime.fromisoformat(entry["checked"]) < REFRESH_AFTER
    except (KeyError, TypeError, ValueError):
        return False


def lookup(companies, max_seconds: float = 300, *, cache_path: pathlib.Path = CACHE_PATH, fetch=None, now=None) -> dict[str, Contact]:
    """Company id to Contact, for every company whose website is verified as theirs.

    Only verified websites: an address on a domain nothing ties to the company would be
    handing a reader someone else's inbox. A cached answer for the same address younger
    than REFRESH_AFTER is used as it is; the rest are fetched — from base.py's disk cache
    when enrich.py read the page this run — until `max_seconds` is spent. Never raises.
    """
    from ingest.sources.base import fetch_optional

    get = fetch or fetch_optional
    clock = now or (lambda: datetime.datetime.now(datetime.UTC))
    started = time.monotonic()
    results: dict[str, Contact] = {}
    try:
        cache = _load(cache_path)
        todo = []
        for company in companies:
            website = getattr(company, "website", None)
            if getattr(company, "website_identity", None) != "verified" or not website or identity.is_profile(website):
                continue
            entry = cache.get(company.id)
            if _fresh(entry, website, clock()):
                results[company.id] = Contact(entry.get("email"), entry.get("page"))
            else:
                todo.append(company)

        def read(company):
            html, outcome = get(company.website)
            return company, (extract(html, company.website) if html else None)

        asked = 0
        with concurrent.futures.ThreadPoolExecutor(max_workers=FETCHERS) as pool:
            futures = [pool.submit(read, company) for company in todo]
            for future in concurrent.futures.as_completed(futures):
                if time.monotonic() - started >= max_seconds:
                    for pending in futures:
                        pending.cancel()
                    print(f"  contact: stopped at the {max_seconds:.0f}s budget; the rest wait for the next run")
                    break
                try:
                    company, found = future.result()
                except Exception:  # noqa: BLE001 - one homepage, not the run
                    continue
                if found is None:
                    # Nothing to read is not "no contact": do not cache it as an answer.
                    continue
                asked += 1
                results[company.id] = found
                cache[company.id] = {"website": company.website, "email": found.email, "page": found.page, "checked": clock().isoformat(timespec="seconds")}
        _save(cache, cache_path)
        if asked:
            print(f"  contact: read {asked} homepages, {sum(1 for c in results.values() if c.email or c.page)} of {len(results)} verified sites give a contact route")
    except Exception as error:  # noqa: BLE001 - a missing contact must never fail the ingest
        print(f"  contact: lookup stopped early: {type(error).__name__}: {str(error)[:120]}")
    return results
