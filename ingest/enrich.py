"""What a company says it builds, read off its own homepage.

Part of the answer to the thing this list is worst at. A third of these companies
reach us through DPIIT, which publishes a name, an industry picked from a dropdown
and a stage — so 314 of 684 rows describe themselves as "DPIIT-recognised startup.
Industry: Nanotechnology. Stage: Prototype.", which tells a reader nothing they
could act on. Where a company publishes a website, the website usually says.

Two things this deliberately is not.

It is not a claim of fact. This is a company's own front page, read by a model. The
page prints it as what the company says about itself, next to the link, and never as
something anyone here verified. A founder describing their own prototype as a
platform is exactly the kind of thing this pipeline must pass through unaltered
rather than launder into a finding.

And it is not a field that quietly goes blank. 209 of 684 companies publish a
website at all; of those, about a third answer with nothing usable — a dead domain,
a page that refuses an automated reader, a shell that draws itself in JavaScript.
Every one of those outcomes is recorded by name, because "the domain of a
DPIIT-recognised startup no longer resolves" is a finding, and a blank cell would
make it indistinguishable from "we have not got to this one yet".

    python3 -m ingest.enrich --estimate          # what the uncached ones would cost
    python3 -m ingest.enrich --limit 20          # a slice, to read the answers first

Costs are bounded the same way classification is, by the same env var and the same
ceiling, and every answer is cached in ingest/cache/products.json so a re-run is
free. Fetching is free and always was; only the reading is billed.
"""

from __future__ import annotations

import argparse
import concurrent.futures
import dataclasses
import hashlib
import json
import pathlib
import threading

import anthropic
from bs4 import BeautifulSoup

from ingest import classify, identity
from ingest.sources.base import Company, Signal, clean, fetch_optional

MODEL = "claude-haiku-4-5"

# One sentence back. The schema holds it to that; this stops a runaway.
MAX_TOKENS = 300

# Reading is billed and parallel; fetching is free and parallel for a different
# reason — see _fetch_all.
WORKERS = 6
FETCHERS = 12

# Part of the cache key, so a reworded prompt re-reads rather than silently mixing
# two generations of judgement. Raising it spends money.
PROMPT_VERSION = 1

# What we send the model. Measured over 30 homepages, an extraction like this one
# runs to about 2,100 characters; the cap is there for the outlier that inlines its
# entire blog into the front page, not for the common case.
MAX_PAGE_CHARS = 6000

# Below this there is nothing to read and no call worth paying for. A page that
# renders itself in JavaScript arrives here as a hundred characters of boilerplate.
MIN_PAGE_CHARS = 400

CACHE_PATH = pathlib.Path(__file__).parent / "cache" / "products.json"

# Measured: ~950 input tokens (the extraction plus the prompt) and ~130 out, at
# Haiku's $1/$5 per million. Used to reserve against the ceiling for calls already
# in flight, the same way classification does.
COST_PER_COMPANY = 0.0016

# Every outcome a company can have here. 'described' is the only one that produces a
# sentence; the rest are the page's material for saying what it cannot see.
DESCRIBED = "described"
UNREACHABLE = "unreachable"
REFUSED = "refused"
THIN = "thin"
UNCLEAR = "unclear"
# The page answered, but identity.py could not confirm the address is the company's,
# so nothing on it was read. Not a failure of the site: a refusal on our side to
# attribute a stranger's homepage to them.
UNVERIFIED = "unverified"

SYSTEM = """You read a company's own homepage and say what the company builds.

Answer in one sentence, in plain words, naming the actual product or technology and
who it is for. No marketing adjectives, no "innovative" or "cutting-edge", no
restating the company name.

Ground every word in the text you are given. You are not being asked what the
company probably does, or what a company with this name in this industry usually
does — only what this page says. Where the page does not say, `said` is false and
that is the correct answer, not a failure. A holding page, a login screen, a domain
for sale, a consultancy describing its values, a page that lists services so
generically that any company could have written it: all of those are `said` false.

The text arrives as a homepage flattened to its headings, paragraphs and list items,
so it will read as fragments rather than prose. That is expected."""


@dataclasses.dataclass(slots=True)
class Product:
    """What one company builds, or why we cannot say."""

    status: str
    product: str | None = None
    source: str = "claude"

    @property
    def described(self) -> bool:
        return self.status == DESCRIBED and bool(self.product)


