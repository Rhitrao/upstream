-- One row per source per pipeline run, including the runs that never uploaded.
--
-- `runs` is written by the ingest endpoint, one row per upload batch, so a source
-- whose scraper threw — or returned nothing — left no trace there at all, and a DPIIT
-- batch carrying only signals was logged as "ok, 0 records". A scraper returning
-- nothing looked exactly like a quiet day.
--
-- status          ok | quarantined | failed
--                   quarantined: it returned, but zero records or under half its last
--                   good count, so nothing from it was uploaded and yesterday's data
--                   stands
--                   failed: the scraper raised (a 403, a timeout, a changed page)
-- records         what the scraper returned this run
-- previous        records at the last ok run, which the drop was judged against
-- data_as_of      when the oldest page this run used was actually fetched; a page
--                 served from the fetch cache is as old as the cache entry
-- reason          a sentence, for the page and the Actions log

CREATE TABLE source_runs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at  TEXT NOT NULL,
  source      TEXT NOT NULL,
  status      TEXT NOT NULL,
  records     INTEGER NOT NULL DEFAULT 0,
  previous    INTEGER,
  data_as_of  TEXT,
  reason      TEXT
);

CREATE INDEX idx_source_runs ON source_runs(source, started_at DESC);
