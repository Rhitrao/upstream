# 001 — Rank by obscurity, and refuse to score

**Decided** 2026-09-12 · **Status** accepted

## What we decided

Two facts decide where a company sits, and neither is a judgement about the company.

- **Recency** — how long ago we first saw it.
- **Crowding** — `trace_count`, how many public traces it already has: a live website,
  a press mention, a grant, an accelerator badge.

| Tier | Rule |
|---|---|
| A | found by us under 90 days ago, at most 2 traces |
| B | first seen under 180 days ago, at most 5 traces |
| C | everything else |

No score. No pedigree signal — not the founder's degree, not the institution, not the
investor. Sorting is tier first, newest first inside a tier.

**This will sometimes rank a company nobody has heard of above a famous one. That is
the point, not a bug.** It is written here so that nobody later fixes it.

## What else we considered

**A 0–100 score.** Rejected because it would be a lie about precision. The inputs are a
date we may have wrong by months and a count of traces that depends on which pages we
happened to scrape. Multiplying those into a two-digit number implies an accuracy the
data cannot support, and once a number exists people optimise against it.

**A pedigree signal — IIT/IISc, tier-one investor, ex-FAANG founder.** Rejected because
it inverts the entire premise. Pedigree is the most-tracked attribute in Indian startup
data; adding it would rank the already-visible to the top, which is what every other
list already does. We would be building a worse version of something that exists.

**Weighting traces by quality** (a TechCrunch piece counting more than a directory
listing). Rejected for now as unfalsifiable: we have no way to test the weights, so
they would encode taste and call it method.

## Why

The page answers one question — *who is doing serious technical work that nobody has
noticed yet* — and every ranking input has to serve it. Obscurity is not a proxy for
quality and we do not claim it is. It is a proxy for **how much time you have left**
before the thing is common knowledge, and that is the only edge a list like this can
honestly offer.

Crowding is also the self-correcting half. A company that turns out to be good
accumulates traces and falls down the list on its own, without us deciding anything.

## What would change our mind

- If Tier A fills with companies that have no traces because they have nothing at all,
  the trace thresholds are wrong, not the idea. Raise them before adding a quality
  signal.
- If a scraped source is so stale that recency stops meaning anything, fix the source
  or drop it. See [002](002-age-gate.md) for how that has already bitten once.
- If someone demonstrates a pedigree-free quality signal that is genuinely testable —
  patents granted, say, or a technical publication record — it belongs in the trace
  count, not in a score.