# --- reading a homepage -----------------------------------------------------


def extract(html: str) -> str:
    """A homepage flattened to the parts that say what a company does.

    Title, meta description, headings, paragraphs, list items — in that order,
    because that is roughly the order of confidence. Everything else on a modern
    marketing page is navigation, cookie notices and a careers link, and sending it
    costs money to tell the model things about the company's website rather than
    about the company.
    """
    soup = BeautifulSoup(html, "html.parser")
    for tag in soup(["script", "style", "noscript", "svg", "template", "nav", "footer"]):
        tag.decompose()

    parts: list[str] = []
    if soup.title and soup.title.string:
        parts.append(soup.title.string)
    for attrs in ({"name": "description"}, {"property": "og:description"}):
        meta = soup.find("meta", attrs=attrs)
        if meta and meta.get("content"):
            parts.append(meta["content"])
    for names, limit in ((["h1", "h2", "h3"], 12), (["p"], 15), (["li"], 15)):
        for tag in soup.find_all(names, limit=limit):
            parts.append(tag.get_text(" "))

    # Collapsed and de-duplicated: a heading repeated in a hero and again in a
    # section is one fact, and paying to send it twice buys nothing.
    seen: set[str] = set()
    kept: list[str] = []
    for part in parts:
        text = clean(part)
        if not text or len(text) < 3 or text.lower() in seen:
            continue
        seen.add(text.lower())
        kept.append(text)

    return "\n".join(kept)[:MAX_PAGE_CHARS]


def visible_text(html: str) -> str:
    """Everything a visitor could read, footer included — where a legal name lives."""
    soup = BeautifulSoup(html, "html.parser")
    for tag in soup(["script", "style", "noscript", "svg", "template"]):
        tag.decompose()
    parts = [soup.get_text(" ")]
    if soup.title and soup.title.string:
        parts.insert(0, soup.title.string)
    return " ".join(parts)


def read_homepage(company: Company) -> tuple[str | None, str, str | None]:
    """The homepage as product text, the outcome, and the whole visible page.

    The third value is for identity.py, and it survives a page too thin to read for a
    product: a JavaScript shell with nothing in its body still has a title.
    """
    if not company.website:
        # Nothing to fetch, and candidates() never enqueues one. Guarded anyway,
        # because the wrong answer here is a status claiming we looked at an address
        # that does not exist.
        raise ValueError(f"{company.id} has no website to read")

    if identity.is_profile(company.website):
        # A LinkedIn page is not their homepage, and fetching it would be reading
        # LinkedIn. identity.assess says so; there is nothing to fetch.
        return None, UNVERIFIED, None

    html, outcome = fetch_optional(company.website)
    if html is None:
        return None, outcome, None

    text = extract(html)
    page = visible_text(html)
    if len(text) < MIN_PAGE_CHARS:
        return None, THIN, page
    return text, "ok", page


def _fetch_all(companies: list[Company]) -> list[tuple[Company, str | None, str, str | None]]:
    """Every homepage, concurrently.

    Concurrency is the polite option here, not the rude one. base.py paces requests
    globally at one a second, which is right for four scrapers walking four sites
    repeatedly; this walks two hundred different sites and visits each exactly once,
    so no single server sees more than one request in the entire run however fast the
    pool goes. Serialising it would spend twenty minutes being slow at nobody's
    benefit.
    """
    out: list[tuple[Company, str | None, str, str | None]] = []
    done = 0
    with concurrent.futures.ThreadPoolExecutor(max_workers=FETCHERS) as pool:
        futures = {pool.submit(read_homepage, company): company for company in companies}
        for future in concurrent.futures.as_completed(futures):
            company = futures[future]
            try:
                text, outcome, page = future.result()
            except Exception:  # noqa: BLE001 - a broken url is a fact about the company
                text, outcome, page = None, UNREACHABLE, None
            out.append((company, text, outcome, page))
            done += 1
            if done % 50 == 0:
                print(f"  {done}/{len(companies)} fetched")
    return out


# --- asking ------------------------------------------------------------------


def _schema() -> dict:
    return {
        "type": "json_schema",
        "schema": {
            "type": "object",
            "properties": {
                # Whether the page said at all, asked as its own field rather than
                # inferred from an empty string. A model given one place to put an
                # answer will put something there.
                "said": {"type": "boolean"},
                "builds": {"type": "string"},
            },
            "required": ["said", "builds"],
            "additionalProperties": False,
        },
    }


