# 008 — Classify in two calls, stop where the evidence stops, and cap the spend

**Decided** 2026-09-12, revised 2026-09-14 · **Status** accepted

## What we decided

Each company is classified by Claude Haiku 4.5 in two constrained calls: first a sector
from the five or `none`, then a sub-sector from only that sector's four to sixteen, with
the closest project type and a one-line reason. Every answer is cached against a hash of
the exact text sent, and committed.

Two limits sit on top of the model's answer:

- **It stops at supported depth.** A company described only by a register label gets no
  project type, and since 14 September keeps its sub-sector only where the label names
  that sub-sector outright (`ingest/register_labels.py`, a hand-read table). "AI / NLP"
  does not name AI in Healthcare; five companies had been placed there on that basis.
  Those companies are also barred from Tier A and B.
- **Every run has a dollar ceiling.** `UPSTREAM_MAX_COST`, checked before each call and
  counting calls in flight. A run that reaches it stops, keeps what it bought, and says
  what it left.

## What else we considered

**One call over all 44 sub-sectors and ~250 project types.** No cheaper — the prompt is
the taxonomy either way — and measurably less accurate: the model picks plausible cells
in the wrong sector.

**Trusting the model's placement of register records.** The notes are fluent, and that
is the danger: "SubtleBotic is a robotics startup developing intelligent robotic
systems" restates the dropdown in a sentence. A second paragraph agreeing with the first
is not a second source.

**A bigger model.** Better at thin inputs, but thin inputs are the problem, and no model
can say what a company builds from "Industry: AI. Sector: NLP."

## Why

The coverage map is the one thing on the page that claims completeness, so a wrong tag
costs more than a missing one. The money is fixed: about $2.77 had to last until 27
September 2026, so every decision here was priced first. Two calls cost about $0.003 a
company, and a re-run of cached companies costs nothing.

## What we gave up

- **157 placements**, withdrawn by the register-label rule on the 14 September dry run.
  Those companies drop into "could not describe well enough to place".
- **Freshness under a small cap.** Run #3 had a $0.45 ceiling and stopped with 65
  Venture Center companies unclassified. Classification runs in source order and new
  DPIIT arrivals come first, so a $0.05 nightly cap may never reach them without a
  one-off run.
- **Reproducibility across prompts.** Changing a prompt re-keys and re-buys. Prompt
  versions are scoped per source so one source's revision does not re-buy the others.

## What would change our mind

A cheaper way to get real descriptions for register records (their homepages, where
they have one) — which would make most of the withdrawn placements supportable again.
