-- page_store: rendered pages and aggregates, gzipped in parts, keyed by url and data version, shared
-- by every server and region behind the machine-local Cache API (src/edgecache.ts). Emptied whenever
-- the data version moves. The Worker also creates it on first use, so this migration only records it.
CREATE TABLE IF NOT EXISTS page_store (
  key TEXT NOT NULL, part INTEGER NOT NULL, meta TEXT, body BLOB NOT NULL, PRIMARY KEY (key, part)
);
