# BUILD.md — Upstream

**Read this whole file before writing any code.**

This is a step-by-step build guide. Every step has: what to do, why, the exact commands,
and a **checkpoint** telling you what you should be able to see before moving on. Do not
skip a checkpoint. If a checkpoint fails, fix it before continuing — a broken step three
makes step nine impossible to debug.

The companion file `rdi-taxonomy.json` in this repo is the complete sector list. It is
the backbone of the whole product. Read it before step 4.

---

## Part 0 — The goal, in plain English

We are building a public web page at **`rohitrao.in/upstream`**.

It lists early-stage Indian deep-tech companies, **sorted by how few people know about
them**. Every company is tagged against the Government of India's RDI Scheme taxonomy —
5 sectors, 44 sub-sectors — and every company carries the evidence that put it on the
list, with links.

The page also shows a **coverage map**: all 44 RDI sub-sectors in a grid, with how many
companies we have found in each. The empty squares are the interesting part. A
sub-sector the government has named a national priority with zero Indian startups in it
is a finding, not a gap in our data.

Three rules that drive every decision below:

1. **Rank by obscurity, not by pedigree.** A company with one incubator listing and no
   website beats one with a famous founder and press coverage.
2. **Show evidence, never a score.** No 0–100 number. Facts and links.
3. **Only public sources.** Nothing behind a login. Nothing against a site's terms.

---

## Part 1 — Your machine (ChromeOS)

You are on a Lenovo Chromebook. This matters, and the answer is **not** to install
things locally.

### Use GitHub Codespaces. This is the recommended path.

A Codespace is a full Linux machine running in a browser tab, with VS Code, a terminal,
Node, Python and Git already installed. It is free for personal accounts up to 120 compute
hours a month. Compute hours are billed at the machine's core count, so the 2-core
default uses them at twice the rate: that is roughly 60 hours of wall-clock time a
month, not 120. Enough for this project, if you stop the Codespace when you step away. Everything below assumes you are in a Codespace.

**Why not the ChromeOS Linux container (Crostini)?** It works, but Chromebooks are
typically 4–8 GB RAM, `npm install` is slow, and browser-based auth flows from inside
the container are fiddly. Codespaces removes all three problems and costs nothing.

### Setting it up

1. Go to `github.com`, create a **new public repository** called `upstream`.
   Tick "Add a README file" so the repo is not empty.
2. On the repo page click the green **Code** button → **Codespaces** tab →
   **Create codespace on main**.
3. Wait ~60 seconds. You now have VS Code in your browser with a terminal at the bottom.
4. In that terminal, check what you have:

```bash
node --version      # expect v20 or higher
python3 --version   # expect 3.10 or higher
git --version
```

5. Install the two things that are not preinstalled:

```bash
npm install -g wrangler
npm install -g @anthropic-ai/claude-code
```

6. Start Claude Code and point it at this file:

```bash
claude
```

Then tell it: `Read BUILD.md and rdi-taxonomy.json, then start at Part 3 Step 1.`

**CHECKPOINT 0:** You have a browser tab with a terminal, `wrangler --version` works,
and `claude` starts.

### One ChromeOS-specific gotcha, ahead of time

Later you will need to connect to Cloudflare. The normal command is `wrangler login`,
which opens a browser window and waits for a callback. **In a Codespace this often
fails**, because the callback goes to a URL inside the container that your browser
cannot reach.

**Do not use `wrangler login`.** Use an API token instead (Part 8, Step 1). It is one
extra step at the start and it removes the whole class of problem.

---

## Part 2 — How the finished thing is shaped

Three separate pieces. Separate on purpose: if one breaks, the others keep working.

```
  ┌──────────────────────────────────────────────────┐
  │  INGESTION — Python, runs in GitHub Actions      │
  │                                                  │
  │  scrape → normalise → classify → upload          │
  │  (per source)  (one shape) (Claude) (HTTP POST)  │
  └────────────────────────┬─────────────────────────┘
                           │ HTTPS, once a day
                           ▼
  ┌──────────────────────────────────────────────────┐
  │  DATABASE — Cloudflare D1 (SQLite at the edge)   │
  │  companies · signals · runs                      │
  └────────────────────────┬─────────────────────────┘
                           │ read only
                           ▼
  ┌──────────────────────────────────────────────────┐
  │  SITE — Cloudflare Worker                        │
  │  serves HTML + JSON API                          │
  │  route: rohitrao.in/upstream*                    │
  └────────────────────────┬─────────────────────────┘
                           ▼
                       visitor
```

