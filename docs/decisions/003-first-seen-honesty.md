# 003 — A backfill is not a discovery

**Decided** 2026-09-12 · **Status** accepted

## What we decided

`first_seen` used to mean two things at once — the day a row landed in our database,
and the day the company became visible to anyone. On the first ingest those are years
apart, so they are now four columns:

| column | means | set when |
|---|---|---|
| `first_seen` | when the company became visible to us | insert only, never overwritten |
| `first_seen_basis` | `discovered` or `cohort` — where that date came from | with `first_seen` |
| `discovered` | the day the row entered this database | insert only |
| `origin_year` | the year a source says it was incubated or founded | any run, earliest wins |

A fourth input, `record_year`, is accepted on ingest but not stored: it is the year
a company entered a public record, and it drives `first_seen` when it differs from
`origin_year`. For an incubator cohort or a grant award the two are the same fact
and a scraper sets only `origin_year`. DPIIT is where they come apart — see below.

The rule that matters: **a source's first day is a backfill.** Nothing in it was
discovered by us, so nothing in it gets today's date. Those rows take the published
cohort year (floored to 1 January) with basis `cohort`, or no date at all where the
source publishes none. Only a company that turns up on a *later day*, from a source we
were already watching, gets a real `first_seen` of today, with basis `discovered`.

Backfill is inferred per source, from whether `runs` holds a successful run for it on an
earlier day. Per source, not globally, so a source added in month three brings its own
history rather than inheriting ours.

**Tier A requires basis `discovered`.** A cohort date can reach Tier B; an undated row
is Tier C whatever else is true of it.

## What else we considered

**Stamping today on everything, as before.** Rejected once the numbers were real: it
would have made 539 companies, including 2008 graduates, read as this week's finds, and
Tier A — the one claim the page actually makes — would have been meaningless on day one.

**Backdating `first_seen` to the cohort year everywhere, including live runs.**
Rejected. After a source is established, a company appearing on a list it was not on
last week *is* news, and today is the truthful date of that news. Using the cohort year
there would throw away the only genuine discovery signal we have.

**Inferring the basis instead of storing it** (`first_seen = discovered` implies a real
discovery). Rejected as too clever: it breaks on the day a cohort year floors onto the
run date, and it leaves the page with nothing to say about *why* a row is dated the way
it is. The column is also what lets a row say "listed by its incubator for 2024"
instead of a misleading "first seen".

**A manual backfill flag on every upload.** Kept as an override (`mode` in the payload)
for re-seeding, but not as the default: a flag you have to remember is a flag someone
forgets, and forgetting it silently manufactures 300 discoveries.

**"Has this source ever run" as the test, rather than "has it run on an earlier day".**
Tried, and wrong — caught by running it. One sweep is many requests, because 539
companies do not fit in a single payload, and the simpler test flipped to live after the
first chunk: 438 of 498 SINE companies were stamped as discovered today, most of them
Tier A. A rule about runs has to survive the way runs are actually shaped.

## Why

Tier A is the page's only real assertion — *we saw this early*. If a backfill can
produce one, the assertion is worthless, and worse, unfalsifiably worthless: nobody
reading the page could tell the difference. Splitting the columns makes the claim
checkable. `discovered` says how long we have held a row, `first_seen` says what we
think we know, and `first_seen_basis` says which of those two the date actually is.

Flooring a cohort year to 1 January is a deliberate error of up to twelve months, in
the safe direction: it makes a company look older than it is, never newer. It cannot
manufacture a Tier A, and it drops a company out of the age gate slightly early rather
than slightly late.

## The third state: dated, but ageless

DPIIT's recognition register publishes when it recognised a company and, anywhere
public, nothing about when the company was founded. We checked three ways: the
search endpoint returns thirty fields and no incorporation date, the CIN lookup
wants a CIN that endpoint never gives, and the profile page asks you to log in.

Recognition only requires incorporation within the previous ten years, so a company
founded in 2019 and recognised last week would read as brand new if the recognition
year were written into `origin_year`. So it is not: those rows carry `record_year`
instead, which dates `first_seen` and leaves `origin_year` null.

That produces a state the page did not have — **dated for first_seen, undated for
age** — and the page says so rather than hiding it:

- the row's date line reads "on public record from 2026 · founding year unknown";
- the list carries a count: "N of these are dated by a public register rather than
  by a founding year — the five-year filter cannot be applied to them".

They stay in the list rather than being held back, on the same rule that keeps
undated companies visible: "we do not know" is not "it is old". What changes is that
the page stops claiming the age gate covers them, because it does not.

## What would change our mind

- If a source starts publishing real dates — incorporation filings, cohort start days —
  those replace the 1 January floor and `origin_year` becomes a full date.
- If the `runs` table is ever wiped, every source looks new and the next run is treated
  as a backfill. That is the safe failure, but if it happens often the inference should
  move to an explicit per-source record.
- A sweep that straddles midnight UTC will have its last chunks read as live. Harmless
  at one sweep a day; if ingestion ever becomes continuous, the uploader should send an
  explicit `mode` and stop relying on the inference.
- If we ever ingest a source that is genuinely a live feed from day one (a filings
  stream, say), it should be allowed to declare `mode: live` on its first run — the
  override exists for exactly that.
