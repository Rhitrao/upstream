# 006 — No LinkedIn

**Decided** 2026-09-11 · **Status** accepted, and chosen rather than imposed

## What we decided

Nothing on this page comes from LinkedIn: no company pages, no founder profiles, no
headcounts, no "stealth" titles. A LinkedIn URL that a source publishes as a company's
website is refused as that company's domain, and is never fetched (`ingest/identity.py`).

This is a constraint we chose. It is not one we ran into.

## What else we considered

**Scraping it.** It is where Indian deep-tech founders announce things first, and the
signal is real: a "building something new" headline or a two-person company page is
often the earliest public trace there is. It breaches LinkedIn's terms, it depends on
logged-in sessions, and it breaks every few weeks by design.

**A data vendor.** Proxycurl, the usual answer, shut down in 2025 after LinkedIn sued.
The vendors that remain resell the same scraping at a price this project cannot pay
and with provenance nobody can show.

**Founder profiles linked from sources we do read.** Venture Center's cards link to
founders' LinkedIn pages. Following those links would be reading LinkedIn by one step
of indirection, so the scraper skips them.

## Why

Every row on this page carries the public page that put it there, and anyone can open
that page without an account and check it. A LinkedIn-derived row cannot meet that
standard: the evidence is behind a login, it changes under you, and the reader cannot
verify it without the same access. The page's one promise — every claim links to where
it came from — would have an exception, and the exception would be where the most
interesting claims live.

There is also a narrower reason. The list is argued as a way to see companies before
the network does. LinkedIn *is* the network. A lead found there is, by construction,
visible to every associate at every fund with a Sales Navigator seat.

## What we gave up

The earliest signal for a large share of companies, and all stealth companies. If a
company has not appeared in an incubator portfolio, a grant list or the DPIIT register,
this page cannot see it and does not pretend to. No founders, no team size, and no
"left a job to start this" — the fields a partner asks about first. The brief says so
under Unknown, every time.

## What would change our mind

LinkedIn offering a licensed, public-evidence way to cite a company page — a link
anyone could open. Not a cheaper vendor.