**Why ingestion runs on GitHub, not on Cloudflare.** Workers have a CPU time limit of
a few seconds. Scraping ten websites takes minutes. A GitHub Action has no such limit
and full Python. (It runs on a cloud VM, not a residential connection; a scraper that only
works when it looks like a home browser is a scraper that should not be written.) It also logs every run publicly in
your repo, which is exactly what you want for a project meant to be inspected.

**Why the Worker never scrapes.** Page loads must be instant. All the slow work already
happened hours ago.

**Why `/upstream` is a Worker route, not a Pages project.** `rohitrao.in/upstream`
is a *path* on a domain you already use for your portfolio. Cloudflare Pages custom
domains work at the hostname level, so a second Pages project cannot claim a path.
A **Worker route** can: `rohitrao.in/upstream*` matches first and sends those
requests here. Your portfolio is untouched and the two deploy independently.

---

## Part 3 — Repo scaffold

### Step 1 — Create the Worker project

In the Codespace terminal, at the repo root:

```bash
npm create cloudflare@latest -- app --framework=none --lang=ts --no-git --no-deploy
```

Answer the prompts: **Hello World Worker**, **TypeScript**, **no** to deploy.

This makes an `app/` folder. Move its contents to the repo root so the repo is not
nested two levels deep:

```bash
mv app/* app/.* . 2>/dev/null; rmdir app
```

### Step 2 — Make the folders

```bash
mkdir -p public ingest/sources ingest/cache migrations docs/decisions .github/workflows
```

Final shape:

```
upstream/
├─ BUILD.md                  this file
├─ PRD.md                    the what and why
├─ rdi-taxonomy.json         the 44 sub-sectors — read by BOTH worker and ingest
├─ wrangler.toml             Cloudflare config
├─ src/index.ts              the Worker: HTML + API
├─ public/                   css, favicon
├─ migrations/               SQL files, numbered
├─ ingest/
│  ├─ run.py                 orchestrator
│  ├─ classify.py            Claude → RDI sector + sub-sector
│  ├─ upload.py              POST to the Worker
│  ├─ cache/                 classification cache (committed, saves money)
│  └─ sources/
│     ├─ base.py             shared scraper helpers
│     ├─ sine_iitb.py
│     ├─ iitm_rtbi.py
│     ├─ itic_iith.py
│     └─ grants_csv.py
├─ docs/decisions/           one file per real decision
└─ .github/workflows/ingest.yml
```

### Step 3 — Commit

```bash
git add -A && git commit -m "scaffold" && git push
```

**CHECKPOINT 3:** `ls` shows the folders above. The repo on github.com shows them too.

---

## Part 4 — The RDI taxonomy

**This is the most important step in the build. Do not simplify it.**

`rdi-taxonomy.json` contains all 5 sunrise sectors and all 44 sub-sectors, each with the
scheme's own list of project types. Total is roughly 250 project types.

### Why the full taxonomy matters

Anyone can tag a company "robotics". Tagging it **RDI 2.7 — Intelligent Systems &
Robotics → Autonomous navigation and perception** does three things a loose tag cannot:

1. It matches the government's own language, which is the language funds and policy
   people use when they talk about this money.
2. It makes **coverage measurable**. 44 sub-sectors is a denominator. "We have companies
   in 31 of 44" is a fact. "We cover robotics" is not.
3. The empty sub-sectors become the output. Sub-sector **1.11 Seaweed-Based Energy &
   Biochemical Alternatives** is a named national priority. If no Indian startup shows
   up in it, that absence is more interesting than any of the companies we did find.

### Step 1 — Load it in both places

The Worker and the ingestion scripts must read the **same file**. Do not copy it, do not
hard-code a shortened list in either place. If the two ever drift, the coverage map lies.

