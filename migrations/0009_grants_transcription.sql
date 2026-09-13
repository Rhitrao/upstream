-- Three rows of ingest/sources/grants.csv were typed from the wrong part of their
-- page in DST's "75 Promising Startups under NIDHI-PRAYAS". Each profile page has a
-- customer box, and its "Company Ltd., Place" lines were taken for the startup's
-- name and city:
--
--   "Logistics Limited", Statue           is Elon Motors Engineering Pvt. Ltd., Ahmedabad (p. 32)
--   "Solutions Pvt. Ltd."                 is Tishyas Medical Device Development Solutions Pvt. Ltd. (p. 44)
--   "South Asia Pvt. Ltd.", "Shell, Tricon Buildwell"
--                                         is GreenJams BuildTech Pvt. Ltd., Visakhapatnam (p. 33)
--
-- The CSV is corrected. Every other row of it was checked against its source document
-- on 2026-09-13: 174 of 177 matched. A company's id is its name, so the corrected rows
-- arrive as new companies on the next run and the misnamed ones would stay beside them.
-- They go here, signals first for the foreign key.

DELETE FROM signals   WHERE company_id IN ('logistics', 'solutions', 'south-asia');
DELETE FROM companies WHERE id         IN ('logistics', 'solutions', 'south-asia');
DELETE FROM gaps      WHERE company_id IN ('logistics', 'solutions', 'south-asia');
