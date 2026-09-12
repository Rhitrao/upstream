# 002 — Old companies are ingested, not listed

**Decided** 2026-09-12 · **Status** accepted

## What we decided

A company that was incubated or founded more than **five years ago** is ingested,
stored, and counted in the coverage map, but it does not appear in the default list.
One control on the page (`Started: every year`, or `?age=all`) brings them back, and
the list says how many it is holding back rather than quietly dropping them.

The gate reads the earliest year any source attributes to the company — the incubation
cohort or the founding year, whichever is earlier. **A company with no year at all is
not treated as old.** Those go to their own section, below the ranking, headed with
what they are: companies we cannot place in time yet. They are visible, they are
counted, and they are not pretending to be recent.

On the first real ingest this splits 539 companies into 126 ranked, 118 held back, and
295 undated.

## What else we considered

**No gate.** Rejected after seeing the data. SINE's portfolio goes back to 2006 and IIT
Madras RTBI's page has not been updated in years; without a gate the front page fills
with companies like Ather Energy, which raised its Series B in 2019. A list that
promises "before the funding announcement" and opens with a decade-old scooter company
has broken its promise in the first row.

**Filtering at ingest — never store them.** Rejected. The coverage map is a map of what
we can *see*, and it would start lying the moment we discarded rows to make it prettier.
An old company in a sub-sector is still evidence that the sub-sector exists and that our
sources reach it. Deleting data to improve a view is a decision you cannot undo later.

**Excluding undated companies too.** Rejected, and this was the closest call. It is
truer to the product's promise, but it would have dropped all 42 RTBI companies and
left the default view drawing on a single source. Worse, it fails silently in exactly
the wrong direction: any source that stops publishing years would empty the page
without anyone noticing. A separate section costs one scroll and keeps the failure
visible.

**Treating undated as old.** Rejected as the same mistake in the other direction —
"we don't know" is not "it's from 2013", and the page should never round an absence up
into a claim.

## Why

Five years is not a natural constant; it is a judgement about deep tech specifically.
Hardware, biotech and semiconductor companies take three to five years to get anywhere
public, so a three-year gate would cut companies that are still genuinely early, and a
ten-year gate would admit companies with Series B rounds. Five is the point where, in
this sector, "early" stops being true.

The gate is a **view filter, not an ingest filter**, and that distinction is the whole
decision. The database stays complete, the coverage map stays honest, and the default
list stays useful. Anyone who disagrees with the number changes one constant
(`MAX_AGE_YEARS` in `src/rank.ts`) and nothing else.

## What would change our mind

- If the held-back link gets used more than it is ignored, the gate is set too tight.
- If a source starts publishing incorporation dates, undated companies get dated and
  the section shrinks on its own — that is the intended end state, not a permanent
  fixture.
- If the undated section grows past roughly a third of the list, it has stopped being a
  footnote and the dating problem needs solving before adding more sources.