In the Worker (`src/index.ts`):

```ts
import taxonomy from "../rdi-taxonomy.json";
```

In Python:

```python
import json, pathlib
TAXONOMY = json.loads(
    (pathlib.Path(__file__).parent.parent / "rdi-taxonomy.json").read_text()
)
```

### Step 2 — Build the flat lookup

Both sides need a flat list for validation. Write a small helper in each language that
turns the nested JSON into:

```
[
  { sector_id: "1", sector: "Energy & Climate",
    subsector_id: "1.1", subsector: "Advanced Wind Energy Systems",
    projects: ["Offshore and vertical-axis turbine innovation"] },
  ...
]
```

There must be exactly **44 entries** for sunrise sectors, plus 2 from sector 6.

**CHECKPOINT 4:** A script prints `44 sunrise sub-sectors across 5 sectors, 46 total`.
If you get a different number, the JSON was edited or the flattening is wrong. Fix it
now — everything downstream counts on this.

---

## Part 5 — The database

### Step 1 — Create it

```bash
wrangler d1 create upstream
```

Copy the output block into `wrangler.toml`. It will look like:

```toml
[[d1_databases]]
binding = "DB"
database_name = "upstream"
database_id = "paste-the-id-here"
```

### Step 2 — Write the migration

`migrations/0001_init.sql`:

```sql
CREATE TABLE companies (
  id            TEXT PRIMARY KEY,     -- slug: verve-aerospace
  name          TEXT NOT NULL,
  description   TEXT,
  website       TEXT,
  city          TEXT,
  state         TEXT,
  cin           TEXT,                 -- MCA number, best join key
  founded_year  INTEGER,

  sector_id     TEXT,                 -- "2"
  subsector_id  TEXT,                 -- "2.7"
  project_type  TEXT,                 -- matched project string, nullable
  classify_note TEXT,                 -- why Claude chose it — audit trail

  first_seen    TEXT NOT NULL,        -- ISO date. NEVER overwrite this.
  trace_count   INTEGER DEFAULT 0,
  tier          TEXT DEFAULT 'C',
  updated_at    TEXT NOT NULL
);

CREATE TABLE signals (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id   TEXT NOT NULL REFERENCES companies(id),
  type         TEXT NOT NULL,   -- incubator|grant|patent|incorporation|website|press
  label        TEXT NOT NULL,   -- "SINE IIT Bombay cohort 2026"
  date         TEXT,
  url          TEXT,
  source       TEXT NOT NULL,
  found_at     TEXT NOT NULL,
  UNIQUE(company_id, type, label)    -- stops duplicate signals on re-runs
);

CREATE TABLE runs (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at     TEXT NOT NULL,
  source         TEXT NOT NULL,
  status         TEXT NOT NULL,   -- ok | failed
  records_found  INTEGER DEFAULT 0,
  error          TEXT
);

CREATE INDEX idx_companies_tier ON companies(tier, first_seen DESC);
CREATE INDEX idx_companies_sub  ON companies(subsector_id);
CREATE INDEX idx_signals_company ON signals(company_id);
```

### Step 3 — Apply it

```bash
wrangler d1 execute upstream --local  --file=./migrations/0001_init.sql
wrangler d1 execute upstream --remote --file=./migrations/0001_init.sql
```

**CHECKPOINT 5:**

```bash
wrangler d1 execute upstream --remote --command="SELECT name FROM sqlite_master WHERE type='table'"
```

prints `companies`, `signals`, `runs`.

### Note on `first_seen`

This field is the memory of when we were early. It is the only thing that eventually
proves the whole idea worked. **On re-ingest, never touch it.** Use SQL that writes it
only on insert:

```sql
INSERT INTO companies (id, name, first_seen, updated_at, ...)
VALUES (?, ?, ?, ?, ...)
ON CONFLICT(id) DO UPDATE SET
  name = excluded.name,
  description = COALESCE(excluded.description, companies.description),
  updated_at = excluded.updated_at
  -- first_seen deliberately absent
;
```

---

## Part 6 — The Worker

### Step 1 — Routes

