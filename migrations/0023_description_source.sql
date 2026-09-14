-- Which source the stored description came from. Merged in ingest/run.py: a real
-- description beats a register label whichever source uploads last, and the row says whose
-- words it is. NULL for rows written before this; the next run fills it.
ALTER TABLE companies ADD COLUMN description_source TEXT;
