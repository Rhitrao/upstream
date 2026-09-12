-- Companies the classifier could place in a sector but not in any of its
-- sub-sectors, kept with the name of the hole they fell through.
--
-- Deliberately not in `companies`: they carry no sub-sector, so they would sit
-- in the coverage map's totals without ever appearing in a cell, and every
-- count on the page would quietly stop adding up. They are a different fact —
-- not "a company we are tracking" but "a company the taxonomy has no room for"
-- — and the page states them as one.
--
-- No foreign key to companies for the same reason: the whole point is that
-- these rows are not there.

CREATE TABLE gaps (
  company_id   TEXT PRIMARY KEY,   -- slug, same derivation as companies.id
  name         TEXT NOT NULL,
  description  TEXT,
  sector_id    TEXT,               -- the sector that did fit, when one did
  missing      TEXT NOT NULL,      -- the hole, in two to four words: "water infrastructure"
  note         TEXT NOT NULL,      -- the classifier's full reason — the audit trail
  source       TEXT NOT NULL,
  found_at     TEXT NOT NULL
);

CREATE INDEX idx_gaps_missing ON gaps(missing);