`src/index.ts` handles four paths. Everything is under `/upstream` because that is
what the route sends us.

| Path | Returns |
|---|---|
| `GET /upstream` | the HTML page |
| `GET /upstream/api/companies` | JSON list, filters: `sector`, `subsector`, `tier`, `limit` |
| `GET /upstream/api/coverage` | company count per sub-sector, for the coverage map |
| `POST /upstream/api/ingest` | write endpoint, needs `X-Ingest-Key` header |

### Step 2 — The list query

```sql
SELECT c.*, 
  (SELECT json_group_array(json_object(
      'type', s.type, 'label', s.label, 'url', s.url, 'date', s.date))
   FROM signals s WHERE s.company_id = c.id) AS signals
FROM companies c
WHERE (?1 IS NULL OR c.sector_id = ?1)
  AND (?2 IS NULL OR c.subsector_id = ?2)
  AND (?3 IS NULL OR c.tier = ?3)
ORDER BY
  CASE c.tier WHEN 'A' THEN 0 WHEN 'B' THEN 1 ELSE 2 END,
  c.first_seen DESC
LIMIT ?4;
```

### Step 3 — The coverage query

This one powers the most distinctive part of the page. It must return **all 44
sub-sectors including the empty ones**, so build the full list from the taxonomy in
code and join the counts onto it — do not just `GROUP BY` the companies table, or empty
sub-sectors silently vanish and the map becomes a lie.

```sql
SELECT subsector_id, COUNT(*) AS n FROM companies GROUP BY subsector_id;
```

Then in TypeScript, walk the taxonomy and fill in `0` wherever the query returned
nothing.

### Step 4 — The ingest endpoint

```
POST /upstream/api/ingest
Header: X-Ingest-Key: <matches env.INGEST_KEY>
Body:   { "source": "sine_iitb",
          "companies": [ {...}, ... ],
          "signals":   [ {...}, ... ] }
```

Rules:
- Reject with 401 if the key does not match. Compare in constant time.
- Upsert companies per the `first_seen` rule above.
- Insert signals with `INSERT OR IGNORE` — the UNIQUE constraint handles repeats.
- Recompute `trace_count` and `tier` for every touched company (Part 9).
- Write one row to `runs`.
- Return `{ inserted: n, updated: n, signals_added: n }`.

**CHECKPOINT 6:** `npx wrangler dev`, then in a second terminal:

```bash
curl http://localhost:8787/upstream/api/coverage
```

returns JSON with 44 sub-sectors, all counts zero.

---

## Part 7 — The page

Server-rendered HTML from the Worker. **No React, no build step, no framework.** A
template string and a `<style>` block. This is a list of text and it must load instantly
on a phone.

### Layout, top to bottom

**1. Header.** Title, one sentence saying what this is, and three numbers: companies
tracked, added this week, sub-sectors covered out of 44.

**2. Coverage map.** A grid of 44 small cells grouped into the 5 sectors. Each cell
shows the sub-sector number, a shortened name, and the count. Cells with zero companies
are visibly empty — outlined, not filled. Clicking a cell filters the list below.

This is the thing that makes the page memorable. Build it properly.

**3. Filters.** Sector dropdown, tier toggle (A / A+B / all, default A+B). Nothing else.

**4. The list.** One row per company:

```
TIER A   Verve Aerospace Private Limited                    Bengaluru
         Small reusable launch vehicles for sub-orbital payloads.
         RDI 2.5 — Space Technologies
         SINE IIT-B cohort 2026 · incorporated 2026-03 · no website yet
                                                    first seen 12 days ago
```

- Evidence chips are links to the source page.
- "no website yet" is shown **as a positive**. Saying that out loud teaches the visitor
  how the ranking works, in four words, without a paragraph of explanation.

**5. Methodology.** Not hidden behind a link. Where the data comes from, how tiers are
decided, and an honest list of what this misses: no LinkedIn, no stealth companies, no
company that has not appeared anywhere public, and a bias toward institutions that
publish their portfolios.

That limitations paragraph is the difference between a tool someone trusts and a demo.

### Design

