# 007 — Ingestion runs on GitHub Actions, not in the Worker

**Decided** 2026-09-12 · **Status** accepted

## What we decided

The page is a Cloudflare Worker with D1. The ingest — five scrapers, classification,
the homepage read — is Python, run once a day by `.github/workflows/ingest.yml` at
03:00 UTC. It posts to the Worker's `/api/ingest` with a key, and it commits the paid
model answers (`ingest/cache/classify.json`, `products.json`) back to the repository.

## What else we considered

**Scheduled Workers.** One platform, one deploy, one set of secrets. But a run fetches
roughly 350 pages with a one-second pause between requests, parses HTML
with BeautifulSoup and makes a few hundred model calls; run #3 took 8 minutes 40
seconds. That is long past a scheduled Worker's CPU budget, and the scrapers would have
to be rewritten in TypeScript against an HTML parser that is not the one they were
debugged with.

**A small server with cron.** Always on, and paid for every hour it is not scraping.
It would also be a machine to patch for a job that runs for nine minutes a day.

## Why

The repository is public, so Actions minutes cost nothing. The runner has a disk, so
scraped pages are cached for 30 days and debugging a parser sends the source no extra
requests. And the classification cache lives in git: a fresh checkout — a new runner
every morning — knows every answer already paid for, so a normal night costs nothing.
A commit is also an audit trail of when each classification was bought.

## What we gave up

- **Two places for secrets.** `ANTHROPIC_API_KEY` and `INGEST_KEY` live in GitHub; the
  Worker has its own `INGEST_KEY`. The Codespace token cannot set Actions secrets or
  dispatch a run (both 403), so both need a person in a browser.
- **A failure mode the Worker cannot see.** If the workflow is disabled, the page just
  goes stale. The freshness line under the masthead, one date per source, is the guard.
- **Bot commits on `main`**, one per run that bought an answer.

## What would change our mind

Scrapers small enough to run in a Worker's budget, or a source that must be read more
often than daily.
