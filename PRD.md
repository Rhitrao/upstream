# Upstream — Pre-Seed Deal Radar

**Live at:** `rohitrao.in/upstream`
**Repo:** GitHub (public)
**Status:** Build spec. Written to be handed to Claude Code.

---

## 1. What we are building, in one paragraph

A public web page that shows early-stage Indian deep-tech companies **sorted by how few
people know about them**, not by how impressive they look. Every company on the list
carries the evidence that put it there — a patent, an incubator listing, a government
grant, a fresh incorporation — with links. A visitor picks a sector and sees the
companies that are new and quiet. The whole thing is fed by a scheduled job that reads
public Indian government and university sources.

It is not a chatbot. It is not a scraper demo. It is a working piece of analyst
tooling that anyone can use and inspect.

---

## 2. Why this exists

Most funds find deep-tech companies the same way: a funding announcement, a Tracxn
entry, a press mention. Those all fire at the same moment, and that moment is late. By
then every fund can see the company and the founder has taken three calls.

But a deep-tech company leaves a public trail long before that. An incubator lists it.
A patent gets filed. A government grant panel funds it. A company gets incorporated.
All of that is public, and all of it happens 6–24 months before the funding
announcement.

**The product is simple: surface the companies that have left an early trail and
nothing else.**

Two rules follow from that, and they drive every design decision below:

1. **Rank by obscurity, not by pedigree.** A company with one incubator listing and no
   website is more interesting than one with a famous founder and press coverage.
2. **Show evidence, never a score.** A number between 0 and 100 pretends to a precision
   we do not have. Show the facts and let the reader judge.

---

## 3. Who uses it and what they do

**Primary user:** an analyst or investor at an early-stage Indian fund.
They open the page, filter to a sector, scan the top 20 rows, and click through to two
or three company websites. Whole visit: under five minutes.

**Secondary user:** anyone evaluating Rohit's work — a hiring manager, a fellowship
reviewer. They read the methodology section and look at the repo.

Both need the same thing: the list has to be *defensible*. Every row must answer "why
is this here?" without anyone having to ask.

---

## 4. Scope

### The 2–3 day MVP

- A public page at `rohitrao.in/upstream` that renders a ranked company list.
- Filter by sector and by tier.
- Data from **incubator portfolios** (4 sources) and a **hand-seeded grant list**.
- Tiering rules working.
- Everything in a public GitHub repo with a real README.

### By end of next week

- **MCA new-incorporation data** added as a source.
- **Indian Patent Office** added as a source.
- **Crowding check** — does the company have a website, press, a DPIIT listing?
- **Scheduled ingestion** via GitHub Actions, running daily without you touching it.
- **Sector classification** by LLM during ingestion.
- A written methodology page and honest limitations.

### Explicitly not in scope

- No login, no accounts, no saved searches.
- No LinkedIn data. Proxycurl shut down in 2025 and direct scraping breaks their terms.
- No contact details, no emails, no outreach.
- No score. Tiers and evidence only.
- No paid data sources. Everything here is public and free.
- No chatbot.

---

## 5. Where the data comes from

Only public sources. Nothing behind a login, nothing against a site's terms.

| Source | What it gives us | How hard | When |
|---|---|---|---|
| SINE IIT Bombay portfolio | Company, description, founders, sector | Easy — static HTML | MVP |
| IIT Madras incubation (RTBI) | Company, description, cohort | Easy — static HTML | MVP |
| ITIC IIT Hyderabad | Company, description | Easy — static HTML | MVP |
| IISc / other incubators | Company, description | Easy — static HTML | MVP |
| Grant winners — BIRAC BIG, NIDHI-PRAYAS, iDEX | Company, award date, project summary | Medium — start by pasting in a CSV by hand | MVP (manual), automated week 1 |
| MCA new incorporations | Company name, CIN, date, state, activity code | Medium — bulk CSV downloads | Week 1 |
| Indian Patent Office | Applicant, inventors, filing date, title | Hard — clunky search site | Week 1 |
| Company's own website | Does one exist? What does it say? | Easy — one HTTP request | Week 1 |