def _prompt(company: Company, text: str) -> str:
    return f"Company name: {company.name}\nHomepage: {company.website}\n\nPage text:\n{text}"


def _ask(client: anthropic.Anthropic, company: Company, text: str, usage: classify.Usage, lock: threading.Lock) -> Product:
    response = client.messages.create(
        model=MODEL,
        max_tokens=MAX_TOKENS,
        system=SYSTEM,
        messages=[{"role": "user", "content": _prompt(company, text)}],
        output_config={"format": _schema()},
    )
    with lock:
        usage.add(response)

    answer = json.loads(next(block.text for block in response.content if block.type == "text"))
    if not answer.get("said"):
        return Product(status=UNCLEAR)
    said = clean(answer.get("builds"))
    return Product(status=DESCRIBED, product=said) if said else Product(status=UNCLEAR)


# --- cache -------------------------------------------------------------------


def _fingerprint(company: Company, text: str) -> str:
    """Identity of the question, not of the company.

    The homepage text is in here, so a company that rewrites its front page gets
    re-read and one that has not does not. The model and the prompt version are in
    here for the same reason they are in the classification cache: after either
    changes, answering from cache is answering a different question.
    """
    key = json.dumps([company.website, text, MODEL, PROMPT_VERSION], sort_keys=True)
    return hashlib.sha256(key.encode()).hexdigest()[:16]


