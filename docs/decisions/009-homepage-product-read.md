# 009 — What a company says it builds is quoted, attributed, and read only from a site that is theirs

**Decided** 2026-09-13, revised 2026-09-13 (identity check) · **Status** accepted

## What we decided

Where a company publishes a website, its homepage is fetched and one sentence of what it
says it builds is extracted (`ingest/enrich.py`). That sentence is printed as **in their
own words**, next to the link, and never as a fact anyone here checked.

Before anything on a site becomes evidence, the address has to pass an identity check
(`ingest/identity.py`): the company's own source record gives it, no other record gives
the same address, it is not a profile on another platform, and the company's name is in
the domain or on the page. An address that fails is not read, not linked as theirs, and
not counted as a trace.

Every way the read can fail is stored under its own name — `unreachable`, `refused`,
`thin`, `unclear`, `unverified` — and the page counts them.

## What else we considered

**Treating the sentence as a description.** It would make rows read better. It would
also launder a founder's pitch ("an AI-powered platform") into a claim this page makes.

**Reading any address a source gives.** This is what happened first. RTBI's page gave
Grinntech Motors the address `hyperverge.co`, and the page printed HyperVerge's identity
verification product as Grinntech's. A reviewer found it. A working URL proves nothing
about whose it is.

**Leaving failed reads blank.** A blank looks the same as "not got to it yet". "A
DPIIT-recognised startup whose domain no longer resolves" is a finding; a blank cell
hides it.

**Logos.** Only about 40% of the 209 sites had an `og:image`. A grid that was 88%
placeholders would make absence read as breakage.

## Why

A row that is wrong about what a company builds is worse than a row that says nothing:
an analyst forwards it believing it is sourced. So the row either quotes the company, in
quotation, from a site shown to be theirs, or says "No description published".

## What we gave up

Most rows. Of 699 placed companies, 209 published a website; the first read produced
129 usable sentences. Of the 252 addresses seen on 14 September, 29 are not confirmed as
the company's, and their sites are not read. Companies without a site, which on this
list is most of the quiet ones, get no sentence at all. It cost $0.15 once; re-runs are
free from the committed cache.

## What would change our mind

A source that publishes descriptions for register companies. Nothing that makes a
failed identity check pass more easily.