**Rule for every scraper:** identify yourself in the user-agent, one request per second
maximum, cache aggressively, and never hit a source more than once a day. If a source
blocks us, we stop using it and note it in the README.

---

## 6. How it works

Three parts. They are deliberately separate so a failure in one does not break the others.

```
   ┌─────────────────────────────────────────────┐
   │  INGESTION  — GitHub Actions, runs daily    │
   │                                             │
   │  scrapers → normalise → classify → upload   │
   │  (python)   (one shape)  (Claude)  (D1 API) │
   └──────────────────────┬──────────────────────┘
                          │  writes over HTTPS
                          ▼
   ┌─────────────────────────────────────────────┐
   │  DATABASE  — Cloudflare D1 (SQLite)         │
   │                                             │
   │  companies · signals · sources              │
   └──────────────────────┬──────────────────────┘
                          │  reads
                          ▼
   ┌─────────────────────────────────────────────┐
   │  SITE  — Cloudflare Worker                  │
   │                                             │
   │  serves the page + /api/companies           │
   │  route: rohitrao.in/upstream*               │
   └─────────────────────────────────────────────┘
                          │
                          ▼
                     the visitor
```

### Why it is split this way

**Ingestion runs on GitHub, not on Cloudflare.** Scraping from a Worker is slow, hits
time limits, and gets rate-limited. A GitHub Action has no time limit, a normal IP, and
full Python. It also means every run is logged publicly in the repo, which is good for
a project meant to be inspected.

**The Worker only reads.** It never scrapes at request time. Page loads are fast
because all the work already happened.

**Classification happens once, during ingestion.** We call Claude to decide a company's
sector when we first see it, store the answer, and never call again. That keeps the
page instant and the bill near zero.

### A note on the URL

`rohitrao.in/upstream` is a *path* on your existing domain, not a subdomain. Your
portfolio site is a separate Cloudflare Pages project and we are not touching it. This
project is a separate Worker with a **route** on the same zone:

```
rohitrao.in/upstream*
```

Cloudflare matches that route first and sends those requests to this Worker. Everything
else still goes to your portfolio. The two deploy independently and cannot break each
other.

---

## 7. The database

Three tables. SQLite via Cloudflare D1.

### `companies`

One row per company. This is the thing the page lists.

| Column | Type | Notes |
|---|---|---|
| `id` | TEXT | slug of the name, e.g. `verve-aerospace` |
| `name` | TEXT | as published by the source |
| `description` | TEXT | one or two sentences |
| `sector` | TEXT | from a fixed list — see §8 |
| `city` | TEXT | nullable |
| `website` | TEXT | nullable |
| `cin` | TEXT | MCA company number, nullable, our best join key |
| `founded_year` | INTEGER | nullable |
| `first_seen` | TEXT | ISO date we first found it — drives recency |
| `trace_count` | INTEGER | how many public traces exist — drives crowding |
| `tier` | TEXT | `A`, `B` or `C`, computed — see §9 |
| `updated_at` | TEXT | ISO timestamp |

### `signals`

One row per piece of evidence. A company has many. **This table is the product** — it
is what lets every row justify itself.

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER | autoincrement |
| `company_id` | TEXT | → companies.id |
| `type` | TEXT | `incubator`, `grant`, `patent`, `incorporation`, `website`, `press` |
| `date` | TEXT | ISO date the thing happened, nullable |
| `label` | TEXT | shown on the page, e.g. `SINE IIT Bombay cohort` |
| `url` | TEXT | link to the source |
| `source` | TEXT | which scraper found it |
| `found_at` | TEXT | ISO timestamp |

### `runs`

One row per ingestion run, so failures are visible rather than silent.

| Column | Type |
|---|---|
| `id` | INTEGER |
| `started_at` | TEXT |
| `source` | TEXT |
| `status` | TEXT — `ok` or `failed` |
| `records_found` | INTEGER |
| `error` | TEXT, nullable |

---