Match `rohitrao.in`: Inter and DM Mono from Google Fonts, near-black ink `#141310`, the
yellow `#FFD84A` used once or twice and nowhere else. Support light and dark. Mobile
first — a phone is where a shared link gets opened.

**CHECKPOINT 7:** Page renders locally with five hard-coded fake companies, the coverage
map shows 44 cells (all empty), and it looks right on a narrow window.

---

## Part 8 — Deploy and route

Do this **before** writing any scrapers. Deploying is where surprises live, and you want
them now, not on day three.

### Step 1 — Auth without `wrangler login`

1. Cloudflare dashboard → My Profile → **API Tokens** → Create Token.
2. Use the **Edit Cloudflare Workers** template.
3. Under Account Resources pick your account. Under Zone Resources pick `rohitrao.in`.
4. Create, copy the token.
5. In the Codespace terminal:

```bash
export CLOUDFLARE_API_TOKEN=paste_here
export CLOUDFLARE_ACCOUNT_ID=38e9a8612117a0a6da3c5da163bb97af
```

To make these stick across terminal restarts, add them as **Codespace secrets**:
GitHub repo → Settings → Secrets and variables → Codespaces.

### Step 2 — Set the ingest key

```bash
openssl rand -hex 32              # copy the output
npx wrangler secret put INGEST_KEY   # paste it
```

Also save that same value as a **GitHub Actions secret** named `INGEST_KEY` — the
scheduled job will need it.

### Step 3 — First deploy

```bash
npx wrangler deploy
```

It prints a `*.workers.dev` URL. Open it and add `/upstream` — the page should load.

### Step 4 — Add the route

In `wrangler.toml`:

```toml
[[routes]]
pattern = "rohitrao.in/upstream*"
zone_name = "rohitrao.in"
```

Then `npx wrangler deploy` again.

### Step 5 — The check that matters

```bash
curl -I https://rohitrao.in/                  # portfolio — must still be 200
curl -I https://rohitrao.in/upstream       # new page — must be 200
```

**Open `rohitrao.in` in a browser and confirm your portfolio is completely normal.**

If anything is wrong, delete the route in the Cloudflare dashboard (Workers Routes) and
the portfolio returns instantly. This is fully reversible — but check it now, not later.

**CHECKPOINT 8:** Both URLs return 200. Portfolio unchanged.

---

## Part 9 — Ranking

No score. Two facts decide the tier.

- **Recency** — days since `first_seen`.
- **Crowding** — `trace_count`: a live website, any press mention, a DPIIT listing, a
  funding announcement, an accelerator badge. More traces means more people already know.

| Tier | Rule |
|---|---|
| **A** | `first_seen` < 90 days ago **and** `trace_count` <= 2 |
| **B** | `first_seen` < 180 days ago **and** `trace_count` <= 5 |
| **C** | everything else |

Recompute on every ingest, for touched companies only. Sort: tier, then newest first.

**This will sometimes rank an unknown company above a famous one. That is the point,
not a bug.** Write that sentence into `docs/decisions/001-rank-by-obscurity.md` so
nobody later "fixes" it.

---

## Part 10 — Ingestion

### Step 1 — `ingest/sources/base.py`

Shared helpers every scraper uses:

- `fetch(url)` — requests with a real user-agent that includes a contact email, a 1
  second delay between calls, 3 retries with backoff, and a 30-day disk cache in
  `ingest/cache/`. **The cache matters**: it means re-running while you debug does not
  hammer anyone's server.
- `slugify(name)` — lowercase, strip `private limited` / `pvt ltd` / `llp`, strip
  punctuation, hyphenate. This is our company `id` and our dedupe key.
- `Company` and `Signal` dataclasses matching the DB schema.

Every scraper must return `(list[Company], list[Signal])` and nothing else. No scoring,
no classification, no uploading. One job each.

### Step 2 — Write the scrapers, easiest first

Order matters. Start with the one that will definitely work so you get a green result
on day two.

