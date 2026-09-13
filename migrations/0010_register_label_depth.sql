-- A register label supports a sub-sector, never a project type.
--
-- 330 DPIIT rows were placed from "Industry: Robotics. Stage: Validation." and every
-- one of them was also given a project type ("Modular robotic platforms" for
-- Probird), because the prompt asks for one and a model given a slot fills it.
-- Nothing published about those companies says what kind of product they make. The
-- sub-sector stays; the project type goes, and the ingest endpoint now refuses one
-- for a register-label row.
UPDATE companies SET project_type = NULL WHERE classify_basis = 'register-label';
