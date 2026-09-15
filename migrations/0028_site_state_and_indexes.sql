-- site_state: one row, key 'data', whose value moves whenever the public data does. The Worker
-- puts it in every edge cache key, so cached pages are served until an ingest writes and never
-- after (src/edgecache.ts). A migration that changes public data should update it too.
CREATE TABLE IF NOT EXISTS site_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
INSERT INTO site_state (key, value) VALUES ('data', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  ON CONFLICT(key) DO UPDATE SET value = excluded.value;

-- Counts by source read only that source's rows instead of every signal and gap.
CREATE INDEX IF NOT EXISTS idx_signals_source ON signals(source, company_id);
CREATE INDEX IF NOT EXISTS idx_gaps_source ON gaps(source);

-- said_state and is_company: generated from the row, and indexed together, so the list's default
-- half (companies that say what they build) is read through an index instead of computing a CASE
-- for every row on every query. The expression is SAID_STATE_SQL in src/db.ts; a test pins them.
ALTER TABLE companies ADD COLUMN said_state TEXT GENERATED ALWAYS AS (CASE
  WHEN COALESCE(product, '') <> '' AND website_identity = 'verified' THEN 'own'
  WHEN COALESCE(description, '') <> '' AND NOT (substr(description, 1, 35) = 'DPIIT-recognised startup. Industry:' OR substr(description, 1, 53) = 'BIRAC Biotechnology Ignition Grant awardee, category:') THEN 'source'
  WHEN COALESCE(description, '') <> '' THEN 'label'
  ELSE 'none' END) VIRTUAL;
ALTER TABLE companies ADD COLUMN is_company INTEGER GENERATED ALWAYS AS (COALESCE(entity_type, 'company') = 'company') VIRTUAL;
CREATE INDEX IF NOT EXISTS idx_companies_half ON companies(is_company, said_state);

-- outside_count: signals other than their own website; other_count: their own website and press.
-- Kept by the Worker on every ingest, so the 'one outside source' and 'no other trace' filters
-- read a column instead of counting signals per company per query.
ALTER TABLE companies ADD COLUMN outside_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE companies ADD COLUMN other_count INTEGER NOT NULL DEFAULT 0;
UPDATE companies SET
  outside_count = (SELECT COUNT(*) FROM signals s WHERE s.company_id = companies.id AND s.type <> 'website'),
  other_count = (SELECT COUNT(*) FROM signals s WHERE s.company_id = companies.id AND s.type IN ('website', 'press'));

-- Statistics for the query planner, so a selective index (a sub-sector) is chosen over a broad one.
PRAGMA optimize;
