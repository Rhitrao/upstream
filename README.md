# Upstream

**Live at [rohitrao.in/upstream](https://rohitrao.in/upstream)** · source at
[github.com/Rhitrao/upstream](https://github.com/Rhitrao/upstream) · public data only · every claim
links to where it came from

## The inversion

Every list of startups ranks by how impressive a company looks: funding, press, investors,
founders' pedigree. Those signals become public at the same moment for everyone. Incubator and
grant records do not work that way: **some early-stage companies appear in them before they are
easy to find anywhere else.** That is a claim about what public records contain and when, and it
is the only claim this project makes about sourcing.

Upstream ranks the other way round from the lists above. **One incubator listing and no website
beats a known name and a press cycle.** Two facts decide where a company sits: how recently it
first appeared in a public record, and how few public traces it has left. No score, no pedigree,
nothing about the founder's degree or the investor. It will sometimes put a company nobody has
heard of above a famous one. That is the point.
([001](docs/decisions/001-rank-by-obscurity.md))

The page counts substance, not coverage. It opens on the records a published sentence describes and
counts the rest — register labels, research projects, unverified names — beside that number rather
than inside it. Under the headline, findings about Indian deep-tech sourcing, each number a link to
the rows that prove it. Every row carries a brief to copy: what it builds, why it is here, the open
questions, the evidence, its limits and a next step.

## The figures, as of 17 September 2026

One dated set of counts, taken from the database as the ingest run of `2026-09-17T08:58:42Z` left
it. The same table is on the [methodology page](https://rohitrao.in/upstream/about#snapshot), from
the same source file (`src/snapshot.ts`), so the two cannot drift apart. The live site shows counts
that move every night; these do not, and every argument below rests on these.

| Number | As of 17 Sep 2026 | What it counts |
| --- | --- | --- |
| **Sources** | 8 configured, 7 contributing | Scrapers in the pipeline. One of the eight (the NM-ICPS technology hubs list) had put no record on the page by this date, so seven is the number that earned a row. |
| **Records seen** | 2,218 | Records read from those sources. Not companies: a record can be a research project or a name with nothing behind it. **Treat this as an upper bound** — duplicates are folded only where two names match once punctuation and legal suffixes are removed, or where a person read the pair and wrote it into `ingest/aliases.json`. Two sources spelling one company differently enough to defeat that test are still two records here. |
| **Placed** | 753 | Records given a row on the page and one of the 44 RDI sub-sectors. These are the only records the page shows. They fall in 36 of the 44 sub-sectors. |
| **Dropped** | 1,465 | Records read but not placed, each kept in the `gaps` table with the reason. Dropped is not rejected: most were too thinly described to classify, not judged uninteresting. |
| **Companies** | 618 | Placed records whose entity type is a company. The other 135 are unverified names, research projects and one laboratory, counted beside the companies and never inside them. |
| **Described** | 525 | Placed records carrying a published sentence saying what they do — 180 quoted from a website confirmed as theirs, 345 from the source that listed them. The remaining 228 have only a register or grant label. |

Placed and dropped account for every record seen (753 + 1,465 = 2,218), and companies for every
record placed (618 + 135 = 753).

**If the live site is down, the evidence is still here.** All 753 placed records, with their
evidence columns, are committed as [`docs/snapshot-2026-09-17.csv`](docs/snapshot-2026-09-17.csv)
and described in [`docs/snapshot-2026-09-17.md`](docs/snapshot-2026-09-17.md). Nothing in this
README depends on a scrape completing.

It only works if the page is honest about what it does not know, so it names its gaps instead of
filling them: "No description published", "founding year unknown", "website not confirmed as
theirs". The company page has a section called *What is not known*, and the brief you can copy from
it puts that section above the evidence.

## Two findings about the taxonomy

Companies are placed in the Government of India's RDI Scheme taxonomy — 5 sunrise sectors, 44
sub-sectors — rather than a list of my own, because an empty cell in the government's list means
something and an empty cell in mine would not. ([005](docs/decisions/005-rdi-taxonomy.md))

**1. Where the scheme's priorities and these records meet is narrower than the scheme is.** On 17 September 2026,
**8 of the 44 sub-sectors held no record** — among them modular nuclear reactors, fusion,
seaweed-based energy, methane capture, ocean farming and photonics. In the other direction, 1,465
records were read and dropped without reaching a sub-sector at all. The largest clusters are
computer vision applications, IoT platforms, enterprise AI, renewable energy infrastructure and
drones.

**An empty cell is not a finding about the market.** It has two possible causes and this project
cannot currently tell them apart: either nobody in India is building there, or the eight sources do
not reach that work. Incubator portfolios and a startup register are not where fusion or ocean
farming would show up first, so for several of the empty cells the second explanation is the more
likely one. Neither count has been reviewed by hand. They are places to look, not proof.

**2. One classifier run suggests the two government vocabularies may not line up.** DPIIT's startup
register files companies under 56 industries picked by the founder from a dropdown; the RDI scheme
was written by another department. On **one run, on 14 September 2026, with one model and one
prompt**, where the two vocabularies have a near-twin a company placed almost automatically —
"Robotics" placed 79 of 80 — and where they have none almost nothing did: 3 of 87 for "Computer
Vision", 7 of 83 for "AI". The same run also showed the risk in the other direction: "AI / NLP" had
put five companies in AI in Healthcare. Since 14 September a register label places a company only
where it names the sub-sector outright, which withdrew 157 placements, those five among them.
([008](docs/decisions/008-two-call-classification.md))

*This is n=1 and should be read that way.* It has not been re-run, not tried against a second model
or a second prompt, and not checked by hand against a reviewed crosswalk. A single classifier's
behaviour on one-line labels is weak evidence about two filing systems; the gap it points at may be
real, or may be an artefact of how one prompt read short strings on one day. It is worth rechecking
before anyone leans on it. Every other number in this README is from the 17 September snapshot.

## The funnel, every record accounted for

The database as of 17 September 2026, the same snapshot as the table above:

```
2,218  records seen (an upper bound: see the dedup caveat above)
  753  placed: given a row and one of the 44 RDI sub-sectors, in 36 of the 44
         618  entity type "company"
         135  unverified names, research projects, one laboratory
         ── of the 753, by whose words say what it does ──
         180  a sentence quoted from a website confirmed as theirs
         345  a sentence from the source that listed it
         228  a register or grant label only
1,465  dropped: read but not placed, each kept in `gaps` with the reason
```

753 + 1,465 = 2,218, and 618 + 135 = 753. "Dropped" is not "rejected": the great majority were too
thinly described to classify, not judged uninteresting.

Two more numbers about what "early" means here. Of the 753 records, **49** were discovered — seen
for the first time in a later run of a source already being watched. The rest came from a source's
first sweep, which is a backfill and not a find
([003](docs/decisions/003-first-seen-honesty.md)). **21 of those 49 were register records with
nothing but a label**, which is why a label alone no longer qualifies for Tier A or B. And **384 of
the 753** had left one public trace or none.

## What it misses

Measured, not guessed. All figures below are from the same 17 September 2026 snapshot.

- **This tool cannot identify or verify stealth companies at all.** That is the honest statement, and
  it is a limit, not a feature. Reading no LinkedIn is a chosen constraint — every claim must link to
  a page anyone can open — but it should not be read as evidence about stealth companies in either
  direction. A company with no public record does not appear here, and nothing here indicates whether
  such companies are few or many. ([006](docs/decisions/006-no-linkedin.md))
- **Eight sources, seven of them contributing.** Five incubators (SINE IIT Bombay, IIT Madras
  Incubation Cell, Venture Center, FSID at IISc, TIDES at IIT Roorkee), grant programmes typed up by
  hand, and the newest pages of the DPIIT register. The eighth, the NM-ICPS innovation hubs list, is
  configured but has put no record on the page. No patents, no MCA incorporations, no other
  incubators. Tidy portfolio pages are over-represented.
- **Founders only where an incubator names them; no funding, revenue or registration numbers.** 343
  of 753 rows carry founder names an incubator prints, attributed to that card. `cin` is empty on
  every row, so nothing joins to MCA filings, and the grant lists publish no amounts.
- **Being on the DPIIT register is not being recognised.** Of the 196 rows with a register record,
  140 were recognised, 52 had a Startup India profile DPIIT never recognised, and 4 had lapsed. Each
  row says which.
- **Contact and domain age only from a website checked to be theirs.** 235 of 753 rows have an
  address on the company's own domain or a contact page; 341 have the domain's RDAP registration
  date. A domain's age is not the company's. .co and .io have no public RDAP service, so those
  domains have no date. The Wayback Machine's first copy of the homepage is shown the same way, as
  when the public web noticed the page; neither date ever dates the row. The archive is often down,
  so a failed lookup is kept as a failure and asked again, never as "not archived".
- **Most rows cannot say what the company builds in its own words.** Only a homepage checked to be
  theirs is read, and what it says is quoted as their words. 180 of 753 rows have such a sentence;
  408 publish a website at all, and 368 of those have been confirmed as the company's own.
  ([009](docs/decisions/009-homepage-product-read.md))
- **Location is known for fewer than half.** 233 of 753 rows have a state, 196 of them because the
  DPIIT register publishes one. The state tiles say how many are unknown.
- **Duplicates are caught only two ways.** A company two sources spell differently is folded into one
  row when the names match once punctuation and legal suffixes are gone, or when a person has read
  the pair and written it into `ingest/aliases.json` with the reason
  ([near-duplicates](docs/near-duplicates-2026-09-15.md)); a pair nobody has read stays two rows.
- **Winning a grant pushes a company down.** A grant is a public trace, and the list sorts by fewest
  traces, so the week a company wins one it drops below companies nobody has funded — the week it is
  most worth a call. This is a flaw in ranking by obscurity, not a trade-off being defended.
- **Classification is automated.** A model places each company from what its sources say. The page
  prints its reasoning, labelled as reasoning and not evidence, beside every placement.

## Next, not built

**Nothing in this section is built.** These are research choices argued for and deliberately not
implemented, listed so the reasoning is on the record — not features, and not roadmap commitments.

- **Venture portfolios as a suppression signal, not a source.** *Not implemented; no VC portfolio
  page is read today and no row is suppressed by one.* The argument for doing it: a company on a
  VC's portfolio page (Speciale Invest, pi Ventures, Blume and the rest) has already been found by a
  fund, which is the one thing this list exists to get ahead of. Those pages would be read only to
  disqualify — a company appearing on one would leave the obscurity ranking. Nothing from them would
  be added, and nothing shown except the fact and the link.

## How it works

```
  GitHub Actions, 03:00 UTC daily (Python)            Cloudflare Worker + D1 (TypeScript)
  scrape 8 sources → classify → read homepages   ──►  /upstream              the tool
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