| # | Source | URL | Notes |
|---|---|---|---|
| 1 | SINE IIT Bombay | `sineiitb.org/portfolio/` | Static HTML. Start here. |
| 2 | IITM RTBI | `rtbi.in/incubationiitm/portfolio.html` | Static HTML. |
| 3 | ITIC IIT Hyderabad | `itic.iith.ac.in/startups.html` | Static HTML. |
| 4 | Grants CSV | local file | Not a scraper — see below. |

Each produces a `Signal` of type `incubator` with the cohort and the portfolio URL.

### Step 3 — The grants source

BIRAC BIG, NIDHI-PRAYAS and iDEX publish winner lists, but as PDFs and inconsistent HTML.
**Do not build a scraper for these yet.** Instead:

Create `ingest/sources/grants.csv` with columns:

```
company_name,scheme,award_date,project_summary,url
```

Fill in 30–50 rows by hand from published lists. It takes an hour and it is the
highest-signal data in the whole system — a government technical panel has already
reviewed the science, which is a far better maturity signal than anything we could infer
from a website.

`grants_csv.py` just reads that file. Automate it in week two if it proves valuable.

### Step 4 — `ingest/classify.py`

For each company, call Claude **twice**:

**Call 1 — which sector?** Give it the name, description, and the 5 sector names with
their one-line scope. Ask for exactly one sector id, or `none`.

**Call 2 — which sub-sector?** Give it the name, description, and only the sub-sectors
*within the chosen sector* (between 4 and 16 options), each with its project list. Ask
for one sub-sector id, the single closest project type, and a one-sentence reason.

**Why two calls instead of one.** Choosing from 44 options with 250 project types in one
prompt is unreliable and expensive. Two constrained choices are more accurate and cost
about the same. Use Claude Haiku for both.

Rules:
- If call 1 returns `none`, drop the company. **Do not guess.** A wrongly-tagged company
  corrupts the coverage map, which is the whole point of the page.
- Cache every result in `ingest/cache/classify.json`, keyed by company slug. **Commit
  the cache.** Re-runs then cost nothing and the classifications are reproducible.
- Store the reason in `classify_note`. This is your audit trail — when a tag looks wrong
  you need to see what the model was told and what it said.
- Keep a `ingest/overrides.json` for manual corrections that always win.

### Step 5 — `ingest/upload.py`

Batches of 50, POST to `/upstream/api/ingest` with the `X-Ingest-Key` header. Print
what came back. Fail loudly on non-200.

### Step 6 — `ingest/run.py`

Orchestrator:

```
for each source:
    try:    companies, signals = source.fetch()
            log run ok
    except: log run failed, CONTINUE TO NEXT SOURCE
classify everything new
upload
print a summary
```

**One source failing must never stop the others.** That is the single most important
behaviour in the pipeline.

**CHECKPOINT 10:** `python ingest/run.py` finishes, prints a summary, and
`rohitrao.in/upstream` shows real companies with real RDI tags.

**This is the moment you find out whether the idea is any good.** Look at the list
properly. How many companies had you not heard of? If it is fewer than three, the
sources are too mainstream — go to grants and patents sooner.

---

## Part 11 — Automation

`.github/workflows/ingest.yml`:

```yaml
name: ingest
on:
  schedule: [ { cron: "0 3 * * *" } ]   # 03:00 UTC daily
  workflow_dispatch:                     # and a manual button
jobs:
  ingest:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with: { python-version: "3.11" }
      - run: pip install -r ingest/requirements.txt
      - run: python ingest/run.py
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
          INGEST_KEY:        ${{ secrets.INGEST_KEY }}
          BASE_URL:          https://rohitrao.in/upstream
      - name: commit classification cache
        run: |
          git config user.name "ingest-bot"
          git config user.email "bot@users.noreply.github.com"
          git add ingest/cache/ && git commit -m "cache: $(date -I)" || true
          git push || true
```

Add `ANTHROPIC_API_KEY` and `INGEST_KEY` under repo Settings → Secrets and variables →
Actions. **Set a spend limit in the Anthropic console before the first scheduled run.**

**CHECKPOINT 11:** Trigger it manually from the Actions tab. It goes green and the site
updates.

---

## Part 12 — The repo as the deliverable

For the people you want to show this to, the repo matters as much as the page.

### README.md