## 8. Sectors

A fixed list. Anything that does not fit is dropped, not forced into a bucket.

```
robotics · space · aerospace · semiconductors · advanced-materials
batteries-energy-storage · clean-energy · green-hydrogen · defence
biotech · medical-devices · photonics-lasers · quantum
industrial-iot · agritech · mobility
```

Classification is done by Claude during ingestion. The prompt gets the company name,
the description, and this list, and must return exactly one sector or the word `none`.
**If it returns `none`, the company is dropped.** Do not guess.

---

## 9. Ranking

No score. Two facts decide the tier.

- **Recency** — days since `first_seen`.
- **Crowding** — `trace_count`, which counts: a working website, any press mention we
  find, a DPIIT listing, a funding announcement, an accelerator badge. More traces
  means more people already know.

| Tier | Rule | Meaning |
|---|---|---|
| **A** | first seen < 90 days ago **and** trace_count ≤ 2 | New and quiet. Read these first. |
| **B** | first seen < 180 days ago **and** trace_count ≤ 5 | Early, some visibility. |
| **C** | everything else | Known territory. Listed, not promoted. |

Sort order on the page: tier first, then most recent `first_seen`.

**This will sometimes put an unknown company above a famous one. That is the point.**

---

## 10. The page

One page. Server-rendered HTML from the Worker — no React, no build step, no framework.

### Top

- Title, one sentence explaining what the list is.
- Two or three numbers: companies tracked, added this week, sources.

### Controls

- Sector dropdown (all sectors + "all").
- Tier toggle (A / A+B / everything). Default A+B.
- That is all. No search box in the MVP.

### The list

Each row:

```
TIER A    Verve Aerospace Private Limited              Bengaluru
          Small reusable launch vehicles for sub-orbital payloads.
          SINE IIT-B cohort 2026  ·  incorporated 2026-03  ·  no website yet
                                                    first seen 12 days ago
```

- Tier as a small label, not a big badge.
- The evidence chips are links, each going to the source that produced it.
- If there is no website, say so plainly — that is a *positive* signal here, and
  saying it out loud teaches the visitor how the list works.

### Bottom — methodology

Short, honest, and not hidden behind a link:

- Where the data comes from, with links.
- How tiers are decided.
- What this misses: no LinkedIn, no stealth companies, no company that has not been
  listed anywhere public yet, and a bias toward institutions that publish portfolios.

That limitations paragraph matters more than it looks. It is the difference between a
tool someone trusts and a demo.

### Design

Match `rohitrao.in` — Inter and DM Mono, near-black ink, the yellow marker used once
or twice and no more. Light and dark both work. Mobile first: the list must be readable
on a phone, because that is where a link gets opened.

---

## 11. The API

Two endpoints. Public, read-only, no key.

```
GET /upstream/api/companies?sector=robotics&tier=A&limit=50
    → { companies: [ { ...company, signals: [...] } ], total: 137 }

GET /upstream/api/stats
    → { total, added_this_week, by_sector: {...}, last_run: "2026-09-14T03:00:00Z" }
```

One write endpoint, protected by a shared secret in a header. Only GitHub Actions
calls it.

```
POST /upstream/api/ingest
    header: X-Ingest-Key: <secret from Worker env>
    body:   { source: "sine_iitb", companies: [...], signals: [...] }
```

The write endpoint **upserts**: if a company already exists, add any new signals and
recompute `trace_count` and `tier`, but never change `first_seen`. That field is the
memory of when we were early, and overwriting it destroys the only metric that matters.

---

## 12. Build order

Each step is a session with Claude Code. Do them in order and do not skip ahead — step
2 is the one that proves the idea works, and everything after it is easier.

### Day 1 — skeleton and first real data

1. `npm create cloudflare@latest upstream` — a Worker with static assets.
2. Create a D1 database, add the three tables from §7 as a migration.
3. Write `GET /api/companies` and `GET /api/stats`, returning data from D1.
4. Write the page. Hard-code five fake companies first so you can see the layout before
   any scraper exists.
