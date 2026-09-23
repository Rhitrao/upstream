# Enrich Upstream's company pages from a committed data file

Read this whole file before changing anything. Then summarise your plan in five lines and start.

## What this is

`data/enrichment/2026-09-23.json` (attached, commit it exactly as given) holds a one-off enrichment of 419 Upstream records. It covers every company in the default view (305 shown on the page) plus all 144 robotics records (sub-sectors 2.7 and 2.3). It was gathered outside this repo on 23 Sep 2026 by automated web lookup. The Worker and the nightly pipeline must never call a scraping or search API. This file is the only source for these fields.

Shape:

```
{
  "version": "2026-09-23",
  "method": "<one paragraph, show it verbatim on the methodology page>",
  "count": 419,
  "companies": {
    "<upstream id>": {
      "id", "name",
      "registry": { "cin", "legal_name", "incorporated_on" (YYYY-MM-DD or null), "incorporated_year", "status", "state", "source_url", "match_note" } | null,
      "registry_reason": string | null,
      "website": { "url", "identity" ("names company" | "names founder" | "names incubator"), "source_url" } | null,
      "website_reason": string | null,
      "product": { "quote", "source_url" } | null,
      "product_reason": string | null,
      "claims": [ { "quote", "source_url" } ],
      "checked_by_person": boolean
    }
  }
}
```

Only two records have `checked_by_person: true` (vctr-labs, umarobotics-technology). Every other record was matched automatically.

## Rules that do not bend

1. **Leave the pipeline's data alone.** Ingestion never reads or writes enrichment. Nothing here overwrites a pipeline field in D1. Enrichment lives in its own table and is joined at read time.
2. **Enrichment is not a public trace.** Do not change `trace_count`, `tier`, the ranking, or the "fewest collected references" sort. Enrichment is a lookup we did, not something the public record says. Counting it would push the companies we researched down a least-documented-first ranking.
3. **Every fact shows where it came from.** Every rendered fact carries a source link and a plain-words basis. The company's own words are always shown as quotes attributed to the company, never as Upstream's statement.
4. **"Not found" is a valid answer.** Show the reason in plain words. Never guess, and never fill a gap from another field.
5. **Leave the dated snapshot (17 Sep 2026) and its CSV untouched.** They record what the tool knew on that date.

## Step 1: storage

- Migration `0026_company_enrichment.sql` creates table `company_enrichment` with these columns:
  - `id` TEXT PRIMARY KEY (the upstream id)
  - `cin`, `legal_name`, `incorporated_on`, `incorporated_year` INTEGER, `reg_status`, `reg_state`, `reg_source`, `reg_note`, `reg_reason`
  - `site_url`, `site_identity`, `site_source`, `site_reason`
  - `product_quote`, `product_source`, `product_reason`
  - `claims_json`
  - `checked_by_person` INTEGER
  - `enriched_on` TEXT
- Add `scripts/load_enrichment.py`. It reads the JSON, validates it, and writes `migrations/data/enrichment_2026-09-23.sql`: INSERT OR REPLACE statements with proper SQL escaping. Apply it with `wrangler d1 execute upstream --remote --file=...`, then run it `--local` too for tests.
- Validation must fail loudly if:
  - a non-null section has no `source_url`
  - a CIN's year digits disagree with `incorporated_on`
  - an id doesn't exist in `companies`

## Step 2: the "Started" filter and the default view

- In the existing "Started in the last 5 years" logic, use `incorporated_year` when enrichment has one. Otherwise keep the current behaviour. Use the same year-based rule the filter already uses, so 2021 still counts as within five years in 2026. Tell me in your summary exactly which rule the code uses.
- Companies with `reg_status` of "Strike Off", "Converted and Dissolved", "Under Process of Striking Off" or "Inactive for e-filing" drop out of the default view. They stay reachable with Status = Any, a new secondary filter. Its options are "Active or unknown" (default) and "Any".
- The "About these results" line gains two counts, computed from data rather than hardcoded:
  - "N started before <year>, by government registry date"
  - "N closed or struck off in the registry"
