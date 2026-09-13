# Upstream

**Live at [rohitrao.in/upstream](https://rohitrao.in/upstream)**

Upstream lists early-stage Indian deep-tech companies, sorted by how few people know about them.
Every company is placed against the Government of India's RDI Scheme taxonomy (5 sectors, 44
sub-sectors) and carries the public evidence that put it on the list, with links. There is no score
on any row. It shows facts, and says so when it doesn't have them.

## Why obscurity first

Most funds find deep-tech companies the same way: a funding announcement, a database entry, a press
mention. All of those happen at about the same time, and by then it is late, because every fund can
see the company. A deep-tech company leaves a public trail well before that. An incubator lists it, a
grant panel funds it, a government register recognises it. Upstream reads that trail and ranks it
backwards: **one incubator listing and no website beats a known name and a press cycle.** Two facts
decide where a company sits: how recently it was first seen, and how many public traces it already
has. Nothing about the founder's degree, the institution or the investor goes in. Pedigree is the
most-tracked attribute in Indian startup data, and ranking by it would rebuild a list that already
exists. This will sometimes put a company nobody has heard of above a famous one. That is on
purpose. The full argument is in [`docs/decisions/001-rank-by-obscurity.md`](docs/decisions/001-rank-by-obscurity.md).

## How it is shaped

Three pieces, kept separate so any one of them can break without taking down the others.

```
  ┌──────────────────────────────────────────────────────────┐
  │  INGESTION: Python, GitHub Actions, 03:00 UTC daily      │
  │                                                          │
  │  scrape  →  classify  →  read homepage  →  upload        │
  │  4 sources  Claude Haiku  what they build   HTTPS POST   │
  │             (cached)      (cached)                       │
  └────────────────────────────┬─────────────────────────────┘
                               │ once a day, keyed
                               ▼
  ┌──────────────────────────────────────────────────────────┐
  │  DATABASE: Cloudflare D1                                 │
  │  companies · signals · runs · gaps · notes               │
  └────────────────────────────┬─────────────────────────────┘
                               │
                               ▼
  ┌──────────────────────────────────────────────────────────┐
  │  SITE: one Cloudflare Worker on rohitrao.in/upstream*    │
  │  /upstream           the list and the coverage map       │
  │  /upstream/c/:slug   one page per company                │
  │  /upstream/api/*     companies, coverage, gaps as JSON   │
  │  /upstream/export.csv  the current view, as a file       │
  │  /upstream/notes     private; 404s until Access is set   │
  └──────────────────────────────────────────────────────────┘
```

Ingestion runs on GitHub rather than on Cloudflare because scraping takes minutes and a Worker gets
seconds of CPU. The Worker never scrapes, so page loads never wait on a slow source. It is a Worker
route rather than a Pages project because `/upstream` is a path on a domain that already serves a
portfolio, and only a route can claim a path.

The two model steps are the only things that cost money, and both are cached in the repo
(`ingest/cache/classify.json`, `ingest/cache/products.json`). The nightly job commits whatever it paid
for, so a re-run spends nothing on companies it has already seen. Every run has a hard spend ceiling
(`UPSTREAM_MAX_COST`, $0.05 by default), so a source that suddenly returns five thousand rows stops at
a known cost.

## Where the data comes from

Five public sources, none behind a login:

| Source | What it gives |
|---|---|
| [SINE, IIT Bombay](https://www.sineiitb.org/portfolio/) | incubator portfolio, with incubation year |
| [RTBI, IIT Madras](https://rtbi.in/incubationiitm/portfolio.html) | incubator portfolio |
| [Venture Center, Pune](https://www.venturecenter.co.in/startups-and-success-stories/startups) | incubator portfolio, with a sentence on what each company builds; its bracketed year is kept with its meaning marked unknown |
| [`ingest/sources/grants.csv`](ingest/sources/grants.csv) | BIRAC BIG rounds 21–24 and DST NIDHI-PRAYAS awardees, typed up from the published lists, each row linked to its list |
| [DPIIT Startup India](https://www.startupindia.gov.in/content/sih/en/search.html?roles=Startup) | the newest recognitions in deep-tech industries, read from the end of the register |

## Run it locally

You need Node 20+ and Python 3.12.

```sh
npm install
npx wrangler d1 migrations apply upstream --local
npx wrangler dev
```

Open <http://localhost:8787/upstream?demo=1> for the page with seven invented companies (it says so in a
banner), or `/upstream` for whatever your local database holds. Tests run against real migrations in
Miniflare:

```sh
npx vitest run
```

To fill the local database from the real sources:

```sh
pip install -r requirements.txt
echo 'INGEST_KEY=any-local-secret' > .dev.vars      # then restart wrangler dev
export ANTHROPIC_API_KEY=...                        # only needed for companies not already in the cache

python -m ingest.classify --estimate                # prices the run and spends nothing
python -m ingest.run --dry-run                      # scrapes and classifies, uploads nothing
python -m ingest.run --base-url http://localhost:8787/upstream
```

Scraped pages are cached on disk for 30 days, so debugging a parser doesn't send the source any
extra requests.

## What it misses

A fair amount. These are measured against the live database, not guessed.

- **Five sources is a narrow view.** Patent filings, new MCA incorporations and every incubator
  other than SINE, RTBI and Venture Center are not read. Incubators that publish tidy portfolio pages are
  over-represented, and quieter regional ones hardly show up at all.
- **No LinkedIn, and no stealth companies.** Proxycurl shut down in 2025 and scraping LinkedIn breaks
  its terms, so that gap is accepted. If a company hasn't appeared anywhere public, this can't see it.
- **Trace counts run low.** Incubator listings, grant awards, DPIIT recognitions and websites that
  answer a fetch are counted. A dead domain is not, and loses its trace when it stops answering. A
  press mention should count too, and nothing collects it yet.
- **No founding dates, no funding.** `cin` and `founded_year` are empty on every row. Without a CIN
  there is no join to MCA filings, so funding and financials are out of reach, and the grant lists
  don't publish award amounts. DPIIT rows are dated by when they were recognised, which is not when
  they were founded, and the page says which is which.
- **Almost none of the list was discovered by this.** 15 of 699 rows were. A company counts as
  discovered when it turns up in a later run of a source that was already being watched. Everything from a source's first sweep is
  a backfill and carries its published cohort year or no date at all. See
  [`003-first-seen-honesty.md`](docs/decisions/003-first-seen-honesty.md).
- **Classification is automated and will sometimes be wrong.** 843 companies seen per run don't place
  in any of the 44 sub-sectors. The page calls them unmapped under the current taxonomy and classifier,
  groups them by what the classifier said was missing or by the fact that their source never said what
  they do, and doesn't force either kind into the nearest cell. None of it has been reviewed by hand, so
  an unmapped group is a place to look for a gap in the taxonomy, not proof of one.
  Every DPIIT placement that rests on the register's dropdown label rather than a description says so
  on the company's page.
- **"What they build" is what a company says about itself.** It is read only from a homepage checked to
  be theirs: their own source record gives the address, no other record gives the same one, and their
  name is in the domain or on the page. A reachable URL proves nothing about whose it is; RTBI's page
  once gave an EV battery maker an identity-verification company's site. Of 209 websites, 180 pass, 21
  are theirs by the record but don't name them, and 8 aren't linked as anyone's. Every way a read
  failed is counted on the page by name.
- **An empty cell on the coverage map is our blind spot.** It isn't evidence that nothing exists
  there.
- **Winning a grant pushes a company down the list.** A grant award is a public trace, and the list is
  sorted by fewest traces, so the week a company wins one it falls below companies nobody has funded.
  That is the week it is most worth a call: the grant is the reason to get in touch. This is a real flaw
  in ranking by obscurity, not a trade-off being defended. Until the ranking can tell a trace that means
  "already found" from one that means "just became worth finding", read a recent grant on a row as a
  reason to look, whatever its position.

## Decisions

Each file says what was decided, what else was considered, why, and what would change the decision.

1. [Rank by obscurity, and refuse to score](docs/decisions/001-rank-by-obscurity.md)
2. [Old companies are ingested, not listed](docs/decisions/002-age-gate.md)
3. [A backfill is not a discovery](docs/decisions/003-first-seen-honesty.md)
4. [A private notebook on a public page](docs/decisions/004-private-notes.md)
