-- What kind of thing a record is — ingest/entity.py.
--
-- SINE IIT Bombay lists entrepreneurs-in-residence and NIDHI-PRAYAS innovators under
-- their own names. "Aishwarya Dasare" came in as a company, the classifier wrote "the
-- company extracts plant-based protein", and the headline counted her. Nothing on
-- record says a company exists.
--
-- entity_type — company | researcher-project | lab | unverified
-- entity_note — the reason, for the company's page
--
-- Backfilled with the same rules the pipeline now applies, measured over all 699 rows
-- on 2026-09-13: 680 carry a legal suffix or a DPIIT recognition (DPIIT recognises only
-- registered entities), 14 are a person's name for a funded project, and 5 are project
-- or brand names with no entity on record. The next run restates all of them.

ALTER TABLE companies ADD COLUMN entity_type TEXT;
ALTER TABLE companies ADD COLUMN entity_note TEXT;

UPDATE companies
SET entity_type = 'researcher-project',
    entity_note = 'listed under a person''s name for a funded project; no company is on record'
WHERE id IN ('aishwarya-dasare', 'aniket-kenge', 'ankur-agarwal', 'deepak-ghavari', 'hariharan-sekar',
             'imran-hussain', 'lisha-awasthi', 'mohit-velaskar', 'nagesh-nayak', 'nidhi-pandey',
             'priyanka-yasaslapu', 'rounak-timble', 'shivram-badhe', 'supernit-shinde');

UPDATE companies
SET entity_type = 'unverified',
    entity_note = 'a project or brand name, with no registered entity on record'
WHERE id IN ('biotherm', 'gaze', 'macvisys', 'nirvaan', 'plasmo-sense');

UPDATE companies SET entity_type = 'company' WHERE entity_type IS NULL;
