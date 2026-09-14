# Upstream

**Live at [rohitrao.in/upstream](https://rohitrao.in/upstream)** · public data only · every claim links to where it came from

## The inversion

Every list of startups ranks by how impressive a company looks: funding, press, investors,
founders' pedigree. That is why every fund keeps finding the same twenty names — the signals are
public at the same moment for everyone.

Upstream ranks the other way. **One incubator listing and no website beats a known name and a press
cycle.** Two facts decide where a company sits: how recently it first appeared in a public record,
and how few public traces it has left. No score, no pedigree, nothing about the founder's degree or
the investor. It will sometimes put a company nobody has heard of above a famous one. That is the
point. ([001](docs/decisions/001-rank-by-obscurity.md))

It only works if the page is honest about what it does not know, so it names its gaps instead of
filling them: "No description published", "founding year unknown", "website not confirmed as
theirs". The company page has a section called *What is not known*, and the brief you can copy from
it puts that section above the evidence.

## Two findings about the taxonomy

Companies are placed in the Government of India's RDI Scheme taxonomy — 5 sunrise sectors, 44
sub-sectors — rather than a list of my own, because an empty cell in the government's list means
something and an empty cell in mine would not. ([005](docs/decisions/005-rdi-taxonomy.md))

**1. The scheme's priorities and the companies' public trail barely overlap.** Replaying the 14
September 2026 run under the current rules, 10 of the 44 sub-sectors had nothing in them, among
them modular nuclear reactors, fusion, seaweed-based energy, methane capture, ocean farming and
photonics. In the other direction, 560
companies fit a sector and no sub-sector in it. The largest clusters on the page are computer vision
applications, IoT platforms, enterprise AI, renewable energy infrastructure and drones. Neither
count has been reviewed by hand, so they are places to look, not proof. An empty cell is also a
blind spot in five sources, not evidence that nothing exists.

**2. Two government vocabularies do not meet.** DPIIT's startup register files companies under 56
industries picked by the founder from a dropdown; the RDI scheme was written by another department.
Left to the classifier, where the two have a near-twin companies place almost automatically —
"Robotics" placed 79 of 80 — and where they have none almost nothing does: 3 of 87 for "Computer
Vision", 7 of 83 for "AI". That is a finding about two filing systems as one model reads one-line
labels, not a reviewed crosswalk. It also showed the risk: "AI / NLP" had put five companies in AI in
Healthcare. Since 14 September a register label places a company only where it names the sub-sector
outright, which withdrew 157 placements in the replay below, those five among them. ([008](docs/decisions/008-two-call-classification.md))

## The funnel, one run, every number accounted for

The ingest run of 14 September 2026, replayed at $0 from the committed cache with the current rules:

```
1,708  listings read from five public sources
  −45  the same company in two or three sources
1,663  distinct companies
  −69  not yet classified: 65 Venture Center companies left at run #3's $0.45 ceiling,
       and 4 DPIIT records that arrived after it
1,594  classified
         582  placed in one of the 44 sub-sectors
                418  from a description of what the company does
                164  from a register label that names that sub-sector outright
         560  fit a sector, no sub-sector in it          → "Unmapped" on the page
         304  too thinly described to place                → "Could not describe"
                157  of these the model had placed from a label that does not name the cell
         148  fit no sunrise sector at all
```

582 + 560 + 304 + 148 = 1,594. The page counts from its own database, which also keeps companies a
source has since stopped listing, so its totals run a little higher than one run's.

Two more numbers about what "early" means here, from the live database after that night's run
withdrew the label guesses. Of 607 records on the page, **25** were discovered — seen for the first time in a later run of a source
already being watched; the rest came from a source's first sweep, which is a backfill and not a
find ([003](docs/decisions/003-first-seen-honesty.md)). **23 of those 25 were register records with
nothing but a label**, which is why a label alone no longer qualifies for Tier A or B. And **372 of
607** had left one public trace or none.

## What it misses

Measured, not guessed.

- **No LinkedIn, so no stealth companies.** A chosen constraint: every claim must link to a page
  anyone can open, and LinkedIn is the network this list is trying to get ahead of.
  ([006](docs/decisions/006-no-linkedin.md))
- **Five sources.** Three incubators (SINE IIT Bombay, IIT Madras RTBI, Venture Center), two grant
  programmes typed up by hand, and the newest pages of the DPIIT register. No patents, no MCA
  incorporations, no other incubators. Tidy portfolio pages are over-represented.
- **Founders only where an incubator names them; no funding, revenue or registration numbers.** 298
  of 607 rows carry the founder names SINE IIT Bombay, Venture Center or IITM RTBI print, attributed
  to that card. `cin` is empty on every row, so nothing joins to MCA filings, and the grant lists
  publish no amounts.
- **Being on the DPIIT register is not being recognised.** Of the 191 register rows with a cached
  record on 14 September, 130 were recognised, 58 had a Startup India profile DPIIT never
  recognised, and 3 had lapsed. Each row now says which; until then all of them read "DPIIT recognised".
- **Contact and domain age only from a website checked to be theirs.** An address on the company's
  own domain or a contact page, from 143 of 190 readable verified homepages, and the domain's RDAP
  registration date for 208 of 220 domains. A domain's age is not the company's. .co and .io have no
  public RDAP service, so those domains have no date.
- **Most rows cannot say what the company builds.** Only a homepage checked to be theirs is read, and
  what it says is quoted as their words. 115 of 607 rows have such a sentence; 252 publish a website
  at all. ([009](docs/decisions/009-homepage-product-read.md))
- **Location is known for fewer than half.** 234 of 607 rows have a state, 197 of them because the
  DPIIT register publishes one. The state tiles say how many are unknown.
- **Duplicates are caught only two ways.** A company two sources spell differently is folded into one
  row when the names match once punctuation and legal suffixes are gone, or when a person has read
  the pair and written it into `ingest/aliases.json` with the reason. Seven pairs were found and folded
  on 14 September ([near-duplicates](docs/near-duplicates-2026-09-14.md)); a pair nobody has read stays two rows.
- **Winning a grant pushes a company down.** A grant is a public trace, and the list sorts by fewest
  traces, so the week a company wins one it drops below companies nobody has funded — the week it is
  most worth a call. This is a flaw in ranking by obscurity, not a trade-off being defended.
- **Classification is automated.** A model places each company from what its sources say. The page
  prints its reasoning, labelled as reasoning and not evidence, beside every placement.

## How it works

```
  GitHub Actions, 03:00 UTC daily (Python)            Cloudflare Worker + D1 (TypeScript)
  scrape 5 sources → classify → read homepages   ──►  /upstream              the tool
       cached pages     Claude Haiku 4.5, cached       /upstream/c/:slug      one company, as a brief
       30 days          under a $ ceiling              /upstream/api/*        JSON
                        answers committed to git       /upstream/export.csv   the current view
```

- **The page** is server-rendered HTML from one Worker on `rohitrao.in/upstream*`. Search and filters
  sit above the list, every view has a canonical shareable URL, and the list, its counts and the CSV
  come from one query definition. Shortlist, seen and pass are stored in the reader's browser only.
- **Ingestion runs on GitHub**, not in the Worker, and posts to the Worker with a key.
  ([007](docs/decisions/007-ingestion-on-github.md))
- **Money.** Model calls are the only cost. Every answer is cached against a hash of what was sent and
  committed, so a re-run pays only for companies it has not seen, and every run stops at a dollar
  ceiling. Classification costs about $0.003 a company.
- **Tests** run against the real migrations in Miniflare (`npx vitest run`) and the ingest's own unit
  tests (`python3 -m unittest discover -s ingest/tests -t .`).

### Run it locally

Node 20+ and Python 3.12.

```sh
npm install
npx wrangler d1 migrations apply upstream --local
npx wrangler dev                                    # http://localhost:8787/upstream?demo=1 for sample data

pip install -r requirements.txt
echo 'INGEST_KEY=any-local-secret' > .dev.vars      # then restart wrangler dev
export ANTHROPIC_API_KEY=...                        # the client wants one even when every answer is cached
python -m ingest.run --dry-run --max-cost 0         # scrapes and classifies from the cache, spends nothing
python -m ingest.run --base-url http://localhost:8787/upstream --max-cost 0
```

## Decisions

Each says what was decided, what else was considered, and what was given up.

1. [Rank by obscurity, and refuse to score](docs/decisions/001-rank-by-obscurity.md)
2. [Old companies are ingested, not listed](docs/decisions/002-age-gate.md)
3. [A backfill is not a discovery](docs/decisions/003-first-seen-honesty.md)
4. [A private notebook on a public page](docs/decisions/004-private-notes.md)
5. [The government's 44 sub-sectors, not a list of our own](docs/decisions/005-rdi-taxonomy.md)
6. [No LinkedIn](docs/decisions/006-no-linkedin.md)
7. [Ingestion runs on GitHub Actions, not in the Worker](docs/decisions/007-ingestion-on-github.md)
8. [Classify in two calls, stop where the evidence stops, and cap the spend](docs/decisions/008-two-call-classification.md)
9. [What a company says it builds is quoted, attributed, and read only from a site that is theirs](docs/decisions/009-homepage-product-read.md)
