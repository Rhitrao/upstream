-- A year a source prints beside a company without saying what it is.
--
-- Venture Center writes "Call X Ringers Pvt Ltd (2026)" and never says whether 2026 is
-- when the company was founded, incubated or admitted. Read as origin_year it would
-- drive the age gate; read as record_year it would date the row and could rank it.
-- It is neither, so it gets its own column and a type that says how much is known.
--
-- source_year      the year as printed
-- source_year_type 'unknown' — the only value today; a second one is a claim about
--                  what a source's year means and has to be added on purpose

ALTER TABLE companies ADD COLUMN source_year INTEGER;
ALTER TABLE companies ADD COLUMN source_year_type TEXT;