def _load() -> dict:
    try:
        return json.loads(CACHE_PATH.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def _save(entries: dict) -> None:
    CACHE_PATH.parent.mkdir(parents=True, exist_ok=True)
    CACHE_PATH.write_text(json.dumps(entries, indent=1, sort_keys=True), encoding="utf-8")


# --- the run -----------------------------------------------------------------


def candidates(companies: list[Company]) -> list[Company]:
    """The ones worth fetching: a website we have not already answered from cache."""
    return [c for c in companies if c.website]


def _gate(company: Company, text: str | None, outcome: str, page: str | None, shared: set[str]) -> str | None:
    """Decide whose website this is, write it onto the company, and say what to do.

    Returns the product status to record without reading, or None when the page is
    verified, readable, and worth the model call. Decided before any money is spent:
    an unverified page is never sent, so its sentence can never be bought.
    """
    state, note = identity.assess(
        company.name,
        company.website,
        company.description,
        text,
        shared,
        description_is_label=company.description_is_label,
        name_text=page,
    )
    company.website_identity, company.website_identity_note = state, note
    if text is None:
        return outcome
    return None if state == identity.VERIFIED else UNVERIFIED


def enrich(
    companies: list[Company],
    *,
    max_cost: float | None = None,
    limit: int | None = None,
    shared: set[str] | None = None,
) -> tuple[dict[str, Product], classify.Usage]:
    """Read every homepage we can reach and say what each company builds.

    Two phases, and the order is the point. Fetching is sequential because it is
    somebody else's server and base.py paces it at one call a second; it is also
    free, so doing all of it first means the budget is spent knowing exactly how many
    readable pages there are rather than guessing mid-run. Then the reading, in
    parallel, because that part is ours to wait on.
    """
    usage = classify.Usage()
    ceiling = classify.max_cost(max_cost)
    results: dict[str, Product] = {}

    todo = candidates(companies)
    if limit is not None:
        todo = todo[:limit]
    if not todo:
        return results, usage
    # Across everything the run scraped, not just this slice: two records giving one
    # address is visible only when both are in view.
    if shared is None:
        shared = identity.shared_hosts(companies)

    cache = _load()

    # Phase one: fetch. Free, and cached on disk for 30 days by base.py.
    print(f"Reading {len(todo)} homepages")
    pages: list[tuple[Company, str]] = []
    for company, text, outcome, page in _fetch_all(todo):
        held = _gate(company, text, outcome, page, shared)
        if held is not None:
            results[company.id] = Product(status=held, source="fetch" if text is None else "identity")
            continue

        entry = cache.get(company.id)
        if entry and entry.get("hash") == _fingerprint(company, text):
            results[company.id] = Product(status=entry["status"], product=entry.get("product"), source="cache")
            usage.cached += 1
            continue
        pages.append((company, text))

    unreadable = sum(1 for p in results.values() if p.source == "fetch")
    unverified = sum(1 for p in results.values() if p.source == "identity")
    print(
        f"  {len(pages)} to read, {usage.cached} already answered, {unreadable} gave us nothing to read, "
        f"{unverified} not read because the address could not be confirmed as theirs"
    )
    if not pages:
        return results, usage

    # Phase two: ask. Same ceiling discipline as classification — reserve for calls
    # in flight, so six workers cannot all pass the check at zero and then spend
    # six times the remaining budget between them.
    client = anthropic.Anthropic()
    lock = threading.Lock()
    stop = threading.Event()
    in_flight = 0

    def work(company: Company, text: str) -> tuple[Company, str, Product]:
        nonlocal in_flight
        if stop.is_set():
            raise classify.Aborted()
        with lock:
            if usage.cost + (in_flight + 1) * COST_PER_COMPANY > ceiling:
                raise classify.BudgetReached()
            in_flight += 1
        try:
            # The text travels back with the answer: the cache key is built from it,
            # and a Company is not hashable, so it cannot be looked up again by one.
            return company, text, _ask(client, company, text, usage, lock)
        except BaseException as error:
            if classify.fatal_reason(error):
                stop.set()
            raise
        finally:
            with lock:
                in_flight -= 1

    failures: list[tuple[str, str]] = []
    fatal: str | None = None
    with concurrent.futures.ThreadPoolExecutor(max_workers=WORKERS) as pool:
        futures = [pool.submit(work, company, text) for company, text in pages]
        for future in concurrent.futures.as_completed(futures):
            try:
                company, text, product = future.result()
            except classify.BudgetReached:
                usage.over_budget += 1
                continue
            except classify.Aborted:
                usage.never_attempted += 1
                continue
            except Exception as error:  # noqa: BLE001 - reported, not swallowed
                reason = classify.fatal_reason(error)
                if reason and fatal is None:
                    fatal = reason
                usage.failed += 1
                failures.append(("?", str(error)[:120]))
                continue

            results[company.id] = product
            # Written as they arrive, not at the end: a run killed at company 140
            # must not throw away 139 answers it has already paid for.
            with lock:
                cache[company.id] = {
                    "hash": _fingerprint(company, text),
                    "status": product.status,
                    "product": product.product,
                    "model": MODEL,
                    "prompt_version": PROMPT_VERSION,
                }
                _save(cache)

    if failures:
        print(f"  {len(failures)} could not be read, e.g. {failures[0][1]}")
    if usage.over_budget:
        print(
            f"  STOPPED at the ${ceiling:.2f} ceiling after ${usage.cost:.4f}: "
            f"{usage.over_budget} homepages left unread. They are not lost — the next "
            f"run picks them up, and everything already answered is cached."
        )
    if fatal:
        raise classify.ConfigurationError(
            f"Reading stopped: {fatal}. The answers this run did buy are cached."
        )

    return results, usage


# Every outcome where something answered at the address. A page that refused us, drew
# itself in JavaScript or said nothing useful is still a website a person can visit,
# which is all Part 9 asks of "a live website". Only a dead domain is not.
ANSWERED = frozenset({DESCRIBED, REFUSED, THIN, UNCLEAR, UNVERIFIED})

# Part of the signal's UNIQUE key, so it must never be reworded casually: a new label
# is a second trace for every company that already has the first.
WEBSITE_LABEL = "website live"


def website_traces(companies: list[Company], products: dict[str, Product]) -> list[Signal]:
    """A trace for every company whose homepage answered when we fetched it.

    Free: this is the fetch enrich() already made, read for a second fact. A company
    missing from `products` gets nothing rather than a guess. That is one whose page
    was readable but the night's ceiling stopped before the read, and it picks up its
    trace on the next run, from cache.

    The other direction is the Worker's job. A signal is INSERT OR IGNORE and nothing
    here can withdraw one, so a company that arrives 'unreachable' has its website
    trace removed server-side; otherwise a domain that lapsed would keep counting as
    live forever.
    """
    traces = []
    for company in companies:
        product = products.get(company.id)
        # Theirs, as far as we can tell: a stranger's homepage answering is not a trace
        # of this company. 'associated' counts — the source record gives the address
        # and nothing contradicts it — which is the same bar a scraped website field
        # has always had to meet. 'discovered' does not.
        theirs = company.website_identity in (identity.ASSOCIATED, identity.VERIFIED)
        if company.website and theirs and product is not None and product.status in ANSWERED:
            traces.append(
                Signal(
                    company_id=company.id,
                    type="website",
                    label=WEBSITE_LABEL,
                    url=company.website,
                )
            )
    return traces


def apply(companies: list[Company], products: dict[str, Product]) -> None:
    """Put the answers on the companies, so upload carries them."""
    for company in companies:
        product = products.get(company.id)
        if product is None:
            continue
        company.product_status = product.status
        company.product = product.product if product.described else None


# --- pricing and the command line -------------------------------------------


def estimate(companies: list[Company]) -> str:
    """What reading these would cost, counted through count_tokens rather than guessed.

    The fetching happens for real, because it is free and because the only honest
    answer to "what will this cost" is one that knows how many pages actually have
    anything on them.
    """
    todo = candidates(companies)
    if not todo:
        return "No company here publishes a website. Nothing to read, and nothing to spend."

    cache = _load()
    pages: list[tuple[Company, str]] = []
    outcomes: dict[str, int] = {}
    shared = identity.shared_hosts(companies)
    for company, text, outcome, page in _fetch_all(todo):
        held = _gate(company, text, outcome, page, shared)
        if held is not None:
            outcomes[held] = outcomes.get(held, 0) + 1
            continue
        entry = cache.get(company.id)
        if entry and entry.get("hash") == _fingerprint(company, text):
            outcomes["cached"] = outcomes.get("cached", 0) + 1
            continue
        pages.append((company, text))

    breakdown = ", ".join(f"{n} {name}" for name, n in sorted(outcomes.items()))
    if not pages:
        return f"Nothing to read: {breakdown or 'every homepage is already answered'}. A re-run costs $0.00."

    client = anthropic.Anthropic()
    sample = pages[: min(12, len(pages))]
    tokens = 0
    try:
        for company, text in sample:
            tokens += client.messages.count_tokens(
                model=MODEL,
                system=SYSTEM,
                messages=[{"role": "user", "content": _prompt(company, text)}],
                output_config={"format": _schema()},
            ).input_tokens
    except Exception as error:  # noqa: BLE001
        reason = classify.fatal_reason(error)
        if reason:
            raise classify.ConfigurationError(f"Cannot price the run: {reason}.") from None
        raise

    per_in = tokens / len(sample)
    total_in = per_in * len(pages)
    total_out = 130 * len(pages)
    cost = (total_in * classify.PRICE_IN + total_out * classify.PRICE_OUT) / 1_000_000
    return (
        f"{len(todo)} companies publish a website. {len(pages)} have a readable homepage "
        f"not yet answered; {breakdown or 'nothing else'}.\n"
        f"About {per_in:,.0f} input tokens each, 130 out assumed: "
        f"${cost:.2f} to read all {len(pages)}."
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--estimate", action="store_true", help="price the run and spend nothing")
    parser.add_argument("--limit", type=int, help="only the first N companies with a website")
    parser.add_argument("--max-cost", type=float, help=f"stop after this much (default {classify.DEFAULT_MAX_COST})")
    args = parser.parse_args()

    from ingest.run import scrape_all

    by_source, _, _, _ = scrape_all()
    seen: set[str] = set()
    companies: list[Company] = []
    for source in by_source:
        for company in by_source[source]:
            if company.id not in seen:
                seen.add(company.id)
                companies.append(company)

    # The same narrowing run.py does, and for the same reason: a company the taxonomy
    # has no cell for is not a row on the page, so it has nowhere to put a product
    # sentence. Classification is answered entirely from its own cache here and costs
    # nothing; without it this would price a third more websites than the pipeline
    # will ever read.
    placements, _ = classify.classify(companies, cost_limit=0.0)
    companies = [c for c in companies if (placements.get(c.id) is not None and placements[c.id].on_map)]
    print(f"{len(companies)} of them reach the page and can carry a product line")

    if args.estimate:
        print(estimate(companies))
        return 0

    products, usage = enrich(companies, max_cost=args.max_cost, limit=args.limit)
    described = sum(1 for p in products.values() if p.described)
    print(f"\n{described} of {len(products)} answered. {usage}")
    for company in companies[:10]:
        product = products.get(company.id)
        if product and product.described:
            print(f"  {company.name}: {product.product}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
