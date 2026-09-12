-- "no website yet" is a claim that we looked.
--
-- For a portfolio page or a grant compendium that is true: those sources publish
-- a website field and an empty one is a fact about the company. A recognition
-- register publishes no website at all, so an empty one is a fact about the
-- register, and showing the same yellow marker for both would make the page's
-- loudest signal its least reliable one.
--
-- Defaults to 1 because every source that existed before this column does
-- publish websites, and their empty ones were checked.

ALTER TABLE companies ADD COLUMN website_checked INTEGER NOT NULL DEFAULT 1;