5. Deploy. Add the route `rohitrao.in/upstream*`. **Check the portfolio site still
   works** — this is the one step that can break something you care about.
6. Push to GitHub.

**End of day 1: the page is live with fake data.**

### Day 2 — the scrapers

1. `ingest/` directory, Python. One file per source.
2. Write the SINE IIT Bombay scraper first. It is a static page and will work.
3. Write two more incubator scrapers.
4. Write `classify.py` — calls Claude to assign a sector, caches results in a local
   JSON file so re-runs cost nothing.
5. Write `upload.py` — posts to `/api/ingest`.
6. Run it by hand. Look at the real list. **This is the moment you find out whether the
   idea is any good.**

**End of day 2: real companies on the page.**

### Day 3 — make it defensible

1. Tiering logic, properly, with the rules in §9.
2. Website check — one HTTP HEAD per company, feeds `trace_count`.
3. Hand-seed a grant CSV — 30–50 BIRAC / iDEX winners typed or pasted in.
4. Methodology and limitations section on the page.
5. README: what this is, why obscurity-first ranking, the architecture diagram, how to
   run it, what it misses.

**End of day 3: a working, honest, public tool.**

### Week 1 — the rest

- GitHub Action running ingestion daily at 03:00 UTC.
- MCA new-incorporation ingestion.
- Patent office ingestion.
- Press check for `trace_count`.
- A `docs/decisions/` folder — one short file per real decision you made. Why no score.
  Why no LinkedIn. Why ingestion runs on GitHub. **These are what a partner reads.**

---

## 13. Costs

| Thing | Cost |
|---|---|
| Cloudflare Workers | free tier — 100k requests/day |
| Cloudflare D1 | free tier — 5GB, 5M row reads/day |
| GitHub Actions | free for public repos |
| Claude API for classification | roughly $2–5 one-off for a few thousand companies, then near zero |
| Domain | already yours |

**Under $10 total.** Set a spend limit in the Anthropic console anyway.

---

## 14. How we know it worked

Not vanity numbers. Three things:

1. **Does it surface companies you had not heard of?** Pick 20 rows. How many were new
   to you? If it is fewer than 3, the sources are too mainstream.
2. **Lead time.** For any company on the list that later announces a round, how many
   days earlier did we have it? This is the real metric and it takes months to read.
3. **Would you send it to someone?** If you would not send the link to an investor you
   respect, it is not finished.

**Stop rule:** if after the MVP the list is full of companies everyone already knows,
the sources are wrong, not the idea. Swap incubator portfolios for grant registers and
patent filings, which are earlier and less picked over.

---

## 15. Things that will go wrong

Written down now so they are not surprises.

- **A source changes its HTML.** Expected. The `runs` table logs the failure, the other
  sources keep working, you fix it when you notice.
- **The same company appears twice** with slightly different names. Match on a
  normalised name — lowercase, strip "private limited", strip punctuation. Accept a few
  duplicates in the MVP; wrong merges are worse than visible duplicates.
- **Claude classifies something wrong.** Log every classification with the input so you
  can audit. Allow a manual override list in a JSON file.
- **The route breaks the portfolio.** Test `rohitrao.in` immediately after adding the
  Worker route. If anything is off, delete the route — it is instantly reversible.
- **The list is boring.** The most likely failure. If incubator portfolios only produce
  companies that are already well known, that is real information: move to grants and
  patents faster.

---

## 16. Setup checklist

Before starting, have these ready:

- [ ] Cloudflare account (you have it) and `wrangler` installed — `npm i -g wrangler`
- [ ] `wrangler login`
- [ ] GitHub account, empty public repo named `upstream`
- [ ] Anthropic API key, with a spend limit set
- [ ] Cloudflare API token with D1 write access — for the GitHub Action later
- [ ] A random string for `INGEST_KEY`, stored as a Worker secret and a GitHub secret

**GitHub, not GitLab.** Not on technical merit — on who looks. Investors and hiring
managers browse GitHub profiles. Nobody browses GitLab for people.
