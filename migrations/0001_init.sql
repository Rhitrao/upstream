CREATE TABLE companies (
  id            TEXT PRIMARY KEY,     -- slug: verve-aerospace
  name          TEXT NOT NULL,
  description   TEXT,
  website       TEXT,
  city          TEXT,
  state         TEXT,
  cin           TEXT,                 -- MCA number, best join key
  founded_year  INTEGER,

  sector_id     TEXT,                 -- "2"
  subsector_id  TEXT,                 -- "2.7"
  project_type  TEXT,                 -- matched project string, nullable
  classify_note TEXT,                 -- why Claude chose it — audit trail

  first_seen    TEXT NOT NULL,        -- ISO date. NEVER overwrite this.
  trace_count   INTEGER DEFAULT 0,
  tier          TEXT DEFAULT 'C',
  updated_at    TEXT NOT NULL
);

CREATE TABLE signals (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id   TEXT NOT NULL REFERENCES companies(id),
  type         TEXT NOT NULL,   -- incubator|grant|patent|incorporation|website|press
  label        TEXT NOT NULL,   -- "SINE IIT Bombay cohort 2026"
  date         TEXT,
  url          TEXT,
  source       TEXT NOT NULL,
  found_at     TEXT NOT NULL,
  UNIQUE(company_id, type, label)    -- stops duplicate signals on re-runs
);

CREATE TABLE runs (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at     TEXT NOT NULL,
  source         TEXT NOT NULL,
  status         TEXT NOT NULL,   -- ok | failed
  records_found  INTEGER DEFAULT 0,
  error          TEXT
);

CREATE INDEX idx_companies_tier ON companies(tier, first_seen DESC);
CREATE INDEX idx_companies_sub  ON companies(subsector_id);
CREATE INDEX idx_signals_company ON signals(company_id);
