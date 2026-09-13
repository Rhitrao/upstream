-- Private notes. One per company, for the person who runs this list and nobody else.
--
-- Deliberately a separate table rather than a column on `companies`: every other
-- column there is public and comes from a source, and the ingest upserts that table
-- nightly. A private, hand-written field sitting in the middle of it is one careless
-- `SELECT c.*` away from being served to the world — which is exactly how it would
-- happen, because that is the query the public list already runs.
--
-- No foreign key, for the same reason `gaps` has none: a note about a company that
-- later drops out of the list is still a note worth keeping.

CREATE TABLE notes (
  company_id TEXT PRIMARY KEY,
  body       TEXT NOT NULL,
  -- Who wrote it, from the verified Access token rather than from anything the
  -- request claimed. One person today; recorded so that stays checkable.
  author     TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_notes_updated ON notes(updated_at DESC);
