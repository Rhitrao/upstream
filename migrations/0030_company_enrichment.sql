-- company_enrichment: a one-off lookup of registry records, websites and the company's own words,
-- gathered outside this repo (data/enrichment/<version>.json) and loaded by
-- scripts/load_enrichment.py. Joined to companies at read time; nothing here overwrites a
-- pipeline column, and the ingest never reads or writes it. Not a public trace: trace_count, tier
-- and the ranking do not look at it.
--
-- (Numbered 0030 because 0026 was already taken by site_signals.)
CREATE TABLE IF NOT EXISTS company_enrichment (
  id                TEXT PRIMARY KEY,
  cin               TEXT,
  legal_name        TEXT,
  incorporated_on   TEXT,
  incorporated_year INTEGER,
  reg_status        TEXT,
  reg_state         TEXT,
  reg_source        TEXT,
  reg_note          TEXT,
  reg_reason        TEXT,
  site_url          TEXT,
  site_identity     TEXT,
  site_source       TEXT,
  site_reason       TEXT,
  product_quote     TEXT,
  product_source    TEXT,
  product_reason    TEXT,
  claims_json       TEXT,
  checked_by_person INTEGER NOT NULL DEFAULT 0,
  enriched_on       TEXT NOT NULL
);

-- The method paragraph each version was gathered by, shown verbatim on the methodology page.
CREATE TABLE IF NOT EXISTS enrichment_meta (
  version TEXT PRIMARY KEY,
  method  TEXT NOT NULL,
  count   INTEGER NOT NULL
);
