-- first_seen meant two things at once: the day a row landed in this database, and the
-- day the company became visible to anyone at all. On a backfill those are years
-- apart, and conflating them let a 2008 graduate read as a discovery. Split them.
--
-- SQLite cannot drop a NOT NULL in place, so the table is rebuilt. signals.company_id
-- references companies(id) by name, so the new table is built under a second name and
-- renamed afterwards: renaming the OLD table first would rewrite that reference to
-- point at the table we are about to throw away.

PRAGMA defer_foreign_keys = true;

CREATE TABLE companies_new (
  id            TEXT PRIMARY KEY,     -- slug: verve-aerospace
  name          TEXT NOT NULL,
  description   TEXT,
  website       TEXT,
  city          TEXT,
  state         TEXT,
  cin           TEXT,                 -- MCA number, best join key
  founded_year  INTEGER,
  origin_year   INTEGER,              -- earliest year any source attributes: incubated or founded

  sector_id     TEXT,                 -- "2"
  subsector_id  TEXT,                 -- "2.7"
  project_type  TEXT,                 -- matched project string, nullable
  classify_note TEXT,                 -- why Claude chose it — audit trail

  -- When the company became visible to us. NULL means no source will say, and the
  -- page lists those separately rather than guessing.
  first_seen       TEXT,
  -- 'discovered' — it appeared in a run after this source was already established, so
  -- the date is ours and it is real. 'cohort' — taken from a published incubation
  -- year during a backfill. Only 'discovered' can reach Tier A.
  first_seen_basis TEXT,
  -- The day this row entered the database. Always set, never a claim about the
  -- company, and the only honest answer to "how long have we had this?"
  discovered       TEXT NOT NULL,

  trace_count   INTEGER DEFAULT 0,
  tier          TEXT DEFAULT 'C',
  updated_at    TEXT NOT NULL
);

-- Rows written before the split were all stamped with the ingest date on insert, so
-- that is both their first_seen and their discovered, and the basis was a discovery
-- by the old rules.
INSERT INTO companies_new (
  id, name, description, website, city, state, cin, founded_year, origin_year,
  sector_id, subsector_id, project_type, classify_note,
  first_seen, first_seen_basis, discovered, trace_count, tier, updated_at
)
SELECT
  id, name, description, website, city, state, cin, founded_year, NULL,
  sector_id, subsector_id, project_type, classify_note,
  first_seen, 'discovered', first_seen, trace_count, tier, updated_at
FROM companies;

DROP TABLE companies;
ALTER TABLE companies_new RENAME TO companies;

CREATE INDEX idx_companies_tier ON companies(tier, first_seen DESC);
CREATE INDEX idx_companies_sub  ON companies(subsector_id);