- What this is, in three sentences.
- A screenshot of the coverage map.
- The architecture diagram from Part 2.
- Why obscurity-first ranking — the one-paragraph argument.
- How to run it locally.
- **What it misses.** Be specific and honest.

### docs/decisions/

One short file per real decision. Format: what we decided, what else we considered,
why, and what would change our mind.

Written so far:

1. `001-rank-by-obscurity.md` — why no pedigree signal, why no score.
2. `002-age-gate.md` — why companies older than five years are stored and counted but
   kept out of the default list, and why undated ones get their own section instead.
3. `003-first-seen-honesty.md` — why a backfill is not a discovery, and the four date
   columns that keep the two apart.

4. `004-private-notes.md` — why the notebook is behind Cloudflare Access with a verified
   token rather than a shared secret, and why it 404s until it is configured.

5. `005-rdi-taxonomy.md` — why the government's 44 sub-sectors and not our own list.
6. `006-no-linkedin.md` — a constraint chosen, not hit: every claim must link to a page
   anyone can open, and LinkedIn is the network this list is meant to get ahead of.
7. `007-ingestion-on-github.md` — why not scheduled Workers.
8. `008-two-call-classification.md` — sector then sub-sector, stopping where the evidence
   stops, under a dollar ceiling.
9. `009-homepage-product-read.md` — why what a company says it builds is quoted and
   attributed, read only from a site shown to be theirs, and why every failed read is
   stored under its own name.

Numbers 002 and 003 went to decisions that came up while building Part 10, and 004 to
one that came up building the notebook, so the planned ones keep shifting down.
Numbering follows what was decided when, not a plan written before the decisions
existed.

**These are what a partner or a hiring manager actually reads.** Four short decision
records tell someone more about how you think than four thousand lines of code.

---

## Part 13 — The three-day sequence

| Day | Parts | End state |
|---|---|---|
| **1** | 0 → 8 | Page live at `rohitrao.in/upstream` with fake data. Deployed, routed, portfolio verified unbroken. |
| **2** | 9 → 10 | Three scrapers + grants CSV + classification. **Real companies with real RDI tags on the live page.** |
| **3** | 7 (polish), 11, 12 | Coverage map finished, methodology written, GitHub Action running, README and five decision records. |

Deploying on day one is deliberate. If the route breaks something, you find out with two
days of slack, not two hours.

---

## Part 14 — Costs

| Item | Cost |
|---|---|
| GitHub Codespaces | free — 120 compute hours/month, used at 2× on a 2-core machine: about 60 wall-clock hours |
| Cloudflare Workers | free — 100k requests/day |
| Cloudflare D1 | free — 500 MB per database and 5 GB per account, 5M row reads/day, 7-day point-in-time recovery |
| GitHub Actions | free for public repos |
| Claude Haiku classification | ~$2–5 one-off, then near zero with the cache |

**Under $10 total.** Set the Anthropic spend limit anyway.

---

## Part 15 — Things that will go wrong

- **A portfolio page changes its HTML.** Expected. `runs` logs it, the other sources keep
  working, you fix it when you notice.
- **Same company, two spellings.** The slug handles most of it. Accept a few visible
  duplicates in the MVP — a wrong merge is worse than a visible duplicate.
- **Claude tags something wrong.** That is what `classify_note` and `overrides.json` are
  for. Check twenty tags by hand before you show anyone.
- **The route breaks the portfolio.** Test immediately (Part 8 Step 5). Deleting the
  route is instant.
- **The list is boring.** The most likely failure. Incubator portfolios are the easiest
  source to scrape and therefore the most picked over. If everything it finds is already
  well known, that is information: move to grant registers and patent filings, which are
  earlier and nobody is reading them.
- **Codespace goes to sleep.** It stops after 30 minutes idle. Your files persist. Just
  reopen it.

---

## Part 16 — How you know it worked

1. **Pick 20 rows. How many were new to you?** Fewer than 3 means the sources are wrong.
2. **Coverage.** How many of the 44 sub-sectors have at least one company? The empty ones
   are the finding — write two sentences about the most surprising gap.
3. **Would you send the link to an investor you respect?** If not, it is not finished.
