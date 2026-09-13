-- Tier A now also requires that no source dates anything about the company earlier
-- than 90 days ago (src/rank.ts tierFor).
--
-- All 15 Tier A rows on 2026-09-13 were DPIIT companies first seen that day by a live
-- run. Seven carry recognition dates from 2021 to August 2025: Probird's is 25 August
-- 2023. Being new to this list is not being new, and Tier A is the claim that it is.
--
-- Ranking is recomputed only for companies a run touches, so the rule is applied to
-- the stored rows here, in the same terms: B if it still meets B, otherwise C.
UPDATE companies
SET tier = CASE
      WHEN first_seen >= date('now', '-180 days') AND trace_count <= 5 THEN 'B'
      ELSE 'C'
    END
WHERE tier = 'A'
  AND (
    EXISTS (
      SELECT 1 FROM signals s
      WHERE s.company_id = companies.id
        AND s.date IS NOT NULL
        AND substr(s.date, 1, 10) < date('now', '-90 days')
    )
    OR (origin_year IS NOT NULL AND (origin_year || '-12-31') < date('now', '-90 days'))
  );
