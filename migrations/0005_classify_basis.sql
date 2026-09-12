-- What a classification was made from.
--
-- 'description' — a source published prose about what the company does, and the
-- sub-sector was chosen from that.
--
-- 'register-label' — the only thing available was an industry label the founder
-- picked from a register's fixed list. Those placements track the vocabulary
-- rather than the company: where DPIIT's industry names have a near-twin in the
-- RDI scheme almost everything places, and where they do not almost nothing
-- does. The page marks these so the difference is visible in the row rather than
-- buried in a methodology note.

ALTER TABLE companies ADD COLUMN classify_basis TEXT NOT NULL DEFAULT 'description';