- Keep the existing undated count. It should now be much smaller.

## Step 3: the company page `/upstream/c/<id>`

Add a block near the top, under the name, headed **"Registry and website"**. Write it in plain words, with no jargon labels. Examples:

- "Registered as **SOLINAS INTEGRITY PRIVATE LIMITED** on 15 Mar 2018 · Active · Tamil Nadu" with a small link "government registry record (via instafinancials.com)". Show the CIN in small grey text after it.
  - If only the year is known: "Registered in 2016 (year from the registration number)".
  - If the status is struck off or dissolved: a clear amber line, "The government registry lists this company as struck off."
- "Website: umarobotics.com": use enrichment's `site_url` only when the pipeline has no website or has it as unconfirmed. Add a basis note in plain words:
  - "names the company"
  - "names a founder"
  - "names its incubator"
  - If the pipeline already has a verified website, keep it and don't repeat it.
- **"What they say they build"**: the `product_quote` in a blockquote, attributed "from their website" with the link. Show it only when present.
- **"The company says"**: each claim as a quote with its link, and a small tag "self-reported".
- For every missing section, one grey line: "Registry record: not found (no registry record found)", using the `*_reason` text.
- One quiet footer line for the block: "Gathered automatically from public sources on 23 Sep 2026. Not checked by a person." For the two `checked_by_person` records, use instead: "Checked by hand on 23 Sep 2026."
- Remove the existing "no person has checked it" wording on those two pages if it conflicts.

## Step 4: the list

- When a company in the list has no pipeline product sentence and enrichment has a `product_quote`, show the quote as its description, in quotation marks, followed by a small "(from their site)".
- Don't use the quote for classification, and don't change the sub-sector.

## Step 5: methodology page

Add a short section, "Registry and website enrichment". Include:

- the `method` paragraph, verbatim
- counts computed from the table:
  - records enriched
  - matched to a registry record
  - ambiguous or not found
  - started before the five-year window
  - struck off or closed
  - websites added
  - product quotes added
- this sentence: "Enrichment does not change the ranking: a registry lookup is something Upstream did, not a public trace of the company."

## Step 6: tests

- Every non-null enrichment field rendered on a page has a source link.
- The fixture `solinas-integrity` (registered 2018) is excluded from the default "last 5 years" view and included with Started = Any year.
- A struck-off fixture is excluded from the default view and shown with Status = Any.
- `trace_count` and tier for enriched rows are identical before and after the migration. Snapshot a few ids and compare.
- The recommendation-language test still passes.
  - Company quotes are the companies' words, so render them in a `<blockquote data-source="company">` or `<q data-source="company">`. Exempt only elements carrying that attribute from the test.
  - Show me any line of Upstream's own copy the test flags. Don't reword quotes and don't weaken the test.

## Step 7: ship

- Bump the edge cache version key so no stale pages are served.
- Deploy. Confirm with curl that these return 200:
  - `/`
  - `/upstream`
  - `/upstream/c/solinas-integrity`
  - `/upstream/c/vctr-labs`
  - `/upstream/c/umarobotics-technology`
  - `/upstream/picks/robotics` (if it exists yet)
  - `/parts`
- Commit and push in one commit: "Registry and website enrichment (23 Sep 2026)".
- Summarise:
  - how many companies left the default view, and why
  - the new counts
  - which rule the Started filter now uses
  - anything in the data you refused to load, and why

## Things to watch

- `umarobotics-technology` was registered on 28 Aug 2021. Under a year-based rule it stays in the five-year window. Under a date-based rule it falls just outside. Use the year-based rule the filter already uses, and say so.
- A few records carry an LLP identification number (format `AAA-1234`) instead of a CIN. Treat these as registry records, and label them "Registered as an LLP".
- Four records are marked ambiguous (two possible companies). Show them as "Registry record: two possible matches, not shown", with the reason text.
